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
/** Clean-room MIT SQLite FTS5 store keeping heavy outputs out of LLM context windows. */
export declare class ContextSandbox {
    private readonly db;
    constructor(dbPath?: string);
    indexOutput(label: string, content: string): ArtifactReceipt;
    search(query: string, opts?: {
        artifactId?: string;
        limit?: number;
    }): ArtifactMatch[];
    slice(artifactId: string, startLine?: number, endLine?: number): {
        found: boolean;
        artifactId: string;
        startLine: number;
        endLine: number;
        totalLines: number;
        truncated: boolean;
        partial: boolean;
        text: string;
    };
    close(): void;
}
//# sourceMappingURL=context-sandbox.d.ts.map