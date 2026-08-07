// @vitest-environment jsdom
// Events<T> 双缓冲单元测试（Bevy Events<T> 语义）

import { describe, it, expect } from "vitest";
import { Events } from "../src/index.js";

describe("Events<T> 双缓冲", () => {
  it("write 本帧不可读，update 后上一帧可读", () => {
    const ev = new Events<number>();
    ev.write(1);
    ev.write(2);
    expect(ev.read()).toEqual([]); // 本帧不可见（防写者读回自己）
    ev.update();
    expect(ev.read()).toEqual([1, 2]);
  });

  it("update 清空已消费读 buffer，新写入延迟一帧可读", () => {
    const ev = new Events<string>();
    ev.write("a");
    ev.update();
    ev.write("b"); // 本帧
    expect(ev.read()).toEqual(["a"]); // 读上一帧
    ev.update();
    expect(ev.read()).toEqual(["b"]); // 帧2 的写，帧3 可读
  });

  it("extend 批量写入 + len 计数", () => {
    const ev = new Events<{ id: number }>();
    ev.extend([{ id: 1 }, { id: 2 }]);
    expect(ev.len).toBe(0); // 本帧不可见
    ev.update();
    expect(ev.len).toBe(2);
    expect(ev.read()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("clear 清空全部（不交换）", () => {
    const ev = new Events<number>();
    ev.write(1);
    ev.update();
    expect(ev.len).toBe(1);
    ev.clear();
    expect(ev.len).toBe(0);
    expect(ev.read()).toEqual([]);
  });

  it("循环多帧：每帧写入 → 下帧可读一次", () => {
    const ev = new Events<number>();
    const readFrames: number[][] = [];
    for (let frame = 0; frame < 3; frame++) {
      ev.write(frame);
      readFrames.push([...ev.read()]); // 帧末前读上一帧
      ev.update();
    }
    expect(readFrames).toEqual([[], [0], [1]]); // 帧1 读空，帧2 读帧1，帧3 读帧2
  });
    it("每帧写入无残留（读 buffer 帧末清空，不累积）", () => {
    const ev = new Events<number>();
    const reads: number[][] = [];
    for (let f = 0; f < 3; f++) {
      ev.write(f * 10);
      ev.update(); // 交换后读 = 刚写的
      reads.push([...ev.read()]);
    }
    expect(reads).toEqual([[0], [10], [20]]);
  });
});
