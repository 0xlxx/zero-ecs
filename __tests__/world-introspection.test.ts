// packages/ecs/__tests__/world-introspection.test.ts
// World 实体内省 API（kinds() / componentData()）——Gherkin 验收（Prefab 快照契约）

import { describe, it, expect } from "vitest";
import { World, defineComponent } from "@learnvis/ecs";

const Position = defineComponent("position", { x: 0, y: 0 });
const Velocity = defineComponent("velocity", { dx: 0, dy: 0 });

describe("Feature: World 实体内省（kinds() / componentData()——Prefab.snapshot 依赖的正式 API）", () => {
  it("Scenario: Given 注册两类组件——When kinds()——Then 返回全部注册 kind（插入序）", () => {
    const world = new World();
    world.spawn([Position.create({ x: 1, y: 2 })]);
    world.spawn([Velocity.create({ dx: 3, dy: 0 })]);
    const kinds = world.kinds();
    expect(kinds).toContain("position");
    expect(kinds).toContain("velocity");
  });

  it("Scenario: Given 实体有组件——When componentData——Then 返回浅拷贝（改拷贝不污染实体）", () => {
    const world = new World();
    const e = world.spawn([Position.create({ x: 1, y: 2 }), Velocity.create({ dx: 3, dy: 0 })]);
    const pos = world.componentData(e, "position")!;
    expect(pos).toEqual({ x: 1, y: 2 });
    // 浅拷贝——修改返回对象不影响实体存储
    pos.x = 999;
    expect(world.componentData(e, "position")!.x).toBe(1);
  });

  it("Scenario: Given 实体缺某组件/kind 未注册——When componentData——Then undefined（安全）", () => {
    const world = new World();
    const e = world.spawn([Position.create({ x: 1, y: 2 })]);
    expect(world.componentData(e, "velocity")).toBeUndefined(); // 实体无该组件
    expect(world.componentData(e, "nope")).toBeUndefined(); // kind 未注册
  });

  it("Scenario: Given 遍历 kinds 读各组件——When 汇总——Then 与 Prefab.snapshot 一致（快照契约）", () => {
    const world = new World();
    const e = world.spawn([Position.create({ x: 5, y: 6 }), Velocity.create({ dx: 7, dy: 0 })]);
    const snapshot: Record<string, unknown> = {};
    for (const kind of world.kinds()) {
      const data = world.componentData(e, kind);
      if (data !== undefined) snapshot[kind] = data;
    }
    expect(snapshot).toEqual({
      position: { x: 5, y: 6 },
      velocity: { dx: 7, dy: 0 },
    });
  });
});
