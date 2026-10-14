// packages/ecs/src/component.ts — Component factory system
// Gregory §17.2.2: property class IS the key. No string enums, no kind unions.
import { cloneValue, defaultsFromFields, } from "./field.js";
// ── Dynamic registry (populated by defineComponent) ──
/** Per-kind default values. Populated by defineComponent(). */
export const _defaults = new Map();
/** Ordered component kinds — index is the component ID. */
export const _kindOrder = [];
/** Kind → component ID (index into _kindOrder). */
export const _kindIds = new Map();
/** Per-kind bit position (1n << index). */
export const _kindBits = new Map();
export const _schemas = new Map();
/** Per-kind field descriptor tables — populated by defineComponent in field mode. */
export const _fieldMeta = new Map();
/** True when a value table is a field descriptor table (all values are FieldDesc). */
function isFieldTable(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const vals = Object.values(v);
    // Field mode is the ONLY mode: an empty table is a zero-field component
    // (e.g. uiNode). Raw default objects are rejected with a clear error.
    return vals.every((x) => typeof x === "object" &&
        x !== null &&
        "kind" in x &&
        typeof x.kind === "string");
}
/**
 * Register a new resource key. Resources are stored as components on singleton entities,
 * giving them tick-based change detection identical to entity components.
 */
export function defineResource(kind) {
    // The component stores { _value: Data } — shallow copy keeps the _value reference alive
    const _comp = defineComponent(kind, { _value: undefined });
    return { kind, _comp };
}
export function defineComponent(kind, defaults, opts) {
    // Guard: duplicate registration
    if (_kindBits.has(kind)) {
        throw new Error(`Component kind "${kind}" is already registered.`);
    }
    const id = _kindOrder.length;
    const bit = 1n << BigInt(id);
    _kindOrder.push(kind);
    _kindIds.set(kind, id);
    _kindBits.set(kind, bit);
    // Field mode: descriptor table → defaults + meta registry（isFieldTable 类型守卫内联收窄）。
    const dataDefaults = isFieldTable(defaults)
        ? defaultsFromFields(defaults)
        : cloneValue(defaults);
    if (isFieldTable(defaults))
        _fieldMeta.set(kind, defaults);
    _defaults.set(kind, dataDefaults);
    if (opts?.schema)
        _schemas.set(kind, opts.schema);
    const hasMutableDefaults = Object.values(dataDefaults).some((value) => (typeof value === "object" && value !== null) || typeof value === "function");
    function factory(overrides) {
        let data;
        if (overrides) {
            // Merge defaults with overrides, but undefined values in overrides
            // do NOT override defaults — a missing field means "use the default".
            data = hasMutableDefaults ? cloneValue(dataDefaults) : { ...dataDefaults };
            for (const key of Object.keys(overrides)) {
                const value = overrides[key];
                if (value !== undefined)
                    data[key] = value;
            }
        }
        else {
            data = hasMutableDefaults ? cloneValue(dataDefaults) : { ...dataDefaults };
        }
        return { type: kind, ...data };
    }
    factory.kind = kind;
    Object.defineProperty(factory, "defaults", {
        enumerable: true,
        get: () => cloneValue(dataDefaults),
    });
    factory.create = factory;
    return factory;
}
/** Field descriptor table for a kind, or undefined (raw-mode component). */
export function fieldMeta(kind) {
    return _fieldMeta.get(kind);
}
//# sourceMappingURL=component.js.map