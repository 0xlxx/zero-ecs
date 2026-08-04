# @learnvis/ecs

Zero-dependency Entity-Component-System — sparse set storage, event staging, archetype queries. Define components with one function call, get full TypeScript inference for free.

## ▣ Installation

```bash
pnpm add @learnvis/ecs
```

## ▣ Quick Start

```ts
import { World, defineComponent, Position2D, Velocity } from "@learnvis/ecs";

// Define a custom component — types are fully inferred
const Health = defineComponent("health", { current: 100, max: 100 });

const world = new World();

// Spawn entities with components
const player = world.spawn([
  Position2D.create({ x: 0, y: 0 }),
  Velocity.create({ dx: 2, dy: 1 }),
  Health.create({ current: 80, max: 100 }),
]);

// Query by archetype — all entities with Position2D AND Velocity
for (const e of world.query.all(Position2D, Velocity)) {
  const pos = world.getComponent(e, Position2D);
  const vel = world.getComponent(e, Velocity);
  if (pos && vel) {
    world.setComponent(e, Position2D.create({ x: pos.x + vel.dx, y: pos.y + vel.dy }));
  }
}

// Observer-based change detection
world.setCurrentObserver("movement");
world.beginFrame();
// ... systems run, write components ...
const changed = world.query.changed(Position2D); // only entities changed this frame
world.endFrame();
```

## ▣ Core concepts

### Component factory — `defineComponent(name, defaults)`

A component is data, not a class. `defineComponent` returns a typed factory — pass it to World methods and TypeScript infers everything:

```ts
const Health = defineComponent("health", { current: 100, max: 100 });
//     ^? ComponentFactory<{ current: number; max: number }>

const c = Health.create({ current: 50 });
//      ^? ComponentOf<{ current: number; max: number }>
//         => { type: "health", current: 50, max: 100 }

// World methods are fully typed through the factory:
const h = world.getComponent(e, Health);
//      ^? { current: number; max: number } | undefined
```

**No declaration merging needed.** Users in any package call `defineComponent()` — the dynamic registry handles bit assignment and pool creation at runtime.

### Sparse set storage

Each component kind gets a sparse set pool (Johnson 2025, Ch2.2):

```
sparse[entity] → dense index  (O(1) lookup)
dense[index]   → component data (contiguous, cache-friendly)
entities[index] → entity ID
```

Swap-and-pop removal: swap the last element into the deleted slot, pop the end. O(1) with zero fragmentation.

### Event staging

All structural mutations (spawn, destroy, add/remove component) are queued during system execution. `sync()` flushes them to pools. This guarantees stable iteration — queries return `Entity[]` snapshots that don't change mid-loop.

```
                ┌─ spawn ─┐
writeComponent ─┤         ├─→ event queue ─→ sync() ─→ pools
                └─ destroy┘
```

### Archetype signatures

Each entity has a bitset signature of its component kinds. Queries use signature matching — `(sig & mask) === mask` — to find entities that have all requested components. No per-entity iteration over component lists.

### Observer change tracking

`world.query.changed(Position2D)` returns only entities whose Position2D `changedTick` advanced since this observer last saw it. The observer marks entities as "seen" on read, so each call is delta-only. Engine sets the observer name before each system runs.

**`isAnyDirty(kinds, sinceTick)`** — O(kinds) check via per-kind `_lastChangedTick`. Used by Engine to skip entire pipeline stages when nothing relevant changed. No per-entity scan.

## ▣ Built-in components

