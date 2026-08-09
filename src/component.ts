// packages/ecs/src/component.ts — Component factory system
// Gregory §17.2.2: property class IS the key. No string enums, no kind unions.

import {
  type FieldDesc,
  defaultsFromFields,
} from "./field.js";
import type { Entity } from "./entity.js";

// ═══════════════════════════════════════════════════════════
// Component factory system
// ═══════════════════════════════════════════════════════════

/**
 * A component instance — factory defaults merged with overrides, plus `type` discriminant.
 * Returned by `factory.create()`.
 */
export type ComponentOf<Data> = Data & { type: string };

/**
 * Component factory — the primary API for defining and interacting with component types.
 *
 * Gregory §17.2.2: property class IS the key. No string enums, no kind unions.
 * `defineComponent(name, defaults)` returns a typed factory. Pass it to World methods
 * for full type inference.
 *
 * Users extend the engine by calling `defineComponent()` in their own packages —
 * zero declaration merging needed.
 */
export interface ComponentFactory<Data, Kind extends string = string> {
  /** Create a component instance. Factory is directly callable: `Transform({ x: 1 })`. */
  (overrides?: Partial<Data>): ComponentOf<Data>;
  /** Runtime kind identifier — inferred as literal from defineComponent()'s first arg. */
  readonly kind: Kind;
  /** Default values — merged with overrides in overrides. */
  readonly defaults: Data;
  /** @deprecated Factory is directly callable: use `Transform({...})` instead of `Transform.create({...})`. */
  create(overrides?: Partial<Data>): ComponentOf<Data>;
}

// ── Dynamic registry (populated by defineComponent) ──

/** Per-kind default values. Populated by defineComponent(). */
export const _defaults = new Map<string, Record<string, unknown>>();

/** Ordered component kinds — index is the component ID. */
export const _kindOrder: string[] = [];

/** Kind → component ID (index into _kindOrder). */
export const _kindIds = new Map<string, number>();

/** Per-kind bit position (1n << index). */
export const _kindBits = new Map<string, bigint>();

/** Phase 2: per-kind TypedArray field schema. Undefined = ObjectColumn. */
export type FieldSchema = Record<string, "float64">;
export const _schemas = new Map<string, FieldSchema>();
/** Per-kind sparse storage flag. Set by defineComponent opts.storage === "sparse". */
export const _sparseKinds = new Set<string>();

/** Per-kind field descriptor tables — populated by defineComponent in field mode. */
export const _fieldMeta = new Map<string, Record<string, FieldDesc>>();

/** True when a value table is a field descriptor table (all values are FieldDesc). */
function isFieldTable(v: unknown): v is Record<string, FieldDesc> {
  if (typeof v !== "object" || v === null) return false;
  const vals = Object.values(v);
  // Field mode is the ONLY mode: an empty table is a zero-field component
  // (e.g. uiNode). Raw default objects are rejected with a clear error.
  return vals.every(
    (x) =>
      typeof x === "object" &&
      x !== null &&
      "kind" in x &&
      typeof (x as { kind: unknown }).kind === "string",
  );
}

/**
 * Resource factory — typed key for World resources (Bevy-style `trait Resource: Component`).
 *
 * Wraps a ComponentFactory internally: resources are stored as components on dedicated
 * "resource entities" — one entity per resource kind. This gives them tick-based change
 * detection identical to entity components.
 *
 * ```ts
 * const DataStore = defineResource<Map<string, unknown>>("dataStore");
 * world.insertResource(DataStore, new Map());
 * const map = world.resource(DataStore);
 * world.resourceChanged(DataStore); // true/false, auto-tracked per system
 * ```
 */
export interface ResourceFactory<Data, Kind extends string = string> {
  readonly kind: Kind;
  /** @internal — underlying ComponentFactory for entity storage + tick tracking. */
  readonly _comp: ComponentFactory<{ _value: Data }, Kind>;
  /** @internal — phantom for DataOf type extraction. Never exists at runtime. */
  readonly _phantom?: Data;
}

/**
 * Register a new resource key. Resources are stored as components on singleton entities,
 * giving them tick-based change detection identical to entity components.
 */
