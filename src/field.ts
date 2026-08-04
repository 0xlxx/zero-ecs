// packages/ecs/src/field.ts — component field descriptors (single source of truth)
//
// Theory: a component definition IS its protocol contract. Every field carries
// its validation rules, JSON encoding, LLM docs, and default — one place, no
// parallel schemas.ts / spec.md / catalog.json.
//
// Zero dependencies. Pure data + pure functions.

// ═══════════════════════════════════════════════════════════
// Descriptor types
// ═══════════════════════════════════════════════════════════

interface FieldBase {
  /** Internal state — the descriptor is a builder; methods flip these flags. */
  isRequired: boolean;
  canBind: boolean;
  /** 双向通道：{path} 绑定解析时注入 writePath，供交互写回（如滑块拖动）。 */
  canWriteBack?: boolean;
  description?: string;
  /** 声明该字段为双向通道（交互写回目标与绑定路径一致）。 */
  writeBack(): this;
}

export interface StrDesc extends FieldBase {
  kind: "str";
  defaultValue?: string;
  enumValues?: string[];
  default(v: string): StrDesc;
  enum(...values: string[]): StrDesc;
  doc(s: string): StrDesc;
  required(): StrDesc;
  bindable(): StrDesc;
  optional(): StrDesc;
}
export interface NumDesc extends FieldBase {
  kind: "num";
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  default(v: number): NumDesc;
  min(v: number): NumDesc;
  max(v: number): NumDesc;
  doc(s: string): NumDesc;
  required(): NumDesc;
  bindable(): NumDesc;
  optional(): NumDesc;
}
export interface IntDesc extends FieldBase {
  kind: "int";
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  default(v: number): IntDesc;
  min(v: number): IntDesc;
  max(v: number): IntDesc;
  doc(s: string): IntDesc;
  required(): IntDesc;
  bindable(): IntDesc;
  optional(): IntDesc;
}
export interface BoolDesc extends FieldBase {
  kind: "bool";
  defaultValue?: boolean;
  default(v: boolean): BoolDesc;
  doc(s: string): BoolDesc;
  required(): BoolDesc;
  bindable(): BoolDesc;
  optional(): BoolDesc;
}
export interface HexDesc extends FieldBase {
  kind: "hex";
  defaultValue?: number;
  default(v: number): HexDesc;
  doc(s: string): HexDesc;
  required(): HexDesc;
  bindable(): HexDesc;
  optional(): HexDesc;
}
export interface Vec3Desc extends FieldBase {
  kind: "vec3";
  defaultValue?: [number, number, number];
  default(v: [number, number, number]): Vec3Desc;
  doc(s: string): Vec3Desc;
  required(): Vec3Desc;
  bindable(): Vec3Desc;
  optional(): Vec3Desc;
}
export interface TupleDesc extends FieldBase {
  kind: "tuple";
  items: FieldDesc[];
  defaultValue?: unknown[];
  default(v: unknown[]): TupleDesc;
  doc(s: string): TupleDesc;
  required(): TupleDesc;
  bindable(): TupleDesc;
  optional(): TupleDesc;
}
export interface ArrayDesc extends FieldBase {
  kind: "array";
  elem: FieldDesc;
  defaultValue?: unknown[];
  default(v: unknown[]): ArrayDesc;
  doc(s: string): ArrayDesc;
  required(): ArrayDesc;
  bindable(): ArrayDesc;
  optional(): ArrayDesc;
}
export interface MapDesc extends FieldBase {
  kind: "map";
  val: FieldDesc;
  defaultValue?: Record<string, unknown>;
  default(v: Record<string, unknown>): MapDesc;
  doc(s: string): MapDesc;
  required(): MapDesc;
  bindable(): MapDesc;
  optional(): MapDesc;
}
export interface UnionDesc extends FieldBase {
  kind: "union";
  options: FieldDesc[];
  defaultValue?: unknown;
  default(v: unknown): UnionDesc;
  bindable(): UnionDesc;
  doc(s: string): UnionDesc;
  required(): UnionDesc;
  optional(): UnionDesc;
}

