// Events<T> 双缓冲（Bevy Events<T> 语义）——Gherkin 验收（跨帧数据流契约）

import { describe, it, expect } from "vitest";
import { Events } from "../src/index.js";

describe("Feature: Events<T> 事件双缓冲（写本帧不可读，update 后下一帧可读）", () => {
  it("Scenario: Given 本帧写入 1,2——When 本帧 read——Then 空（防写者读回自己）——When update——Then 读到 [1,2]", () => {
    const ev = new Events<number>();
    ev.write(1);
    ev.write(2);
    expect(ev.read()).toEqual([]); // 本帧不可见（防写者读回自己）
    ev.update();
    expect(ev.read()).toEqual([1, 2]);
  });

  it("Scenario: Given 帧1 写 a 帧2 写 b——When 逐帧 update——Then 各帧读到上一帧（延迟一帧）", () => {
    const ev = new Events<string>();
    ev.write("a");
    ev.update();
    ev.write("b"); // 本帧
    expect(ev.read()).toEqual(["a"]); // 读上一帧
    ev.update();
    expect(ev.read()).toEqual(["b"]); // 帧2 的写，帧3 可读
  });

  it("Scenario: Given extend 批量写——When update——Then len 计数 + 全量可读（批量写入契约）", () => {
    const ev = new Events<{ id: number }>();
    ev.extend([{ id: 1 }, { id: 2 }]);
    expect(ev.len).toBe(0); // 本帧不可见
    ev.update();
    expect(ev.len).toBe(2);
    expect(ev.read()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("Scenario: Given 已有事件——When clear——Then 清空全部（不交换）", () => {
    const ev = new Events<number>();
    ev.write(1);
    ev.update();
    expect(ev.len).toBe(1);
    ev.clear();
    expect(ev.len).toBe(0);
    expect(ev.read()).toEqual([]);
  });

  it("Scenario: Given 连续 3 帧各写一事件——When 帧末前读——Then 每帧读到上一帧事件（循环多帧）", () => {
    const ev = new Events<number>();
    const readFrames: number[][] = [];
    for (let frame = 0; frame < 3; frame++) {
      ev.write(frame);
      readFrames.push([...ev.read()]); // 帧末前读上一帧
      ev.update();
    }
    expect(readFrames).toEqual([[], [0], [1]]); // 帧1 读空，帧2 读帧1，帧3 读帧2
  });

  it("Scenario: Given 每帧写——When update 后读——Then 无残留累积（读 buffer 帧末清空）", () => {
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
