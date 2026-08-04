import type { FieldSchema } from "./component";
// packages/ecs/src/storage.ts — Column abstractions
// ObjectColumn (Record[]) and Float64Column (TypedArray SoA).

// ═══════════════════════════════════════════════════════════
// Generic component type
// ═══════════════════════════════════════════════════════════

/** Generic component object — `type` discriminant + data fields. */
export type Component = { type: string } & Record<string, unknown>;

// ═══════════════════════════════════════════════════════════
// Column — abstraction over component data arrays
// Phase 1: ObjectColumn (record arrays). Phase 2: Float64Column (TypedArray SoA).
// ═══════════════════════════════════════════════════════════

export interface Column {
  readonly count: number;
  readonly isFloat64: boolean;
  get(row: number): Record<string, unknown>;
  set(row: number, value: Record<string, unknown>): void;
  push(value: Record<string, unknown>): void;
  /** Move last row into `row`, then pop. */
  swapRemove(row: number): void;
  /** Pop the last element (no swap). Use when data was already moved. */
  pop(): void;
}

export class ObjectColumn implements Column {
  private _data: Record<string, unknown>[] = [];
  readonly isFloat64 = false;
  get count(): number {
    return this._data.length;
  }

  /** Zero-overhead access to the underlying row array.
   *  Use in forEach callbacks for stride-1 Record iteration without Column.get() overhead. */
  rawData(): Record<string, unknown>[] {
    return this._data;
  }

  get(row: number): Record<string, unknown> {
    return this._data[row];
  }
  set(row: number, value: Record<string, unknown>): void {
    this._data[row] = value;
  }
  push(value: Record<string, unknown>): void {
    this._data.push(value);
  }
  swapRemove(row: number): void {
    const last = this._data.length - 1;
    if (row !== last) this._data[row] = this._data[last];
    this._data.pop();
  }
  pop(): void {
    this._data.pop();
  }
}

/** TypedArray SoA column — each schema field = one Float64Array. Phase 2. */
export class Float64Column implements Column {
  private _fields: Map<string, Float64Array>;
  private _schema: FieldSchema;
  private _count = 0;
  private _cap = 0;
  readonly isFloat64 = true;

  constructor(schema: FieldSchema) {
    this._schema = schema;
    this._fields = new Map();
    const cap = 64;
    for (const name of Object.keys(schema)) {
      this._fields.set(name, new Float64Array(cap));
    }
    this._cap = cap;
  }

  get count(): number {
    return this._count;
  }

  /** Phase 3: raw Float64Array for a field. Zero-allocation system iteration. */
  field(name: string): Float64Array | undefined {
    return this._fields.get(name);
  }

  get(row: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [name, arr] of this._fields) {
      obj[name] = arr[row];
    }
    return obj;
  }

  set(row: number, value: Record<string, unknown>): void {
    for (const name of Object.keys(this._schema)) {
      this._fields.get(name)![row] = (value[name] as number) ?? 0;
    }
  }

  push(value: Record<string, unknown>): void {
    if (this._count >= this._cap) this._grow();
    for (const name of Object.keys(this._schema)) {
      this._fields.get(name)![this._count] = (value[name] as number) ?? 0;
    }
    this._count++;
  }

  swapRemove(row: number): void {
    const last = this._count - 1;
    if (row !== last) {
      for (const arr of this._fields.values()) {
        arr[row] = arr[last];
      }
    }
    this._count--;
  }

  pop(): void {
    this._count--;
  }

  private _grow(): void {
    const newCap = this._cap * 2;
    for (const [name, old] of this._fields) {
      const next = new Float64Array(newCap);
      next.set(old);
      this._fields.set(name, next);
    }
    this._cap = newCap;
  }
}

/** Create a resizable Int32Array with the given initial capacity. */
export function makeResizableInt32(cap: number): Int32Array {
  const arr = new Int32Array(cap);
  arr.fill(0);
  return arr;
}

import type { Entity } from "./entity";

/** Sparse set column — O(1) lookup, no archetype migration. */
export class SparseSetColumn<D extends Record<string, unknown>> {
  private _dense: D[] = [];
  private _sparse: Map<Entity, number> = new Map();
  private _addedTicks: Map<Entity, number> = new Map();
  private _changedTicks: Map<Entity, number> = new Map();

  has(entity: Entity): boolean {
    return this._sparse.has(entity);
  }
  get(entity: Entity): D | undefined {
    const idx = this._sparse.get(entity);
    return idx !== undefined ? this._dense[idx] : undefined;
  }
  set(entity: Entity, data: D, tick: number): void {
    const idx = this._sparse.get(entity);
    if (idx !== undefined) {
      this._dense[idx] = data;
      this._changedTicks.set(entity, tick);
    } else {
      this._sparse.set(entity, this._dense.length);
      this._dense.push(data);
      this._addedTicks.set(entity, tick);
      this._changedTicks.set(entity, tick);
    }
  }
  remove(entity: Entity): boolean {
    const idx = this._sparse.get(entity);
    if (idx === undefined) return false;
    const lastIdx = this._dense.length - 1;
    if (idx !== lastIdx) {
      this._dense[idx] = this._dense[lastIdx];
      // Update sparse mapping for the moved entity
      for (const [e, i] of this._sparse) {
        if (i === lastIdx) {
          this._sparse.set(e, idx);
          break;
        }
      }
    }
    this._dense.pop();
    this._sparse.delete(entity);
    this._addedTicks.delete(entity);
    this._changedTicks.delete(entity);
    return true;
  }
  getAddedTick(entity: Entity): number {
    return this._addedTicks.get(entity) ?? 0;
  }
  getChangedTick(entity: Entity): number {
    return this._changedTicks.get(entity) ?? 0;
  }
  get size(): number {
    return this._dense.length;
  }
}
