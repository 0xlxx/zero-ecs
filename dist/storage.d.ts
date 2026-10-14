import type { FieldSchema } from "./component.js";
/** Generic component object — `type` discriminant + data fields. */
export type Component = {
    type: string;
} & Record<string, unknown>;
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
export declare class ObjectColumn implements Column {
    private _data;
    readonly isFloat64 = false;
    get count(): number;
    /** Zero-overhead access to the underlying row array.
     *  Use in forEach callbacks for stride-1 Record iteration without Column.get() overhead. */
    rawData(): Record<string, unknown>[];
    get(row: number): Record<string, unknown>;
    set(row: number, value: Record<string, unknown>): void;
    push(value: Record<string, unknown>): void;
    swapRemove(row: number): void;
    pop(): void;
}
/** TypedArray SoA column — each schema field = one Float64Array. Phase 2. */
/** SoA 列窄化——isFloat64 字面量判别（false → ObjectColumn，免断言）。
 *  Fast path 调用处已保证非 f64（hasF64 检测）；此处 throw 为防御。 */
export declare function asObjectColumn(col: ObjectColumn | Float64Column): ObjectColumn;
export declare class Float64Column implements Column {
    private _fields;
    private _schema;
    private _count;
    private _cap;
    readonly isFloat64 = true;
    constructor(schema: FieldSchema);
    get count(): number;
    /** Phase 3: raw Float64Array for a field. Zero-allocation system iteration. */
    field(name: string): Float64Array | undefined;
    get(row: number): Record<string, unknown>;
    set(row: number, value: Record<string, unknown>): void;
    push(value: Record<string, unknown>): void;
    swapRemove(row: number): void;
    pop(): void;
    private _grow;
}
//# sourceMappingURL=storage.d.ts.map