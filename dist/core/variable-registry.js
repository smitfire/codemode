const MAX_VAR_BYTES = 2 * 1024 * 1024;
const MAX_KEYS = 32;
function describeShape(val) {
    if (val === null)
        return 'null';
    if (Array.isArray(val)) {
        const first = val.length > 0 ? describeShape(val[0]) : 'empty';
        return `Array<${first}>[${val.length}]`;
    }
    if (typeof val === 'object') {
        const keys = Object.keys(val);
        const sample = keys.slice(0, 4).join(',');
        return `Object{${sample}${keys.length > 4 ? ',...' : ''}}`;
    }
    if (typeof val === 'string')
        return `string(${val.length})`;
    return typeof val;
}
/** CUGA-inspired sandbox variable persistence across Code Mode steps/turns. */
export class VariableRegistry {
    store = new Map();
    set(name, value) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
            throw new Error(`invalid variable name "${name}"`);
        }
        if (!this.store.has(name) && this.store.size >= MAX_KEYS) {
            throw new Error(`variable limit (${MAX_KEYS}) reached; overwrite or clear an existing key`);
        }
        const serialized = JSON.stringify(value);
        if (serialized === undefined)
            throw new Error(`variable "${name}" must be JSON-serializable`);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (bytes > MAX_VAR_BYTES) {
            throw new Error(`variable "${name}" exceeds ${MAX_VAR_BYTES}B limit (${bytes}B)`);
        }
        const cloned = JSON.parse(serialized);
        const meta = { name, shape: describeShape(cloned), bytes, updatedAt: Date.now() };
        this.store.set(name, { value: cloned, meta });
        return meta;
    }
    get(name) {
        const entry = this.store.get(name);
        if (!entry)
            return { found: false };
        return { found: true, value: JSON.parse(JSON.stringify(entry.value)), meta: entry.meta };
    }
    list() {
        return [...this.store.values()].map((e) => e.meta);
    }
    delete(name) {
        return this.store.delete(name);
    }
    summarize() {
        if (this.store.size === 0)
            return '';
        const entries = this.list().map((m) => `${m.name}: ${m.shape} (${m.bytes}B)`);
        return `<codemode-vars count="${entries.length}">${entries.join(' | ')}</codemode-vars>`;
    }
}
//# sourceMappingURL=variable-registry.js.map