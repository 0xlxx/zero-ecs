// packages/ecs/src/events.ts — Events<T> 双缓冲事件通道（Bevy Events<T> 等价）
//
// 双缓冲：write() 写入当前 buffer，read() 读上一帧写入的事件（延迟一帧），
// update() 帧末交换——写 buffer 变读（下帧可读），读 buffer 清空变写。
// 避免"写者读到自己的写"（同帧内写入的事件本帧不可见）。

export class Events<T> {
  private _bufs: [T[], T[]] = [[], []];
  private _writeIdx = 0;

  /** 写入一个事件到当前帧 buffer。 */
  write(event: T): void {
    this._bufs[this._writeIdx].push(event);
  }

  /** 批量写入。 */
  extend(events: readonly T[]): void {
    const buf = this._bufs[this._writeIdx];
    for (const e of events) buf.push(e);
  }

  /** 读上一帧写入的事件（双缓冲）。返回只读引用——update() 时清空。 */
  read(): readonly T[] {
    return this._bufs[1 - this._writeIdx];
  }

  /** 帧末交换：当前读 buffer（已消费）清空变写，当前写 buffer 变读（下帧可读）。 */
  update(): void {
    this._bufs[1 - this._writeIdx].length = 0;
    this._writeIdx = 1 - this._writeIdx;
  }

  /** 清空全部事件（不交换）。 */
  clear(): void {
    this._bufs[0].length = 0;
    this._bufs[1].length = 0;
  }

  /** 当前可读事件数（上一帧写入的）。 */
  get len(): number {
    return this._bufs[1 - this._writeIdx].length;
  }
}
