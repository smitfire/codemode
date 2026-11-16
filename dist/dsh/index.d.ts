import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { ContextSandbox, ToolShortlister, VariableRegistry } from '../core/index.js';
export declare const name = "ns-codemode";
export declare const inject: readonly ["tools", "systemPrompt"];
export interface PluginConfig {
    maxInlineChars: number;
    shortlistingThreshold: number;
    maxActiveTools: number;
    dbPath: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    maxInlineChars: z<number, number, "defined">;
    shortlistingThreshold: z<number, number, "defined">;
    maxActiveTools: z<number, number, "defined">;
    dbPath: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxInlineChars: z<number, number, "defined">;
    shortlistingThreshold: z<number, number, "defined">;
    maxActiveTools: z<number, number, "defined">;
    dbPath: z<string, string, "defined">;
}>>, "plain">;
export interface NsCodemodeService {
    readonly sandbox: ContextSandbox;
    readonly vars: VariableRegistry;
    readonly shortlister: ToolShortlister;
    metrics(): {
        rawToolBytes: number;
        admittedBytes: number;
        interceptedCount: number;
    };
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsCodemode?: NsCodemodeService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=index.d.ts.map