export interface AnyDesc extends FieldBase {
  kind: "any";
  defaultValue?: unknown;
  default(v: unknown): AnyDesc;
  doc(s: string): AnyDesc;
  required(): AnyDesc;
  optional(): AnyDesc;
}

export interface ObjDesc extends FieldBase {
  kind: "obj";
  shape: Record<string, FieldDesc>;
  defaultValue?: Record<string, unknown>;
  default(v: Record<string, unknown>): ObjDesc;
  doc(s: string): ObjDesc;
  required(): ObjDesc;
  optional(): ObjDesc;
}

export interface EntityRefDesc extends FieldBase {
  kind: "entityRef";
  defaultValue?: string;
  default(v: string): EntityRefDesc;
  doc(s: string): EntityRefDesc;
  required(): EntityRefDesc;
  bindable(): EntityRefDesc;
  optional(): EntityRefDesc;
}

export type FieldDesc =
  | StrDesc | NumDesc | IntDesc | BoolDesc | HexDesc
  | Vec3Desc | TupleDesc | ArrayDesc | MapDesc | AnyDesc | ObjDesc | UnionDesc | EntityRefDesc;

// ═══════════════════════════════════════════════════════════
// Builder helpers — every modifier mutates and returns the same
// descriptor (builder pattern, zero allocation).
// ═══════════════════════════════════════════════════════════

function withModifiers<D extends FieldDesc>(d: D): D {
  const self = d as unknown as Record<string, unknown>;
  self.doc = (s: string) => { d.description = s; return d; };
  self.required = () => { d.isRequired = true; return d; };
  self.bindable = () => { d.canBind = true; return d; };
  self.writeBack = () => { d.canWriteBack = true; return d; };
  self.optional = () => { d.isRequired = false; return d; };
  return d;
}

export const f = {
  str(): StrDesc {
    const d = withModifiers({ kind: "str", isRequired: false, canBind: false } as StrDesc);
    d.default = (v: string) => { d.defaultValue = v; return d; };
    d.enum = (...values: string[]) => { d.enumValues = values; return d; };
    return d;
  },
  num(): NumDesc {
    const d = withModifiers({ kind: "num", isRequired: false, canBind: false } as NumDesc);
    d.default = (v: number) => { d.defaultValue = v; return d; };
    d.min = (v: number) => { d.minValue = v; return d; };
    d.max = (v: number) => { d.maxValue = v; return d; };
    return d;
  },
  int(): IntDesc {
    const d = withModifiers({ kind: "int", isRequired: false, canBind: false } as IntDesc);
    d.default = (v: number) => { d.defaultValue = v; return d; };
    d.min = (v: number) => { d.minValue = v; return d; };
    d.max = (v: number) => { d.maxValue = v; return d; };
    return d;
  },
  bool(): BoolDesc {
    const d = withModifiers({ kind: "bool", isRequired: false, canBind: false } as BoolDesc);
    d.default = (v: boolean) => { d.defaultValue = v; return d; };
    return d;
  },
  hex(): HexDesc {
    const d = withModifiers({ kind: "hex", isRequired: false, canBind: false } as HexDesc);
    d.default = (v: number) => { d.defaultValue = v; return d; };
    return d;
  },
  vec3(): Vec3Desc {
    const d = withModifiers({ kind: "vec3", isRequired: false, canBind: false } as Vec3Desc);
    d.default = (v: [number, number, number]) => { d.defaultValue = v; return d; };
    return d;
  },
  tuple(...items: FieldDesc[]): TupleDesc {
    const d = withModifiers({ kind: "tuple", items, isRequired: false, canBind: false } as TupleDesc);
    d.default = (v: unknown[]) => { d.defaultValue = v; return d; };
    return d;
  },
  array(elem: FieldDesc): ArrayDesc {
    const d = withModifiers({ kind: "array", elem, isRequired: false, canBind: false } as ArrayDesc);
    d.default = (v: unknown[]) => { d.defaultValue = v; return d; };
    return d;
  },
  map(val: FieldDesc): MapDesc {
    const d = withModifiers({ kind: "map", val, isRequired: false, canBind: false } as MapDesc);
    d.default = (v: Record<string, unknown>) => { d.defaultValue = v; return d; };
    return d;
  },
  entityRef(): EntityRefDesc {
    const d = withModifiers({ kind: "entityRef", isRequired: false, canBind: false } as EntityRefDesc);
    d.default = (v: string) => { d.defaultValue = v; return d; };
    return d;
  },
  union(...options: FieldDesc[]): UnionDesc {
    const d = withModifiers({ kind: "union", options, isRequired: false, canBind: false } as UnionDesc);
    d.default = (v: unknown) => { d.defaultValue = v; return d; };
    return d;
  },
  any(): AnyDesc {
    const d = withModifiers({ kind: "any", isRequired: false, canBind: false } as AnyDesc);
    d.default = (v: unknown) => { d.defaultValue = v; return d; };
    return d;
  },
  obj(shape: Record<string, FieldDesc>): ObjDesc {
    const d = withModifiers({ kind: "obj", shape, isRequired: false, canBind: false } as ObjDesc);
    d.default = (v: Record<string, unknown>) => { d.defaultValue = v; return d; };
    return d;
  },
};

