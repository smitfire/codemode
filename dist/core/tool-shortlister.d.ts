export interface ToolDescriptor {
    name: string;
    description: string;
    keywords?: string[];
    core?: boolean;
}
export interface ShortlistResult {
    active: string[];
    deferred: string[];
}
/** CUGA-inspired dynamic tool shortlisting to shrink Code-Mode SDK prompt bloat. */
export declare class ToolShortlister {
    private readonly threshold;
    private readonly maxActive;
    private readonly discovered;
    constructor(opts?: {
        threshold?: number;
        maxActive?: number;
    });
    markDiscovered(names: readonly string[]): void;
    shortlist(catalog: readonly ToolDescriptor[], activePrompt: string): ShortlistResult;
    discover(catalog: readonly ToolDescriptor[], query: string, limit?: number): ToolDescriptor[];
}
//# sourceMappingURL=tool-shortlister.d.ts.map