/** CUGA-inspired dynamic tool shortlisting to shrink Code-Mode SDK prompt bloat. */
export class ToolShortlister {
    threshold;
    maxActive;
    discovered = new Set();
    constructor(opts) {
        this.threshold = opts?.threshold ?? 10;
        this.maxActive = opts?.maxActive ?? 12;
    }
    markDiscovered(names) {
        for (const n of names)
            this.discovered.add(n);
    }
    shortlist(catalog, activePrompt) {
        if (catalog.length <= this.threshold) {
            return { active: catalog.map((t) => t.name), deferred: [] };
        }
        const promptTokens = new Set((activePrompt.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []));
        const active = new Set();
        const scored = [];
        for (const tool of catalog) {
            if (tool.core || this.discovered.has(tool.name)) {
                active.add(tool.name);
                continue;
            }
            const hay = `${tool.name} ${tool.description} ${(tool.keywords ?? []).join(' ')}`.toLowerCase();
            const hayTokens = new Set(hay.match(/[a-z0-9_]{2,}/g) ?? []);
            let score = 0;
            for (const tok of promptTokens)
                if (hayTokens.has(tok))
                    score += 1;
            scored.push({ name: tool.name, score });
        }
        scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        for (const item of scored) {
            if (active.size >= this.maxActive)
                break;
            if (item.score > 0)
                active.add(item.name);
        }
        const deferred = catalog.map((t) => t.name).filter((n) => !active.has(n));
        return { active: [...active], deferred };
    }
    discover(catalog, query, limit = 6) {
        const tokens = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
        if (tokens.length === 0)
            return catalog.slice(0, limit);
        const matches = catalog
            .map((tool) => {
            const hay = `${tool.name} ${tool.description} ${(tool.keywords ?? []).join(' ')}`.toLowerCase();
            const score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
            return { tool, score };
        })
            .filter((m) => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((m) => m.tool);
        this.markDiscovered(matches.map((m) => m.name));
        return matches;
    }
}
//# sourceMappingURL=tool-shortlister.js.map