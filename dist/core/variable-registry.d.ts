export interface VariableMeta {
    name: string;
    shape: string;
    bytes: number;
    updatedAt: number;
}
/** CUGA-inspired sandbox variable persistence across Code Mode steps/turns. */
export declare class VariableRegistry {
    private readonly store;
    set(name: string, value: unknown): VariableMeta;
    get(name: string): {
        found: boolean;
        value?: unknown;
        meta?: VariableMeta;
    };
    list(): VariableMeta[];
    delete(name: string): boolean;
    summarize(): string;
}
//# sourceMappingURL=variable-registry.d.ts.map