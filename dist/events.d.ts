export declare class Events<T> {
    private _bufs;
    private _writeIdx;
    /** 写入一个事件到当前帧 buffer。 */
    write(event: T): void;
    /** 批量写入。 */
    extend(events: readonly T[]): void;
    /** 读上一帧写入的事件（双缓冲）。返回只读引用——update() 时清空。 */
    read(): readonly T[];
    /** 帧末交换：当前读 buffer（已消费）清空变写，当前写 buffer 变读（下帧可读）。 */
    update(): void;
    /** 清空全部事件（不交换）。 */
    clear(): void;
    /** 当前可读事件数（上一帧写入的）。 */
    get len(): number;
}
//# sourceMappingURL=events.d.ts.map