// ═══════════════════════════════════════════════════════════
// Structured errors (D9) — value results, never thrown
// ═══════════════════════════════════════════════════════════

export interface FieldError {
  /** JSON-pointer-like path inside the component, e.g. "curve.expr". */
  path: string;
  message: string;
  /** LLM-facing correction hint. */
  hint?: string;
}

export type FieldResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

// ═══════════════════════════════════════════════════════════
// Parsing — JSON protocol value → internal component value
// ═══════════════════════════════════════════════════════════

function err(path: string, message: string, hint?: string): FieldError {
  return { path, message, hint };
}

function isBindValue(v: unknown): v is { path: string } {
  return typeof v === "object" && v !== null && "path" in v && typeof (v as { path: string }).path === "string";
}

/** Whole-field expression ref: {"expr": "...", "vars": {...}}. */
function isExprValue(v: unknown): v is { expr: string } {
  return (
    typeof v === "object" && v !== null &&
    "expr" in v && typeof (v as { expr: unknown }).expr === "string"
  );
}

/** Path-like dynamic component ({"path": "/x"} — string or mixed array). */
function isPathValue(v: unknown): boolean {
  return typeof v === "object" && v !== null && "path" in v;
}

function parseValue(desc: FieldDesc, v: unknown, path: string, errors: FieldError[]): unknown {
  switch (desc.kind) {
    case "str":
    case "entityRef":
      if (typeof v !== "string") {
        if (desc.kind === "entityRef" && typeof v === "number") {
          // Entity (numeric id) — resolved by resolveRefs from "$id".
          return v;
        }
        errors.push(err(path, `expected string, got ${typeof v}`, `use a string like "${desc.kind === "str" ? "text" : "$entityId"}"`));
      } else if (desc.kind === "str" && desc.enumValues && !desc.enumValues.includes(v))
        errors.push(err(path, `invalid value "${v}"`, `one of: ${desc.enumValues.join(", ")}`));
      return v;
    case "num":
    case "int": {
      if (typeof v !== "number")
        errors.push(err(path, `expected number, got ${typeof v}`));
      else {
        if (desc.kind === "int" && !Number.isInteger(v))
          errors.push(err(path, `expected integer, got ${v}`));
        if (desc.minValue !== undefined && v < desc.minValue)
          errors.push(err(path, `value ${v} below minimum ${desc.minValue}`));
        if (desc.maxValue !== undefined && v > desc.maxValue)
          errors.push(err(path, `value ${v} above maximum ${desc.maxValue}`));
      }
      return v;
    }
    case "bool":
      if (typeof v === "boolean") return v;
      // 比较表达式产出 1/0——绑定布尔字段（visibility.visible 等）时直接转换
      if (typeof v === "number") return v !== 0;
      errors.push(err(path, `expected boolean, got ${typeof v}`));
      return v;
    case "hex": {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
        if (m) return parseInt(m[1], 16);
        errors.push(err(path, `invalid color "${v}"`, `use "#rrggbb" (e.g. "#ff4444") or a number`));
        return v;
      }
      errors.push(err(path, `expected color, got ${typeof v}`));
      return v;
    }
    case "vec3": {
      if (!Array.isArray(v) || v.length !== 3) {
        errors.push(err(path, "expected [x,y,z] tuple"));
      } else {
        for (let i = 0; i < 3; i++) {
          const el = v[i];
          if (typeof el !== "number") {
            if (isPathValue(el) || isExprValue(el)) {
              // v5.7: 分量数组形式的动态值已移除——用整体 {expr, vars}。
              errors.push(
                err(`${path}[${i}]`, "dynamic components are not supported",
                  'use a whole-field expression: {"expr": "[x, 0, z]", "vars": {"x": {"path": "/x"}}}'),
              );
            } else {
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
      let firstErr: FieldError | null = null;
      for (const opt of desc.options) {
        const sub: FieldError[] = [];
        const r = parseValue(opt, v, path, sub);
        if (sub.length === 0) return r;
        if (!firstErr) firstErr = sub[0];
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
        const obj = v as Record<string, unknown>;
        for (const [k, sub] of Object.entries(desc.shape)) {
          if (obj[k] === undefined) {
            if (sub.isRequired) errors.push(err(`${path}.${k}`, `missing required field`));
            else if (sub.defaultValue !== undefined) obj[k] = sub.defaultValue;
          } else {
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
          (v as Record<string, unknown>)[k] = parseValue(desc.val, val, `${path}.${k}`, errors);
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
export function parseFields(
  fields: Record<string, FieldDesc>,
  input: Record<string, unknown>,
): FieldResult<Record<string, unknown>> {
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, desc] of Object.entries(fields)) {
    const raw = input[name];
    if (raw === undefined) {
      if (desc.isRequired) {
        errors.push(err(name, `missing required field`, `provide "${name}"`));
        continue;
      }
      if (desc.defaultValue !== undefined) out[name] = desc.defaultValue;
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
    if (name in fields) continue;
    // LLM 常见错误：想用 {expr} 计算整个组件（如 transform）——表达式只作用于字段级。
    const hint =
      name === "expr" || name === "vars"
        ? '整组件表达式不支持——表达式写到字段级，如 {"translation": {"expr": "...", "vars": {...}}}'
        : `known fields: ${Object.keys(fields).join(", ")}`;
    errors.push(err(name, "unknown field", hint));
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

// ═══════════════════════════════════════════════════════════
// Catalog — LLM-facing documentation, generated from descriptors
// ═══════════════════════════════════════════════════════════

export interface FieldCatalogEntry {
  type: string;
  doc?: string;
  default?: unknown;
  required: boolean;
  bindable: boolean;
}

export function fieldCatalog(fields: Record<string, FieldDesc>): Record<string, FieldCatalogEntry> {
  const out: Record<string, FieldCatalogEntry> = {};
  for (const [name, desc] of Object.entries(fields)) {
    out[name] = {
      type: desc.kind,
      doc: desc.description,
      default: desc.defaultValue,
      required: desc.isRequired,
      bindable: desc.canBind,
    };
  }
  return out;
}

/** Defaults derived from descriptors — used by defineComponent. */
export function defaultsFromFields(fields: Record<string, FieldDesc>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, desc] of Object.entries(fields))
    if (desc.defaultValue !== undefined) out[name] = desc.defaultValue;
  return out;
}

/** True when a field descriptor table contains bindable fields. */
export function hasBindableFields(fields: Record<string, FieldDesc>): boolean {
  return Object.values(fields).some(d => d.canBind);
}
