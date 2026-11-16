#!/usr/bin/env node
import { ContextSandbox, ToolShortlister, VariableRegistry } from '../core/index.js';
/** Worker-isolated runner enforcing hard wall-clock termination even on infinite async await loops. */
export declare function runConfinedCode(code: string, deps: {
    workspaceRoot: string;
    sandbox: ContextSandbox;
    vars: VariableRegistry;
    shortlister: ToolShortlister;
    timeoutMs?: number;
}): Promise<{
    ok: boolean;
    value?: unknown;
    logs: string[];
    error?: string;
}>;
export declare function startMcpServer(workspaceRoot?: string): Promise<void>;
//# sourceMappingURL=server.d.ts.map