// packages/ecs/src/index.ts — @learnvis/ecs barrel exports

export type { Entity } from "./entity";
export { defineComponent, defineResource, fieldMeta } from "./component";
export type {
  Component,
  ComponentOf,
  ComponentFactory,
  ResourceFactory,
  DataOf,
  FieldSchema,
  FieldsToData,
} from "./component";
export { f } from "./field";
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
} from "./field";
export {
  parseFields,
  fieldCatalog,
  defaultsFromFields,
  hasBindableFields,
} from "./field";
export { Changed, Added, With, Without } from "./query";
export type { Query, QueryFilter } from "./query";
export { SparseSetColumn } from "./storage";
export { World } from "./world";
export { Commands, EntityCommands } from "./commands";

export { Events } from "./events.js";
