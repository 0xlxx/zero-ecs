// packages/ecs/__tests__/kill-tracking.test.ts
// drainKilled 多读者游标（Bevy RemovedComponents 等价）——Gherkin 验收

import { describe, it, expect } from "vitest";
import { World, defineComponent } from "@learnvis/ecs";
import type { Entity } from "@learnvis/ecs";

const C = defineComponent("c", { v: 0 });

function killAndFlush(world: World, entity: Entity): void {
  world.destroy(entity);
  (world as unknown as { flushDestroyed(): void }).flushDestroyed();
}

describe("Feature: drainKilled 多读者（每 observer 独立看到全部 kill，帧末重置）", () => {
  it("Scenario: Given 实体销毁——When 两个 observer 各自 drainKilled——Then 两者都看到（不再单消费者）", () => {
    const world = new World();
    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);

    world.setCurrentObserver("sysA");
    const a = world.drainKilled();
    world.setCurrentObserver("sysB");
    const b = world.drainKilled();

    expect(a).toEqual([e]);
    expect(b).toEqual([e]);
  });

  it("Scenario: Given 同 observer 已 drain——When 再 drain（无新 kill）——Then 返回空（游标不重复消费）", () => {
    const world = new World();
    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);

    world.setCurrentObserver("sys");
    expect(world.drainKilled()).toEqual([e]);
    expect(world.drainKilled()).toEqual([]);
  });

  it("Scenario: Given drain 后又有新 kill——When 同 observer 再 drain——Then 只返回新 kill（游标增量）", () => {
    const world = new World();
    const e1 = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e1);

    world.setCurrentObserver("sys");
    expect(world.drainKilled()).toEqual([e1]);

    const e2 = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e2);
    expect(world.drainKilled()).toEqual([e2]);
  });

  it("Scenario: Given 帧末 setCurrentObserver(null)——When 下帧再 kill——Then 未消费的旧 kill 仍可见（双缓冲 2 帧窗口）", () => {
    const world = new World();
    const e1 = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e1);

    world.setCurrentObserver("sys");
    expect(world.drainKilled()).toEqual([e1]);

    // 帧末
    world.setCurrentObserver(null);
    // 下帧新 kill
    const e2 = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e2);
    world.setCurrentObserver("sys");
    expect(world.drainKilled()).toEqual([e2]);
  });

  it("Scenario: Given 系统排在 killer 之前（本帧漏看）——When 下帧再 drain——Then 仍看到该 kill（帧内排序无关）", () => {
    const world = new World();

    // 帧 N：sysA 先跑（并消费空空如也的队列），随后 killer 才销毁实体。
    world.setCurrentObserver("sysA");
    expect(world.drainKilled()).toEqual([]);

    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);

    world.setCurrentObserver(null); // 帧末轮转

    // 帧 N+1：同一系统先跑——双缓冲保证它仍能看到上一帧的 kill。
    world.setCurrentObserver("sysA");
    expect(world.drainKilled()).toEqual([e]);
    expect(world.drainKilled()).toEqual([]);
  });

  it("Scenario: Given kill 已存活 2 帧——When 第 3 帧——Then 事件过期（有界内存）", () => {
    const world = new World();
    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);

    world.setCurrentObserver(null); // 帧 N 末：kill 进入 prev
    world.setCurrentObserver(null); // 帧 N+1 末：无新 kill → 淘汰
    world.setCurrentObserver("late");

    expect(world.drainKilled()).toEqual([]);
  });

  it("Scenario: Given 裸模式（无 observer）——When drainKilled——Then __global__ 游标独立工作", () => {
    const world = new World();
    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);
    expect(world.drainKilled()).toEqual([e]);
    expect(world.drainKilled()).toEqual([]);
  });

  it("Scenario: Given hasKilledEntities——When 本帧有 kill——Then 保持 true 直到帧末（各系统独立消费不漏清理）", () => {
    const world = new World();
    const e = world.spawn([C.create({ v: 1 })]);
    killAndFlush(world, e);

    world.setCurrentObserver("sysA");
    world.drainKilled(); // A 消费
    expect(world.hasKilledEntities).toBe(true); // B 仍可见 → 队列未清

    world.setCurrentObserver(null); // 帧末重置
    expect(world.hasKilledEntities).toBe(false);
  });
});
