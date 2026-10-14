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
export interface ArrayDesc<Elem extends FieldDesc = FieldDesc> extends FieldBase {
    kind: "array";
    elem: Elem;
    defaultValue?: unknown[];
    default(v: unknown[]): ArrayDesc<Elem>;
    doc(s: string): ArrayDesc<Elem>;
    required(): ArrayDesc<Elem>;
    bindable(): ArrayDesc<Elem>;
    optional(): ArrayDesc<Elem>;
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
/** 实体 id 字段——运行时是 number（Entity 即 branded number），编译期类型为 Entity。 */
export interface EntityIdDesc extends FieldBase {
    kind: "entityId";
    defaultValue?: number;
    minValue?: number;
    maxValue?: number;
    default(v: number): EntityIdDesc;
    min(v: number): EntityIdDesc;
    max(v: number): EntityIdDesc;
    doc(s: string): EntityIdDesc;
    required(): EntityIdDesc;
    bindable(): EntityIdDesc;
    optional(): EntityIdDesc;
}
/** 通用 branded 数字字段（Handle<T>/Entity 等）——运行时 number，编译期 B。 */
export interface BrandedDesc<B> extends FieldBase {
    kind: "branded";
    _phantom?: B;
    defaultValue?: number;
    minValue?: number;
    maxValue?: number;
    default(v: number): BrandedDesc<B>;
    min(v: number): BrandedDesc<B>;
    max(v: number): BrandedDesc<B>;
    doc(s: string): BrandedDesc<B>;
    required(): BrandedDesc<B>;
    bindable(): BrandedDesc<B>;
    optional(): BrandedDesc<B>;
}
export type FieldDesc = StrDesc | NumDesc | IntDesc | BoolDesc | HexDesc | Vec3Desc | TupleDesc | ArrayDesc | MapDesc | AnyDesc | ObjDesc | UnionDesc | EntityRefDesc | EntityIdDesc | BrandedDesc<unknown>;
export declare const f: {
    str(): StrDesc;
    num(): NumDesc;
    int(): IntDesc;
    bool(): BoolDesc;
    hex(): HexDesc;
    vec3(): Vec3Desc;
    tuple(...items: FieldDesc[]): TupleDesc;
    array<Elem extends FieldDesc>(elem: Elem): ArrayDesc<Elem>;
    map(val: FieldDesc): MapDesc;
    entityRef(): EntityRefDesc;
    entityId(): EntityIdDesc;
    /** 通用 branded 数字字段——值类型 B（运行时 number），供 Handle<T>/自定义 brand 使用。 */
    branded<B>(): BrandedDesc<B>;
    union(...options: FieldDesc[]): UnionDesc;
    any(): AnyDesc;
    obj(shape: Record<string, FieldDesc>): ObjDesc;
};
export interface FieldError {
    /** JSON-pointer-like path inside the component, e.g. "curve.expr". */
    path: string;
    message: string;
    /** LLM-facing correction hint. */
    hint?: string;
}
export type FieldResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errors: FieldError[];
};
/**
 * Clone mutable default values so component instances never share arrays, maps,
 * sets, typed arrays, or plain objects. Class instances are intentionally kept
 * by reference: schema defaults are data, not arbitrary object factories.
 */
export declare function cloneValue<T>(value: T): T;
/**
 * Parse JSON protocol fields against a field descriptor table.
 * - fills defaults for missing optional fields
 * - converts JSON forms (hex strings → numbers)
 * - returns structured errors (never throws)
 */
export declare function parseFields(fields: Record<string, FieldDesc>, input: Record<string, unknown>): FieldResult<Record<string, unknown>>;
export interface FieldCatalogEntry {
    type: string;
    doc?: string;
    default?: unknown;
    required: boolean;
    bindable: boolean;
}
export declare function fieldCatalog(fields: Record<string, FieldDesc>): Record<string, FieldCatalogEntry>;
/** Defaults derived from descriptors — used by defineComponent. */
export declare function defaultsFromFields(fields: Record<string, FieldDesc>): Record<string, unknown>;
/** True when a field descriptor table contains bindable fields. */
export declare function hasBindableFields(fields: Record<string, FieldDesc>): boolean;
export {};
//# sourceMappingURL=field.d.ts.map