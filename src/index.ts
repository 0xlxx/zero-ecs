// packages/ecs/src/index.ts — @learnvis/ecs barrel exports

export type { Entity } from "./entity.js";
export { defineComponent, defineResource, fieldMeta } from "./component.js";
export type {
  Component,
  ComponentOf,
  ComponentFactory,
  ResourceFactory,
  DataOf,
  FieldSchema,
  FieldsToData,
} from "./component.js";
export { f } from "./field.js";
export type {
  FieldDesc,
  StrDesc,
  NumDesc,
  IntDesc,
  BoolDesc,
  HexDesc,
  Vec3Desc,
  TupleDesc,
  ArrayDesc,
  MapDesc,
  EntityRefDesc,
  UnionDesc,
  FieldError,
  FieldResult,
  FieldCatalogEntry,
} from "./field.js";
export {
  parseFields,
  fieldCatalog,
  defaultsFromFields,
  hasBindableFields,
} from "./field.js";
export { Changed, Added, With, Without, QueryState } from "./query.js";
export type { Query, QueryFilter } from "./query.js";
export { World } from "./world.js";
export { Commands, EntityCommands } from "./commands.js";

export { Events } from "./events.js";
