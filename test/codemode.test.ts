import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ContextSandbox, ToolShortlister, VariableRegistry } from '../dist/core/index.js';
import * as codemodePlugin from '../dist/dsh/index.js';
import { runConfinedCode } from '../dist/mcp/server.js';

test('ContextSandbox FTS5 keeps >95% of heavy log payload out of context while supporting exact search & slice', () => {
  const sb = new ContextSandbox(':memory:');
  try {
    const lines = Array.from({ length: 400 }, (_, i) =>
      i === 247 ? 'ERROR auth_token_expired at src/auth.ts:88' : `INFO request id=${i} ok`,
    );
    const bigPayload = lines.join('\n');
    const receipt = sb.indexOutput('bash', bigPayload);
    assert.ok(receipt.totalBytes > 9000);
    assert.ok(JSON.stringify(receipt).length < 400);

    const hits = sb.search('auth_token_expired', { artifactId: receipt.artifactId });
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /src\/auth\.ts:88/);

    const slice = sb.slice(receipt.artifactId, 245, 250);
    assert.equal(slice.found, true);
    assert.match(slice.text, /ERROR auth_token_expired/);
  } finally {
    sb.close();
  }
});

test('ToolShortlister trims catalog above threshold and VariableRegistry enforces size/JSON limits', () => {
  const vars = new VariableRegistry();
  const meta = vars.set('endpoints', [{ path: '/health', ok: true }]);
  assert.equal(meta.shape, 'Array<Object{path,ok}>[1]');
  assert.match(vars.summarize(), /<codemode-vars count="1">/);
  assert.throws(() => vars.set('bad-key!', 1), /invalid variable name/);

  const shortlister = new ToolShortlister({ threshold: 4, maxActive: 5 });
  const catalog = Array.from({ length: 12 }, (_, i) => ({
    name: i === 9 ? 'git_diff_inspect' : `tool_${i}`,
    description: i === 9 ? 'Inspect git diff commits' : 'Misc utility',
    core: i < 2,
  }));
  const sl = shortlister.shortlist(catalog, 'please inspect git diff commits');
  assert.ok(sl.active.includes('tool_0'));
  assert.ok(sl.active.includes('git_diff_inspect'));
  assert.ok(sl.deferred.length >= 6);
});

test('DSH tools/post-execute intercepts large outputs and confined node:vm executes sandboxed scripts', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  const fiber = ctx.plugin(codemodePlugin, {
    maxInlineChars: 512,
    shortlistingThreshold: 10,
    maxActiveTools: 12,
  });
  await fiber;

  const big = Array.from({ length: 120 }, (_, i) => `line_${i}: data=${'x'.repeat(30)}`).join('\n');
  const decision = await ctx.waterfall(
    'tools/post-execute',
    { name: 'bash', arguments: { command: 'cat log' } } as never,
    { content: [{ type: 'text', text: big }], isError: false } as never,
    async () => ({ kind: 'accept', content: [{ type: 'text', text: big }] }),
  );
  assert.equal(decision.kind, 'accept');
  const returned = (decision.content?.[0] as { text: string }).text;
  assert.ok(returned.length < 400);
  const parsed = JSON.parse(returned);
  assert.match(parsed.artifactId, /^art_/);

  const dir = mkdtempSync(join(tmpdir(), 'ns-cm-vm-'));
  const vmSandbox = new ContextSandbox(':memory:');
  const vmVars = new VariableRegistry();
  const vmShortlister = new ToolShortlister();
  try {
    writeFileSync(join(dir, 'notes.txt'), 'alpha\nbeta needle\ngamma\n');
    const vmRes = await runConfinedCode(
      `const text = await tools.read_file('notes.txt', 1, 10);
       const rec = await tools.ctx_index('notes', text);
       const hits = await tools.ctx_search('needle', rec.artifactId);
       await tools.vars_set('found', hits.length);
       return hits[0].snippet;`,
      { workspaceRoot: dir, sandbox: vmSandbox, vars: vmVars, shortlister: vmShortlister },
    );
    assert.equal(vmRes.ok, true);
    assert.equal(vmRes.value, 'beta needle');
    assert.equal(vmVars.get('found').value, 1);

    // Verify hard wall-clock termination on infinite async await loops
    const hung = await runConfinedCode(
      `while (true) { await Promise.resolve(); }`,
      { workspaceRoot: dir, sandbox: vmSandbox, vars: vmVars, shortlister: vmShortlister, timeoutMs: 250 },
    );
    assert.equal(hung.ok, false);
    assert.match(hung.error ?? '', /timeout/);
  } finally {
    vmSandbox.close();
    rmSync(dir, { recursive: true, force: true });
    await fiber.dispose();
  }
});
