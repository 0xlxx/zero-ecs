# @learnvis/ecs

Zero-dependency Entity-Component-System — archetype column storage, event staging, typed queries. Define components with one function call, get full TypeScript inference for free.

## ▣ Installation

```bash
pnpm add @learnvis/ecs
```

## ▣ Quick Start

```ts
import { World, defineComponent, Changed, f } from "@learnvis/ecs";

const Position = defineComponent("position", { x: f.num(), y: f.num() });
const Velocity = defineComponent("velocity", { dx: f.num(), dy: f.num() });

const world = new World();
const player = world.spawn([
  Position({ x: 0, y: 0 }),
  Velocity({ dx: 2, dy: 1 }),
]);

// Query by archetype — all entities with Position AND Velocity
world.query(Position, Velocity).forEach((pos, vel, entity) => {
  world.setComponent(entity, Position({ x: pos.x + vel.dx, y: pos.y + vel.dy }));
});

// Observer-based change detection (per-system tick consumption)
world.setCurrentObserver("movement");
const changed = world.query(Position).filter(Changed(Position)).entities();
```

> 注意：Entity 句柄是 World-local 的，不要跨 World 传递。每个 `new World()` 有独立的实体分配器、generation 表与 archetype 集合。

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

### Archetype column storage

Entities with the same component set share an archetype. Each archetype owns one
column per component kind — `ObjectColumn` for object data, `Float64Column`
(SoA typed arrays) for `schema`-declared numeric fields:

```
entityIndex → { archetypeId, row }
archetype.columns[componentIndex][row] → component data
```

Removal uses swap-and-pop: move the last row into the removed row, then pop.
Component add/remove migrates the entity to the archetype matching its new
component set. There is no separate sparse-set pool: all component kinds use
one of the two column types above (`storage: "sparse"` was removed because it
was never wired into the storage path).

### Structural mutation and destruction

`World.spawn`, `addComponent`, `setComponent`, and `removeComponent` are
immediate operations. `Commands` is the deferred path for callers that need to
stage structural writes; `applyCommands()` flushes that queue. Destroy marks the
handle dead immediately and defers archetype cleanup until `flushDestroyed()`.

Destruction and component removal are separate contracts:

- `drainKilled()` delivers destroyed entities to each observer.
- `removed(T)` reports only explicit `removeComponent(entity, T)` calls.

`query(...).forEach()` is the read-only live-column fast path. Use
`queryMut(...).forEach()` when the callback may structurally mutate the result
set; the mutation-safe snapshot is preserved across `.filter()` and
`.withState()`.

### Archetype matching

Each archetype stores its sorted component-kind list. Queries intersect the
per-kind archetype indexes (seeded from the smallest set) and iterate matching
archetype columns. Candidate sets are cached once a kind spans more than
`CACHE_THRESHOLD` archetypes.

### Observer change tracking

```ts
world.setCurrentObserver("movement");
const changed = world.query(Health).filter(Changed(Health)).entities();
```

`Changed`/`Added` compare the row tick with the observer's last-seen tick and
consume it on read (Bevy-like delta semantics). `world.isAnyDirty(kinds, sinceTick)`
is the O(kinds) fast path used by stage `skipIfClean`.

For independent persistent readers, create a per-query state with
`world.createQueryState()` and bind it with `.withState(state)`. The state is
caller-owned: call `state.forget(entity)` when an entity is retired, or
`state.clear()` when the reader is no longer needed.

## ▣ Resources

```ts
const DataStore = defineResource<Map<string, unknown>>("dataStore");
world.insertResource(DataStore, new Map());
const store = world.resource(DataStore);
world.markResourceChanged(DataStore); // in-place mutation
```

## ▣ World API

