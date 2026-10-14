export class ObjectColumn {
    constructor() {
        this._data = [];
        this.isFloat64 = false;
    }
    get count() {
        return this._data.length;
    }
    /** Zero-overhead access to the underlying row array.
     *  Use in forEach callbacks for stride-1 Record iteration without Column.get() overhead. */
    rawData() {
        return this._data;
    }
    get(row) {
        return this._data[row];
    }
    set(row, value) {
        this._data[row] = value;
    }
    push(value) {
        this._data.push(value);
    }
    swapRemove(row) {
        const last = this._data.length - 1;
        if (row !== last)
            this._data[row] = this._data[last];
        this._data.pop();
    }
    pop() {
        this._data.pop();
    }
}
/** TypedArray SoA column — each schema field = one Float64Array. Phase 2. */
/** SoA 列窄化——isFloat64 字面量判别（false → ObjectColumn，免断言）。
 *  Fast path 调用处已保证非 f64（hasF64 检测）；此处 throw 为防御。 */
export function asObjectColumn(col) {
    if (col.isFloat64)
        throw new Error("asObjectColumn: expected ObjectColumn");
    return col;
}
export class Float64Column {
    constructor(schema) {
        this._count = 0;
        this._cap = 0;
        this.isFloat64 = true;
        this._schema = schema;
        this._fields = new Map();
        const cap = 64;
        for (const name of Object.keys(schema)) {
            this._fields.set(name, new Float64Array(cap));
        }
        this._cap = cap;
    }
    get count() {
        return this._count;
    }
    /** Phase 3: raw Float64Array for a field. Zero-allocation system iteration. */
    field(name) {
        return this._fields.get(name);
    }
    get(row) {
        const obj = {};
        for (const [name, arr] of this._fields) {
            obj[name] = arr[row];
        }
        return obj;
    }
    set(row, value) {
        for (const name of Object.keys(this._schema)) {
            this._fields.get(name)[row] = value[name] ?? 0;
        }
    }
    push(value) {
        if (this._count >= this._cap)
            this._grow();
        for (const name of Object.keys(this._schema)) {
            this._fields.get(name)[this._count] = value[name] ?? 0;
        }
        this._count++;
    }
    swapRemove(row) {
        const last = this._count - 1;
        if (row !== last) {
            for (const arr of this._fields.values()) {
                arr[row] = arr[last];
            }
        }
        this._count--;
    }
    pop() {
        this._count--;
    }
    _grow() {
        const newCap = this._cap * 2;
        for (const [name, old] of this._fields) {
            const next = new Float64Array(newCap);
            next.set(old);
            this._fields.set(name, next);
        }
        this._cap = newCap;
    }
}
//# sourceMappingURL=storage.js.map