import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ArtifactReceipt {
  artifactId: string;
  label: string;
  totalBytes: number;
  totalLines: number;
  preview: string;
  hint: string;
}

export interface ArtifactMatch {
  artifactId: string;
  label: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

function summarizeStructure(content: string): string {
  const lines = content.split('\n');
  const highlights: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:#{1,3}\s+|(?:export\s+)?(?:function|class|interface|type)\s+|ERROR|WARN|FAIL)/i.test(trimmed)) {
      highlights.push(trimmed.slice(0, 72));
      if (highlights.length >= 2) break;
    }
  }
  if (highlights.length === 0 && lines[0]) highlights.push(lines[0].trim().slice(0, 80));
  return highlights.join(' | ').slice(0, 120);
}

/** Clean-room MIT SQLite FTS5 store keeping heavy outputs out of LLM context windows. */
export class ContextSandbox {
  private readonly db: DatabaseSync;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const resolved = resolve(dbPath);
      mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
      if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`refusing symlinked sandbox database: ${resolved}`);
      }
      this.db = new DatabaseSync(resolved);
      chmodSync(resolved, 0o600);
    } else {
      this.db = new DatabaseSync(':memory:');
    }
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        total_lines INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_chunks (
        chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        artifact_id UNINDEXED,
        body
      );
    `);
  }

  indexOutput(label: string, content: string): ArtifactReceipt {
    const digest = createHash('sha256').update(`${label}\n${content}`).digest('hex').slice(0, 12);
    const artifactId = `art_${digest}`;
    const totalBytes = Buffer.byteLength(content, 'utf8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    const existing = this.db.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifactId) as { id: string } | undefined;
    if (!existing) {
      const nowSec = Math.floor(Date.now() / 1000);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .prepare('INSERT INTO artifacts (id, label, total_bytes, total_lines, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(artifactId, label, totalBytes, totalLines, content, nowSec);

        const chunkSize = 40;
        const insertChunk = this.db.prepare(
          'INSERT INTO artifact_chunks (artifact_id, start_line, end_line, body) VALUES (?, ?, ?, ?)',
        );
        const insertFts = this.db.prepare(
          'INSERT INTO artifact_chunks_fts (chunk_id, artifact_id, body) VALUES (?, ?, ?)',
        );
        for (let i = 0; i < lines.length; i += chunkSize) {
          const body = lines.slice(i, i + chunkSize).join('\n');
          const info = insertChunk.run(artifactId, i + 1, Math.min(lines.length, i + chunkSize), body);
          insertFts.run(Number(info.lastInsertRowid), artifactId, body);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    const preview = summarizeStructure(content);
    return {
      artifactId,
      label,
      totalBytes,
      totalLines,
      preview,
      hint: `Indexed ${totalBytes}B (${totalLines}L). Use ctx_search(query, "${artifactId}") or ctx_slice("${artifactId}", 1, 80).`,
    };
  }

  search(query: string, opts?: { artifactId?: string; limit?: number }): ArtifactMatch[] {
    const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])].slice(0, 16);
    if (tokens.length === 0) return [];
    const fts = tokens.map((t) => `"${t}"`).join(' OR ');
    const limit = Math.min(20, Math.max(1, opts?.limit ?? 6));

    const sql = opts?.artifactId
      ? `SELECT c.artifact_id, a.label, c.start_line, c.end_line, c.body
         FROM artifact_chunks_fts f
         JOIN artifact_chunks c ON c.chunk_id = f.chunk_id
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE artifact_chunks_fts MATCH ? AND c.artifact_id = ?
         LIMIT ?`
      : `SELECT c.artifact_id, a.label, c.start_line, c.end_line, c.body
         FROM artifact_chunks_fts f
         JOIN artifact_chunks c ON c.chunk_id = f.chunk_id
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE artifact_chunks_fts MATCH ?
         LIMIT ?`;

    const rows = opts?.artifactId
      ? (this.db.prepare(sql).all(fts, opts.artifactId, limit) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all(fts, limit) as Array<Record<string, unknown>>);

    return rows.map((r) => {
      const bodyLines = String(r.body).split('\n');
      const matchedLine =
        bodyLines.find((l) => tokens.some((t) => l.toLowerCase().includes(t))) ?? bodyLines[0] ?? '';
      return {
        artifactId: String(r.artifact_id),
        label: String(r.label),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        snippet: matchedLine.slice(0, 300),
      };
    });
  }

  slice(artifactId: string, startLine = 1, endLine = 80): {
    found: boolean;
    artifactId: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    partial: boolean;
    text: string;
  } {
    const row = this.db
      .prepare('SELECT total_lines, content FROM artifacts WHERE id = ?')
      .get(artifactId) as { total_lines: number; content: string } | undefined;
    if (!row) {
      return { found: false, artifactId, startLine: 0, endLine: 0, totalLines: 0, truncated: false, partial: false, text: '' };
    }
    const lines = row.content.split('\n');
    const s = Math.max(1, startLine);
    const maxEnd = Math.min(lines.length, Math.max(s, Math.min(endLine, s + 200)));
    const emitted: string[] = [];
    let bytes = 0;
    let truncated = false;
    let partial = false;

    for (let idx = s - 1; idx < maxEnd; idx += 1) {
      const line = lines[idx];
      const lineBytes = Buffer.byteLength(line, 'utf8') + (emitted.length > 0 ? 1 : 0);
      if (bytes + lineBytes > 3960) {
        if (emitted.length === 0) {
          const buf = Buffer.from(line, 'utf8');
          let cut = Math.min(buf.length, 3920);
          while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
          emitted.push(buf.subarray(0, cut).toString('utf8'));
          partial = true;
        }
        truncated = true;
        break;
      }
      emitted.push(line);
      bytes += lineBytes;
    }

    const actualEnd = partial ? s - 1 : emitted.length === 0 ? s - 1 : s + emitted.length - 1;
    const text = truncated ? `${emitted.join('\n')}\n...[truncated]` : emitted.join('\n');
    return { found: true, artifactId, startLine: s, endLine: actualEnd, totalLines: row.total_lines, truncated, partial, text };
  }

  close(): void {
    this.db.close();
  }
}