```ts
class World {
  // Entity lifecycle
  spawn(components?, overrides?): Entity
  destroy(entity): void
  reserveEntity(): Entity
  isAlive(entity): boolean
  entityCount(): number

  // Component CRUD
  getComponent(entity, factory): Data | undefined
  getComponentEntry(entity, factory): { data, addedTick, changedTick } | undefined
  addComponent(entity, component): void
  setComponent(entity, component): void
  patchComponent(entity, factory, patch): void
  setComponents(factory, entities, patch | patch[]): number
  removeComponent(entity, factory): void
  hasComponent(entity, factory): boolean

  // Query
  query(...factories).forEach((...data, entity) => void)
  queryMut(...factories).filter(...).withState(state).forEach((...data, entity) => void)
  query(...factories).batch((...columns, entities, count) => void)
  query(...factories).entities(): Entity[]
  query(...factories).first(): Entity | undefined
  query(...factories).filter(Changed(T), Added(T), With(T), Without(T))
  removed(T): Entity[] // explicit removeComponent only

  // Resources
  insertResource(factory, data): void
  resource(factory): Data | undefined
  removeResource(factory): void
  hasResource(factory): boolean
  resourceChanged(factory): boolean

  // Frame / lifecycle
  setCurrentObserver(name | null): void
  applyCommands(): void
  flushDestroyed(): void
  drainKilled(): Entity[]
  createQueryState(): QueryState
  lastChangedTick(kind): number
  isAnyDirty(kinds, sinceTick): boolean

  // Introspection
  get tick(): number
  kinds(): string[]
  componentData(entity, kind): Record<string, unknown> | undefined
  dumpEcs(): { entityCount, entities }
}
```

## ▣ Events & deferred commands

```ts
import { Events, Commands } from "@learnvis/ecs";

const events = new Events<{ id: number }>();
events.write({ id: 1 });   // readable next frame
events.update();           // frame-end swap

const cmd = new Commands(world);
cmd.spawn(Health({ current: 50 })).insert(Velocity({ dx: 1 }));
world.applyCommands();
```

## ▣ Extending with custom components

Components are defined by a factory — no declaration merging:

```ts
import { defineComponent, f } from "@learnvis/ecs";

export const Health = defineComponent("health", {
  current: f.num().default(100),
  max: f.num().default(100),
});
```

Raw default objects are also accepted for internal/performance-sensitive
components, but they lose field-schema metadata (validation / JSON / docs).

## ▣ Motivation & Architecture

Implements the ECS storage patterns from Johnson's *Building an ECS* (2025):

- **Ch2.2** Archetype columns — O(1) entity→row lookup, contiguous columns, swap-and-pop removal.
- **Ch2.6** Deferred structural mutations — `Commands` queue + `applyCommands()`; double-buffered `Events`.
- **Ch5.1** Archetype matching — per-kind archetype indexes + And/With/Without candidate intersection.
- **Ch4.1** Dependency-aware scheduling — system access declarations feed the Engine's DAG topological sort.

Zero framework dependency. The World is a plain TypeScript class — usable in browsers, Node.js, or any JS runtime. The Engine layer (`@learnvis/engine`) adds system orchestration, pipeline stages, and rendering on top.

## ▣ Development

```bash
bun install
bun run typecheck   # tsc -p tsconfig.json (NodeNext)
bun run test        # vitest run — 12 files / 199 tests
bun run build       # tsc -p tsconfig.build.json → dist/*.js + *.d.ts
bun run bench       # 10K benchmark suite with snapshot comparison
bun run lint        # oxlint src __tests__
```

Three constraints worth knowing before you touch the source:

- **Relative imports need the `.js` extension** (`./component.js`). The package ships per-file
  compiled output, not a bundle, so an extensionless specifier resolves under bundlers but throws
  `ERR_MODULE_NOT_FOUND` in Node ESM. Both tsconfigs use `NodeNext` so the compiler rejects those
  imports instead of publishing a broken `dist/`.
- **`new Array<T>(n)` is intentional** in the storage hot paths — preallocation without the
  `undefined` fill that `Array.from({ length: n })` performs. `unicorn/no-new-array` is disabled
  in `.oxlintrc.json` for that reason, not to hide debt.
- **Tests run against `src/`** (see `vitest.config.ts`). The published `dist/` is verified
  separately by the CI `Node smoke` step, so a green test run alone does not prove the artifact
  is importable outside a bundler.
