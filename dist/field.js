// packages/ecs/src/field.ts — component field descriptors (single source of truth)
//
// Theory: a component definition IS its protocol contract. Every field carries
// its validation rules, JSON encoding, LLM docs, and default — one place, no
// parallel schemas.ts / spec.md / catalog.json.
//
// Zero dependencies. Pure data + pure functions.
// ═══════════════════════════════════════════════════════════
// Builder helpers — every modifier mutates and returns the same
// descriptor (builder pattern, zero allocation).
// ═══════════════════════════════════════════════════════════
function withModifiers(d) {
    const self = d;
    self.doc = (s) => { d.description = s; return d; };
    self.required = () => { d.isRequired = true; return d; };
    self.bindable = () => { d.canBind = true; return d; };
    self.writeBack = () => { d.canWriteBack = true; return d; };
    self.optional = () => { d.isRequired = false; return d; };
    return d;
}
export const f = {
    str() {
        const d = withModifiers({ kind: "str", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        d.enum = (...values) => { d.enumValues = values; return d; };
        return d;
    },
    num() {
        const d = withModifiers({ kind: "num", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        d.min = (v) => { d.minValue = v; return d; };
        d.max = (v) => { d.maxValue = v; return d; };
        return d;
    },
    int() {
        const d = withModifiers({ kind: "int", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        d.min = (v) => { d.minValue = v; return d; };
        d.max = (v) => { d.maxValue = v; return d; };
        return d;
    },
    bool() {
        const d = withModifiers({ kind: "bool", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    hex() {
        const d = withModifiers({ kind: "hex", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    vec3() {
        const d = withModifiers({ kind: "vec3", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    tuple(...items) {
        const d = withModifiers({ kind: "tuple", items, isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    array(elem) {
        const d = withModifiers({ kind: "array", elem, isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    map(val) {
        const d = withModifiers({ kind: "map", val, isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    entityRef() {
        const d = withModifiers({ kind: "entityRef", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    entityId() {
        const d = withModifiers({ kind: "entityId", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        d.min = (v) => { d.minValue = v; return d; };
        d.max = (v) => { d.maxValue = v; return d; };
        return d;
    },
    /** 通用 branded 数字字段——值类型 B（运行时 number），供 Handle<T>/自定义 brand 使用。 */
    branded() {
        const d = withModifiers({ kind: "branded", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        d.min = (v) => { d.minValue = v; return d; };
        d.max = (v) => { d.maxValue = v; return d; };
        return d;
    },
    union(...options) {
        const d = withModifiers({ kind: "union", options, isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    any() {
        const d = withModifiers({ kind: "any", isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
    obj(shape) {
        const d = withModifiers({ kind: "obj", shape, isRequired: false, canBind: false });
        d.default = (v) => { d.defaultValue = v; return d; };
        return d;
    },
};
/**
 * Clone mutable default values so component instances never share arrays, maps,
 * sets, typed arrays, or plain objects. Class instances are intentionally kept
 * by reference: schema defaults are data, not arbitrary object factories.
 */
export function cloneValue(value) {
    if (Array.isArray(value))
        return value.map((item) => cloneValue(item));
    if (value instanceof Map) {
        const out = new Map();
        for (const [key, item] of value)
            out.set(cloneValue(key), cloneValue(item));
        return out;
    }
    if (value instanceof Set) {
        const out = new Set();
        for (const item of value)
            out.add(cloneValue(item));
        return out;
    }
    if (value instanceof Date)
        return new Date(value.getTime());
    if (ArrayBuffer.isView(value)) {
        const view = value;
        if (view.slice)
            return view.slice();
        return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    if (typeof value === "object" && value !== null) {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) {
            const out = {};
            for (const [key, item] of Object.entries(value))
                out[key] = cloneValue(item);
            return out;
        }
    }
    return value;
}
// ═══════════════════════════════════════════════════════════
// Parsing — JSON protocol value → internal component value
// ═══════════════════════════════════════════════════════════
function err(path, message, hint) {
    return { path, message, hint };
}
function isBindValue(v) {
    return typeof v === "object" && v !== null && "path" in v && typeof v.path === "string";
}
/** Whole-field expression ref: {"expr": "...", "vars": {...}}. */
function isExprValue(v) {
    return (typeof v === "object" && v !== null &&
        "expr" in v && typeof v.expr === "string");
}
/** Path-like dynamic component ({"path": "/x"} — string or mixed array). */
function isPathValue(v) {
    return typeof v === "object" && v !== null && "path" in v;
}
function parseValue(desc, v, path, errors) {
    switch (desc.kind) {
        case "str":
        case "entityRef":
            if (typeof v !== "string") {
                if (desc.kind === "entityRef" && typeof v === "number") {
                    // Entity (numeric id) — resolved by resolveRefs from "$id".
                    return v;
                }
                errors.push(err(path, `expected string, got ${typeof v}`, `use a string like "${desc.kind === "str" ? "text" : "$entityId"}"`));
            }
            else if (desc.kind === "str" && desc.enumValues && !desc.enumValues.includes(v))
                errors.push(err(path, `invalid value "${v}"`, `one of: ${desc.enumValues.join(", ")}`));
            return v;
        case "num":
        case "int":
        case "entityId":
        case "branded": {
            if (typeof v !== "number")
                errors.push(err(path, `expected number, got ${typeof v}`));
            else {
                if ((desc.kind === "int" || desc.kind === "entityId") && !Number.isInteger(v))
                    errors.push(err(path, `expected integer, got ${v}`));
                if (desc.minValue !== undefined && v < desc.minValue)
                    errors.push(err(path, `value ${v} below minimum ${desc.minValue}`));
                if (desc.maxValue !== undefined && v > desc.maxValue)
                    errors.push(err(path, `value ${v} above maximum ${desc.maxValue}`));
            }
            return v;
        }
        case "bool":
            if (typeof v === "boolean")
                return v;
            // 比较表达式产出 1/0——绑定布尔字段（visibility.visible 等）时直接转换
            if (typeof v === "number")
                return v !== 0;
            errors.push(err(path, `expected boolean, got ${typeof v}`));
            return v;
        case "hex": {
            if (typeof v === "number")
                return v;
            if (typeof v === "string") {
                const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
                if (m)
                    return parseInt(m[1], 16);
                errors.push(err(path, `invalid color "${v}"`, `use "#rrggbb" (e.g. "#ff4444") or a number`));
                return v;
            }
            errors.push(err(path, `expected color, got ${typeof v}`));
            return v;
        }
        case "vec3": {
            if (!Array.isArray(v) || v.length !== 3) {
                errors.push(err(path, "expected [x,y,z] tuple"));
            }
            else {
                for (let i = 0; i < 3; i++) {
                    const el = v[i];
                    if (typeof el !== "number") {
                        if (isPathValue(el) || isExprValue(el)) {
                            // v5.7: 分量数组形式的动态值已移除——用整体 {expr, vars}。
                            errors.push(err(`${path}[${i}]`, "dynamic components are not supported", 'use a whole-field expression: {"expr": "[x, 0, z]", "vars": {"x": {"path": "/x"}}}'));
                        }
                        else {
                            errors.push(err(`${path}[${i}]`, "expected number"));
                        }
                    }
                }
            }
            return v;
        }
        case "tuple": {
            if (!Array.isArray(v) || v.length !== desc.items.length)
                errors.push(err(path, `expected ${desc.items.length}-element tuple`));
            else
                desc.items.forEach((d, i) => { v[i] = parseValue(d, v[i], `${path}[${i}]`, errors); });
            return v;
        }
        case "array": {
            if (!Array.isArray(v))
                errors.push(err(path, "expected array"));
            else
                v.forEach((el, i) => { v[i] = parseValue(desc.elem, el, `${path}[${i}]`, errors); });
            return v;
        }
        case "union": {
            // First option that parses cleanly wins. If none do, report the first error.
            let firstErr = null;
            for (const opt of desc.options) {
                const sub = [];
                const r = parseValue(opt, v, path, sub);
                if (sub.length === 0)
                    return r;
                if (!firstErr)
                    firstErr = sub[0];
            }
            errors.push(firstErr ?? err(path, "no union variant matched"));
            return v;
        }
        case "any":
            return v; // opaque — no validation (e.g. writeData.value)
        case "obj": {
            if (typeof v !== "object" || v === null || Array.isArray(v))
                errors.push(err(path, "expected object"));
            else {
                const obj = v;
                for (const [k, sub] of Object.entries(desc.shape)) {
                    if (obj[k] === undefined) {
                        if (sub.isRequired)
                            errors.push(err(`${path}.${k}`, `missing required field`));
                        else if (sub.defaultValue !== undefined)
                            obj[k] = sub.defaultValue;
                    }
                    else {
                        obj[k] = parseValue(sub, obj[k], `${path}.${k}`, errors);
                    }
                }
            }
            return v;
        }
        case "map": {
            if (typeof v !== "object" || v === null || Array.isArray(v))
                errors.push(err(path, "expected object"));
            else
                for (const [k, val] of Object.entries(v))
                    v[k] = parseValue(desc.val, val, `${path}.${k}`, errors);
            return v;
        }
    }
}
/**
 * Parse JSON protocol fields against a field descriptor table.
 * - fills defaults for missing optional fields
 * - converts JSON forms (hex strings → numbers)
 * - returns structured errors (never throws)
 */
export function parseFields(fields, input) {
    const errors = [];
    const out = {};
    for (const [name, desc] of Object.entries(fields)) {
        const raw = input[name];
        if (raw === undefined) {
            if (desc.isRequired) {
                errors.push(err(name, `missing required field`, `provide "${name}"`));
                continue;
            }
            if (desc.defaultValue !== undefined)
                out[name] = cloneValue(desc.defaultValue);
            continue;
        }
        // Binding values pass through untouched — the protocol layer resolves them.
        if (isBindValue(raw)) {
            if (!desc.canBind)
                errors.push(err(name, `field does not support {"path"} binding`, `send a literal value instead`));
            out[name] = raw;
            continue;
        }
        out[name] = parseValue(desc, raw, name, errors);
    }
    // Unknown fields — strict: reject with hint (LLM self-correction).
    for (const name of Object.keys(input)) {
        if (name in fields)
            continue;
        // LLM 常见错误：想用 {expr} 计算整个组件（如 transform）——表达式只作用于字段级。
        const hint = name === "expr" || name === "vars"
            ? '整组件表达式不支持——表达式写到字段级，如 {"translation": {"expr": "...", "vars": {...}}}'
            : `known fields: ${Object.keys(fields).join(", ")}`;
        errors.push(err(name, "unknown field", hint));
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}
export function fieldCatalog(fields) {
    const out = {};
    for (const [name, desc] of Object.entries(fields)) {
        out[name] = {
            type: desc.kind,
            doc: desc.description,
            default: cloneValue(desc.defaultValue),
            required: desc.isRequired,
            bindable: desc.canBind,
        };
    }
    return out;
}
/** Defaults derived from descriptors — used by defineComponent. */
export function defaultsFromFields(fields) {
    const out = {};
    for (const [name, desc] of Object.entries(fields))
        if (desc.defaultValue !== undefined)
            out[name] = cloneValue(desc.defaultValue);
    return out;
}
/** True when a field descriptor table contains bindable fields. */
export function hasBindableFields(fields) {
    return Object.values(fields).some(d => d.canBind);
}
//# sourceMappingURL=field.js.map