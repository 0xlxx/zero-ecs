/** Filter: entity where component T changed since last observation. */
export function Changed(factory) {
    return { kind: "changed", factory };
}
/** Filter: entity where component T was added since last observation. */
export function Added(factory) {
    return { kind: "added", factory };
}
/** Filter: entity HAS component T (but don't fetch it). */
export function With(factory) {
    return { kind: "with", factory };
}
/** Filter: entity does NOT have component T. */
export function Without(factory) {
    return { kind: "without", factory };
}
/**
 * Persistent per-query change-detection cursors.
 *
 * A QueryState belongs to one logical query reader. Reuse the same state across
 * frames, but never share it between independent readers that need independent
 * Changed/Added observation. QueryState is caller-owned: retire destroyed
 * entities with forget() or call clear() when the reader is no longer needed.
 */
export class QueryState {
    constructor() {
        this.added = new Map();
        this.changed = new Map();
    }
    readAdded(entity, kind) {
        return this.added.get(entity)?.get(kind) ?? 0;
    }
    writeAdded(entity, kind, tick) {
        let kinds = this.added.get(entity);
        if (!kinds) {
            kinds = new Map();
            this.added.set(entity, kinds);
        }
        kinds.set(kind, tick);
    }
    readChanged(entity, kind) {
        return this.changed.get(entity)?.get(kind) ?? 0;
    }
    writeChanged(entity, kind, tick) {
        let kinds = this.changed.get(entity);
        if (!kinds) {
            kinds = new Map();
            this.changed.set(entity, kinds);
        }
        kinds.set(kind, tick);
    }
    forget(entity) {
        this.added.delete(entity);
        this.changed.delete(entity);
    }
    clear() {
        this.added.clear();
        this.changed.clear();
    }
}
//# sourceMappingURL=query.js.map