| Factory | Kind | Defaults |
|---------|------|----------|
| `Position3D` | `position3D` | `{ x: 0, y: 0, z: 0 }` |
| `Position2D` | `position2D` | `{ x: 0, y: 0 }` |
| `Velocity` | `velocity` | `{ dx: 0, dy: 0 }` |
| `Rotate` | `rotate` | `{ angle: 0, cx: 0, cy: 0 }` |
| `Matrix2D` | `matrix2D` | `{ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }` |
| `Scale` | `scale` | `{ value: 1 }` |
| `Opacity` | `opacity` | `{ value: 1 }` |
| `Thickness` | `thickness` | `{ value: 0.015 }` |
| `Size` | `size` | `{ value: 8 }` |
| `UserId` | `userId` | `{ value: "" }` |
| `Disposing` | `disposing` | `{ timestamp: 0 }` |
| `Color` | `color` | `{ value: 0xe06b38 }` |
| `Emissive` | `emissive` | `{ value: 0 }` |
| `Wireframe` | `wireframe` | `{}` |
| `FillMaterial` | `fillMaterial` | `{}` |
| `CameraComp` | `camera` | `{ active, position, target, fov, ortho, ... }` |

### Tween components

| Factory | Target | from/to type |
|---------|--------|-------------|
| `TweenPosition` | `Position2D` | `{ x, y }` |
| `TweenScale` | `Scale` | `number` |
| `TweenColor` | `Color` | `number` (0xRRGGBB) |

### Easing & loop constants

```ts
import { Easing, LoopMode } from "@learnvis/ecs";
// Easing.Linear, .EaseInQuad, .EaseOutQuad, .EaseInOutQuad,
//   .EaseInCubic, .EaseOutCubic, .EaseInOutCubic
// LoopMode.Once, .Repeat, .PingPong
```

## ▣ World API

```ts
class World {
  // Entity lifecycle
  spawn(components?, overrides?): Entity
  destroy(entity): void
  isAlive(entity): boolean
  entityCount(): number

  // Component CRUD
  getComponent(entity, factory): Data | undefined
  getComponentEntry(entity, factory): { data, addedTick, changedTick } | undefined
  setComponent(entity, component): void
  addComponent(entity, component): void       // throws if already exists
  patchComponent(entity, factory, patch): void // read → merge → write
  removeComponent(entity, factory): void
  hasComponent(entity, factory): boolean

  // Change detection
  didAdd(entity, factory): boolean
  didChange(entity, factory): boolean

  // Query (returns Entity[] snapshots)
  query.all(...factories): Entity[]            // AND — all kinds present
  query.except(kind, without): Entity[]         // has kind, not without
  query.added(factory): Entity[]                // added since last seen
  query.changed(...factories): Entity[]          // any changed since last seen

  // Lifecycle
  beginFrame(): void     // enable staging
  endFrame(): void       // disable staging
  sync(): void           // flush event queue → pools
  setCurrentObserver(name): void

  // Introspection
  tick: number
  isAnyDirty(kinds, sinceTick): boolean
  entityByUserId(id): Entity | undefined
  dumpEcs(): { entityCount, entities, eventQueue }
}
```

## ▣ Extending with custom components

No module augmentation. Call `defineComponent` in your own package:

```ts
import { defineComponent, TweenState } from "@learnvis/ecs";

export const Health = defineComponent("health", { current: 100, max: 100 });

// Generic constraint for tween-compatible components:
export const TweenOpacity = defineComponent<{ from: number; to: number } & TweenState>(
  "tweenOpacity",
  { elapsed: 0, duration: 0, easing: "linear", loop: "once", from: 1, to: 0 },
);
```

## ▣ Motivation & Architecture

Implements the ECS storage patterns from Johnson's *Building an ECS* (2025):

- **Ch2.2** Sparse set — O(1) lookup, contiguous dense arrays, swap-and-pop removal.
- **Ch2.6** Event staging — queue structural mutations, flush at sync boundaries. Iteration is always stable.
- **Ch5.1** Archetype signatures — bitset per entity, query matches via `(sig & mask) === mask`.
- **Ch4.1** Dependency-aware scheduling — system access declarations feed the Engine's DAG topological sort.

Zero framework dependency. The World is a plain TypeScript class — usable in browsers, Node.js, or any JS runtime. The Engine layer (`@learnvis/engine`) adds system orchestration, pipeline stages, and rendering on top.
