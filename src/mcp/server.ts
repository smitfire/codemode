#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { ContextSandbox, ToolShortlister, VariableRegistry } from '../core/index.js';

function safeWorkspacePath(workspaceRoot: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) throw new Error(`path must be workspace-relative: ${relPath}`);
  let realRoot: string;
  let target: string;
  try {
    realRoot = realpathSync(resolve(workspaceRoot));
    target = realpathSync(resolve(realRoot, relPath));
  } catch {
    throw new Error(`cannot resolve workspace-relative path: ${relPath}`);
  }
  const rel = relative(realRoot, target);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`path escapes workspace (symlink or traversal blocked): ${relPath}`);
  }
  if (!statSync(target).isFile()) {
    throw new Error(`path is not a regular file: ${relPath}`);
  }
  return target;
}

const WORKER_RUNNER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const pending = new Map();
let seq = 0;
parentPort.on('message', (msg) => {
  if (msg.type === 'res') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.value);
  }
});
function callHost(name, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, name, args });
  });
}
const tools = Object.freeze({
  read_file: (p, s, e) => callHost('read_file', [p, s, e]),
  ctx_index: (l, c) => callHost('ctx_index', [l, c]),
  ctx_search: (q, a, n) => callHost('ctx_search', [q, a, n]),
  ctx_slice: (a, s, e) => callHost('ctx_slice', [a, s, e]),
  vars_set: (k, v) => callHost('vars_set', [k, v]),
  vars_get: (k) => callHost('vars_get', [k]),
  vars_list: () => callHost('vars_list', []),
});
const logs = [];
const ctx = vm.createContext(
  {
    tools,
    console: Object.freeze({
      log: (...xs) => { if (logs.length < 100) logs.push(xs.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
    }),
  },
  { codeGeneration: { strings: false, wasm: false } },
);
(async () => {
  try {
    const script = new vm.Script('(async () => {\\n' + workerData.code + '\\n})()', { filename: 'codemode-sandbox.mjs' });
    const raw = await script.runInContext(ctx);
    let val = null;
    if (raw !== undefined) {
      const serialized = JSON.stringify(raw);
      if (serialized === undefined) throw new Error('return value is not JSON-serializable');
      val = JSON.parse(serialized);
    }
    parentPort.postMessage({ type: 'done', ok: true, value: val, logs });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, logs, error: err && err.message ? err.message : String(err) });
  }
})();
`;

/** Worker-isolated runner enforcing hard wall-clock termination even on infinite async await loops. */
export async function runConfinedCode(
  code: string,
  deps: {
    workspaceRoot: string;
    sandbox: ContextSandbox;
    vars: VariableRegistry;
    shortlister: ToolShortlister;
    timeoutMs?: number;
  },
): Promise<{ ok: boolean; value?: unknown; logs: string[]; error?: string }> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const hostFns: Record<string, (...args: unknown[]) => unknown> = {
    read_file: (relPath, startLine = 1, endLine = 200) => {
      const full = safeWorkspacePath(deps.workspaceRoot, String(relPath ?? ''));
      const lines = readFileSync(full, 'utf8').split('\n');
      const s = typeof startLine === 'number' ? startLine : 1;
      const e = typeof endLine === 'number' ? endLine : 200;
      return lines.slice(Math.max(0, s - 1), Math.max(s, e)).join('\n');
    },
    ctx_index: (label, content) => deps.sandbox.indexOutput(String(label ?? ''), String(content ?? '')),
    ctx_search: (query, artifactId, limit) =>
      deps.sandbox.search(String(query ?? ''), {
        artifactId: typeof artifactId === 'string' ? artifactId : undefined,
        limit: typeof limit === 'number' ? limit : undefined,
      }),
    ctx_slice: (artifactId, startLine, endLine) =>
      deps.sandbox.slice(
        String(artifactId ?? ''),
        typeof startLine === 'number' ? startLine : 1,
        typeof endLine === 'number' ? endLine : 80,
      ),
    vars_set: (name, value) => deps.vars.set(String(name ?? ''), value),
    vars_get: (name) => deps.vars.get(String(name ?? '')),
    vars_list: () => deps.vars.list(),
  };

  return new Promise((resolveRun) => {
    const worker = new Worker(WORKER_RUNNER_CODE, { eval: true, workerData: { code } });
    let settled = false;
    const finish = (res: { ok: boolean; value?: unknown; logs: string[]; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolveRun(res);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, logs: [], error: `codemode worker exceeded ${timeoutMs}ms timeout` });
    }, timeoutMs);

    worker.on('message', (msg: { type: string; id?: number; name?: string; args?: unknown[]; ok?: boolean; value?: unknown; logs?: string[]; error?: string }) => {
      if (msg.type === 'call' && msg.id !== undefined) {
        try {
          const fn = hostFns[String(msg.name ?? '')];
          if (!fn) throw new Error(`unknown sandbox tool: ${msg.name}`);
          const value = fn(...(msg.args ?? []));
          worker.postMessage({ type: 'res', id: msg.id, value });
        } catch (err) {
          worker.postMessage({ type: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) });
        }
      } else if (msg.type === 'done') {
        finish({ ok: Boolean(msg.ok), value: msg.value, logs: msg.logs ?? [], error: msg.error });
      }
    });
    worker.on('error', (err) => finish({ ok: false, logs: [], error: err.message }));
    worker.on('exit', (codeExit) => {
      if (!settled) finish({ ok: false, logs: [], error: `worker exited with code ${codeExit}` });
    });
  });
}

const MCP_TOOLS = [
  {
    name: 'run_code',
    description: 'Execute JavaScript in a worker-isolated sandbox with await tools.{read_file,ctx_index,ctx_search,ctx_slice,vars_set,vars_get,vars_list}.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'ctx_search',
    description: 'Search indexed FTS5 outputs and logs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, artifactId: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'ctx_slice',
    description: 'Slice bounded lines from an indexed artifact.',
    inputSchema: {
      type: 'object',
      properties: { artifactId: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } },
      required: ['artifactId'],
    },
  },
  { name: 'vars_list', description: 'List persisted sandbox variables.', inputSchema: { type: 'object', properties: {} } },
];

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function startMcpServer(workspaceRoot = process.cwd()): Promise<void> {
  const sandbox = new ContextSandbox(':memory:');
  const vars = new VariableRegistry();
  const shortlister = new ToolShortlister();
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined || req.method === undefined) continue;
    try {
      if (req.method === 'initialize') {
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ns-codemode', version: '0.1.0' } },
        });
      } else if (req.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: req.id, result: { tools: MCP_TOOLS } });
      } else if (req.method === 'tools/call') {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
        let result: unknown;
        if (name === 'run_code') {
          if (typeof args.code !== 'string') throw new RpcError(-32602, 'code must be a string');
          result = await runConfinedCode(args.code, { workspaceRoot, sandbox, vars, shortlister });
        } else if (name === 'ctx_search') {
          if (typeof args.query !== 'string' || !args.query.trim()) throw new RpcError(-32602, 'query must be a non-empty string');
          result = { matches: sandbox.search(args.query, { artifactId: typeof args.artifactId === 'string' ? args.artifactId : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }) };
        } else if (name === 'ctx_slice') {
          if (typeof args.artifactId !== 'string' || !args.artifactId.trim()) throw new RpcError(-32602, 'artifactId must be a non-empty string');
          result = sandbox.slice(args.artifactId, typeof args.startLine === 'number' ? args.startLine : 1, typeof args.endLine === 'number' ? args.endLine : 80);
        } else if (name === 'vars_list') {
          result = { variables: vars.list() };
        } else {
          throw new RpcError(-32601, `unknown tool: ${name}`);
        }
        write({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } else {
        throw new RpcError(-32601, `method not found: ${req.method}`);
      }
    } catch (error) {
      write({ jsonrpc: '2.0', id: req.id, error: { code: error instanceof RpcError ? error.code : -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }
  sandbox.close();
}

const isEntrypoint = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  await startMcpServer(process.argv[2] ?? process.cwd());
}
