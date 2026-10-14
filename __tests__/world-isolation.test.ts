// World isolation BDD — entity allocator/generation 必须 per-World
//
// 回归：全局 _generations/_freeSlots 曾让 World A 认为 World B 的实体存活，
// 并在销毁/复用 slot 时互相污染。

import { describe, expect, it } from "vitest";
import { World, defineComponent, defineResource, f } from "zero-ecs";

const Marker = defineComponent("worldIsolationMarker", { value: f.num() });

describe("Feature: World 实体隔离", () => {
  it("Scenario: Given 两个 World — When A spawn — Then 只有 A 认为实体存活", () => {
    const a = new World();
    const b = new World();
    const entity = a.spawn([Marker({ value: 1 })]);

    expect(a.isAlive(entity)).toBe(true);
    expect(b.isAlive(entity)).toBe(false);
  });

  it("Scenario: Given A 的实体已销毁 — When B spawn 复用 slot — Then A 不接受 B 的句柄", () => {
    const a = new World();
    const b = new World();
    const old = a.spawn([Marker({ value: 1 })]);
    a.destroy(old);
    a.flushDestroyed();

    const bEntity = b.spawn([Marker({ value: 2 })]);
    expect(a.isAlive(bEntity)).toBe(false);
    expect(b.isAlive(bEntity)).toBe(true);

    a.addComponent(bEntity, Marker({ value: 999 }));
    expect(a.getComponent(bEntity, Marker)).toBeUndefined();
    expect(b.getComponent(bEntity, Marker)?.value).toBe(2);
  });

  it("Scenario: Given 两 World 各自首个实体 — Then handle 是 world-local，各 World 只解释自己的实体", () => {
    const a = new World();
    const b = new World();
    const aEntity = a.spawn([Marker({ value: 1 })]);
    const bEntity = b.spawn([Marker({ value: 2 })]);

    // 两个 World 都从 slot 0 开始，packed handle 数值可能相同。
    // 契约：handle 只能传给创建它的 World；跨 World 传递是未定义行为。
    expect(a.isAlive(aEntity)).toBe(true);
    expect(b.isAlive(bEntity)).toBe(true);
    expect(a.getComponent(aEntity, Marker)?.value).toBe(1);
    expect(b.getComponent(bEntity, Marker)?.value).toBe(2);
  });

  it("Scenario: Given 两 World 各有 resource — When A remove — Then B resource 保持不变", () => {
    const a = new World();
    const b = new World();
    const R = defineResource<{ value: number }>("worldIsolationResource");
    a.insertResource(R, { value: 1 });
    b.insertResource(R, { value: 2 });

    a.removeResource(R);
    expect(a.resource(R)).toBeUndefined();
    expect(b.resource(R)?.value).toBe(2);
  });

  it("Scenario: Given 两 World 各有实体 — When B destroy — Then A 实体/查询不受影响", () => {
    const a = new World();
    const b = new World();
    const aEntity = a.spawn([Marker({ value: 10 })]);
    const bEntity = b.spawn([Marker({ value: 20 })]);

    b.destroy(bEntity);
    b.flushDestroyed();

    expect(a.isAlive(aEntity)).toBe(true);
    expect(a.query(Marker).entities()).toEqual([aEntity]);
    expect(b.query(Marker).entities()).toEqual([]);
  });
});