export function defineResource<Data = unknown>(kind: string): ResourceFactory<Data, string> {
  // The component stores { _value: Data } — shallow copy keeps the _value reference alive
  const _comp = defineComponent(kind, { _value: undefined as unknown as Data });
  return { kind, _comp };
}

/**
 * Register a new component type.
 *
 * Two modes:
 * - **Field mode** (default): `defineComponent("curve", { expr: f.str()... })` —
 *   every value is a FieldDesc. The descriptor table IS the protocol contract:
 *   defaults, validation, JSON encoding, and LLM docs all derive from it.
 * - **Raw mode**: plain defaults object (internal/performance-sensitive
 *   components that never cross the protocol boundary).
 *
 * Returns a typed factory.
 */
export function defineComponent<const Kind extends string, F extends Record<string, FieldDesc>>(
  kind: Kind,
  fields: F,
  opts?: { schema?: FieldSchema; storage?: "sparse" },
): ComponentFactory<FieldsToData<F>, Kind>;
export function defineComponent<Data, const Kind extends string = string>(
  kind: Kind,
  defaults: Data,
  opts?: { schema?: FieldSchema; storage?: "sparse" },
): ComponentFactory<Data, Kind>;
export function defineComponent<Data, const Kind extends string = string>(
  kind: Kind,
  defaults: Data | Record<string, FieldDesc>,
  opts?: { schema?: FieldSchema; storage?: "sparse" },
): ComponentFactory<Data, Kind> {
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
  const dataDefaults: Record<string, unknown> = isFieldTable(defaults)
    ? defaultsFromFields(defaults)
    : (defaults as Record<string, unknown>);
  if (isFieldTable(defaults)) _fieldMeta.set(kind, defaults);

  _defaults.set(kind, dataDefaults);
  if (opts?.schema) _schemas.set(kind, opts.schema);
  if (opts?.storage === "sparse") _sparseKinds.add(kind);

  function factory(overrides?: Partial<Data>): ComponentOf<Data> {
    let data: Data;
    if (overrides) {
      // Merge defaults with overrides, but undefined values in overrides
      // do NOT override defaults — a missing field means "use the default".
      data = { ...(dataDefaults as Record<string, unknown>) } as Data;
      for (const key of Object.keys(overrides) as (keyof Data)[]) {
        const value = overrides[key];
        if (value !== undefined) data[key] = value;
      }
    } else {
      data = { ...(dataDefaults as Record<string, unknown>) } as Data;
    }
    return { type: kind, ...data };
  }
  factory.kind = kind;
  factory.defaults = dataDefaults as Data;
  factory.create = factory;
  return factory;
}

export type Component = { type: string } & Record<string, unknown>;

/** Extract the Data type from a ComponentFactory or ResourceFactory. */
export type DataOf<F> =
  F extends ComponentFactory<infer D>
    ? D
    : F extends { _phantom?: infer D }
      ? Exclude<D, undefined>
      : never;

// ═══════════════════════════════════════════════════════════
// Field mode type mapping — descriptor table → instance data type
// ═══════════════════════════════════════════════════════════

type DescToValue<D> =
  D extends { kind: "str" } | { kind: "entityRef" } ? string
  : D extends { kind: "entityId" } ? Entity
  : D extends { kind: "branded"; _phantom?: infer B } ? B
  : D extends { kind: "num" } | { kind: "int" } | { kind: "hex" } ? number
  : D extends { kind: "bool" } ? boolean
  : D extends { kind: "vec3" } ? readonly [number, number, number]
  : D extends { kind: "tuple" } ? unknown[]
  : D extends { kind: "array"; elem: infer E extends import("./field.js").FieldDesc } ? DescToValue<E>[]
  : D extends { kind: "map" } ? Record<string, unknown>
  : D extends { kind: "obj"; shape: infer S extends Record<string, FieldDesc> }
    ? { [K in keyof S]: DescToValue<S[K]> }
  : D extends { kind: "any" } ? unknown
  : never;

/** Field descriptor table → component instance data type. */
export type FieldsToData<F extends Record<string, FieldDesc>> = {
  [K in keyof F]: DescToValue<F[K]>;
};

/** Field descriptor table for a kind, or undefined (raw-mode component). */
export function fieldMeta(kind: string): Record<string, FieldDesc> | undefined {
  return _fieldMeta.get(kind);
}
