import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import {
  ContextSandbox,
  ToolShortlister,
  VariableRegistry,
  type ToolDescriptor,
} from '../core/index.js';

export const name = 'ns-codemode';
export const inject = ['tools', 'systemPrompt'] as const;

export interface PluginConfig {
  maxInlineChars: number;
  shortlistingThreshold: number;
  maxActiveTools: number;
  dbPath: string;
}

export const Config = z.object({
  maxInlineChars: z.number().default(8192),
  shortlistingThreshold: z.number().default(10),
  maxActiveTools: z.number().default(12),
  dbPath: z.string().default(':memory:'),
});

export interface NsCodemodeService {
  readonly sandbox: ContextSandbox;
  readonly vars: VariableRegistry;
  readonly shortlister: ToolShortlister;
  metrics(): { rawToolBytes: number; admittedBytes: number; interceptedCount: number };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nsCodemode?: NsCodemodeService;
  }
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

const SKIP_INTERCEPT = new Set([
  'ctx_index',
  'ctx_search',
  'ctx_slice',
  'vars_set',
  'vars_get',
  'vars_list',
  'tools_discover',
  'forewisp_expand',
]);

export function apply(ctx: Context, rawConfig: Partial<PluginConfig> = {}): void {
  const maxInlineChars = rawConfig.maxInlineChars ?? 8192;
  const sandbox = new ContextSandbox(rawConfig.dbPath ?? ':memory:');
  const varsBySession = new Map<string, VariableRegistry>();
  const globalVars = new VariableRegistry();
  const shortlister = new ToolShortlister({
    threshold: rawConfig.shortlistingThreshold ?? 10,
    maxActive: rawConfig.maxActiveTools ?? 12,
  });

  const metricsState = { rawToolBytes: 0, admittedBytes: 0, interceptedCount: 0 };

  const varsFor = (sessionId?: string): VariableRegistry => {
    if (!sessionId) return globalVars;
    let reg = varsBySession.get(sessionId);
    if (!reg) {
      reg = new VariableRegistry();
      varsBySession.set(sessionId, reg);
    }
    return reg;
  };

  ctx.provide('nsCodemode', {
    sandbox,
    vars: globalVars,
    shortlister,
    metrics: () => ({ ...metricsState }),
  });

  ctx.systemPrompt.context({
    name: 'ns-codemode:vars',
    order: 185,
    interpolate: false,
    text: (assembleCtx) => {
      const sid = assembleCtx.agent ? String(assembleCtx.agent.session.id) : undefined;
      return varsFor(sid).summarize();
    },
  });

  // Intercept oversized non-error tool outputs (>maxInlineChars) into SQLite FTS5 ContextSandbox, preserving non-text blocks.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (SKIP_INTERCEPT.has(exec.name) || decision.kind === 'block') return decision;
    const rawBlocks = decision.content ?? result?.content;
    const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
    const textBlocks = blocks.filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string');
    const nonTextBlocks = blocks.filter((b) => b?.type !== 'text');
    const text = textBlocks.map((b) => b.text).join('\n');
    const rawBytes = Buffer.byteLength(text, 'utf8');
    metricsState.rawToolBytes += rawBytes;

    if (text.length <= maxInlineChars || result?.isError === true) {
      metricsState.admittedBytes += rawBytes;
      return decision;
    }

    const receipt = sandbox.indexOutput(exec.name, text);
    const compact = JSON.stringify(receipt);
    metricsState.admittedBytes += Buffer.byteLength(compact, 'utf8');
    metricsState.interceptedCount += 1;

    return {
      kind: 'accept' as const,
      content: [{ type: 'text' as const, text: compact }, ...nonTextBlocks],
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    };
  });

  ctx.on('agent/disposed', ({ agent }) => {
    varsBySession.delete(String(agent.session.id));
  });

  const schemaObj = { type: 'object' as const, properties: {}, additionalProperties: true };

  ctx.tools.register(
    defineTool({
      name: 'ctx_index',
      description: 'Index large text/log content into FTS5 ContextSandbox and return a compact artifact handle.',
      parameters: {
        label: { type: 'string', required: true, description: 'Short label for the artifact.' },
        content: { type: 'string', required: true, description: 'Raw text or log payload to index.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args) => sandbox.indexOutput(args.label, args.content) as never,
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ctx_search',
      description: 'Search indexed FTS5 tool outputs and logs without pulling full payloads into context.',
      parameters: {
        query: { type: 'string', required: true, description: 'BM25 search terms.' },
        artifactId: { type: 'string', description: 'Optional artifactId filter.' },
        limit: { type: 'integer', description: 'Max snippets (default 6, max 20).' },
      },
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => ({
        matches: sandbox.search(args.query, { artifactId: args.artifactId, limit: args.limit }),
      }) as never,
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ctx_slice',
      description: 'Read a bounded line range (<=4KB) from an indexed ContextSandbox artifact.',
      parameters: {
        artifactId: { type: 'string', required: true, description: 'Artifact ID from ctx_index or truncated output.' },
        startLine: { type: 'integer', description: '1-based start line (default 1).' },
        endLine: { type: 'integer', description: '1-based end line (default 80).' },
      },
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) =>
        sandbox.slice(args.artifactId, args.startLine ?? 1, args.endLine ?? 80) as never,
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'vars_set',
      description: 'Persist a structured JSON value across Code Mode turns (injects only a 1-line schema summary).',
      parameters: {
        name: { type: 'string', required: true, description: 'Variable identifier.' },
        value: { type: 'json', required: true, description: 'JSON-serializable value.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args, exec) => {
        const reg = varsFor(exec.agent ? String(exec.agent.session.id) : undefined);
        return reg.set(args.name, args.value) as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'vars_get',
      description: 'Retrieve a previously persisted sandbox variable.',
      parameters: {
        name: { type: 'string', required: true, description: 'Variable identifier.' },
      },
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const reg = varsFor(exec.agent ? String(exec.agent.session.id) : undefined);
        return reg.get(args.name) as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'vars_list',
      description: 'List active sandbox variable names, shapes, and byte sizes.',
      parameters: {},
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => {
        const reg = varsFor(exec.agent ? String(exec.agent.session.id) : undefined);
        return { variables: reg.list() } as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'tools_discover',
      description: 'CUGA dynamic tool shortlister: search full registered tool catalog and reveal matching schemas.',
      parameters: {
        query: { type: 'string', required: true, description: 'Capability or keyword to discover.' },
        limit: { type: 'integer', description: 'Max tools to return (default 6).' },
      },
      output: { schema: schemaObj, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const defs = ctx.tools.definitions(exec.agent);
        const catalog: ToolDescriptor[] = defs.map((d) => ({
          name: d.name,
          description: d.description ?? '',
        }));
        const matches = shortlister.discover(catalog, args.query, args.limit ?? 6);
        return { matches } as never;
      },
    }),
  );

  ctx.effect(() => () => {
    sandbox.close();
  });
}
