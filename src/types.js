// @flow

import type {GraphQLFieldResolveFn, GraphQLType, GraphQLNamedType} from
  'graphql/type/definition';
import type {GraphQLFieldConfigMap, InputObjectConfigFieldMap,
  GraphQLResolveInfo} from 'graphql';
import type DataLoader from 'dataloader';

export type {GraphQLSchema, GraphQLObjectType, GraphQLField} from 'graphql';
export type {GraphQLFieldResolveFn, GraphQLResolveInfo, GraphQLFieldConfig,
  GraphQLType} from 'graphql/type/definition';
export type {Document, Node, ObjectTypeDefinition, FieldDefinition, Directive,
  Type, NamedType} from 'graphql/language/ast';
export type {ConnectionArguments} from
  'graphql-relay/lib/connection/connectiontypes';

// represents the interface between the GraphQL schema and database backend

export type DatabaseInterface = {
  schema: DatabaseSchema,
  relationships: Relationship[],
  resolveNode: GraphQLFieldResolveFn,
  generateRelationshipResolver: (relationship: Relationship) =>
    GraphQLFieldResolveFn,
  generateRelationshipLoader: (relationship: Relationship) => DataLoader,
}

export type DatabaseSchema = {
  tables: Table[],
  indices: Index[],
}

export type Table = {
  name: string,
  columns: Column[],
  constraints?: Constraint[],
}

export type Index = {
  table: string,
  columns: string[],
}

export type Column = {
  name: string,
  type: ColumnType,
  primaryKey: boolean,
  nonNull: boolean,
  references?: {
    table: string,
    column: string,
  },
}

type Constraint = {
  type: 'unique',
  columns: string[],
}

export type ColumnType = 'uuid' | 'jsonb' | 'varchar(255)' | 'timestamp' |
  'text' | 'integer' | 'double precision' | 'money'

export type Relationship = {
  fieldName: string,
  cardinality: 'singular' | 'plural',
  path: RelationshipSegment[],
}

export type RelationshipSegment = {
  fromType: string,
  toType: string,
  label: string,
  direction: 'in' | 'out',
  cardinality: 'singular' | 'plural',
  nonNull: boolean,
  signature: string,
}

export type RelationshipSegmentPair = {
  in?: RelationshipSegment,
  out?: RelationshipSegment,
}

export type RelationshipSegmentDescription = {
  type: 'join',
  signature: string,
  pair: RelationshipSegmentPair,
  storage: JoinTableDescription,
} | {
  type: 'foreignKey',
  signature: string,
  pair: RelationshipSegmentPair,
  storage: ForeignKeyDescription,
}

export type JoinTableDescription = {
  name: string,
  leftTableName: string,
  rightTableName: string,
  leftColumnName: string,
  rightColumnName: string,
}

export type ForeignKeyDescription = {
  direction: 'in' | 'out',
  table: string,
  referencedTable: string,
  column: string,
  nonNull: boolean,
}

export type RelationshipSegmentDescriptionMap =
  {[key: string]: RelationshipSegmentDescription};

export type TypeMap = {[typeName: string]: GraphQLType};

// represents custom field resolution definitions for graphql object types
// defined using the IDL

export type ObjectTypeFieldResolutionDefinition = {
  name: string,
  fields: {[key: string]: GraphQLFieldResolveFn}
};

export type MutationDefinitionFn = (types: {[key: string]: GraphQLType}) =>
  MutationDefinition;

export type MutationDefinition = {
  name: string,
  inputFields: InputObjectConfigFieldMap,
  outputFields: GraphQLFieldConfigMap,
  mutateAndGetPayload:
    (object: Object, ctx: Object, info: GraphQLResolveInfo) => Object |
    (object: Object, ctx: Object, info: GraphQLResolveInfo) => Promise<Object>
};


// Intermediate representations used in SQL query generation
// this is not intended to represent all possible SQL queries - only the small
// subset we use for relationship resolution

export type Query = {
  table: string,
  joins: Join[],
  condition: Condition,
  limit: ?number,
}

export type Join = {
  table: string,
  condition: {
    left: {table: string, column: string},
    right: {table: string, column: string},
  },
}

export type Condition = {
  table: string,
  column: string,
}
