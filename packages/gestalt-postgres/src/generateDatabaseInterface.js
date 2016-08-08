// @flow
// Generates an internal representation of a PostgreSQL schema from a GraphQL
// type definition AST.

import type {Document, Node, ObjectTypeDefinition, FieldDefinition, Directive,
  Type, NamedType, DatabaseInterface, DatabaseSchema, Table, Enum, Index,
  Column, ColumnType, Relationship, RelationshipSegment,
  RelationshipSegmentPair, JoinTableDescription, ForeignKeyDescription,
  RelationshipSegmentDescription, DatabaseRelevantSchemaInfo,
  GestaltServerConfig} from 'gestalt-utils';
import {plural} from 'pluralize';
import snake from 'snake-case';
import generateNodeResolver from './generateNodeResolver';
import {generateRelationshipResolver, generateRelationshipLoaders} from
  './generateRelationshipResolver';
import {invariant, keyMap, baseType} from 'gestalt-utils';
import DB from './DB';
import REQUIRED_EXTENSIONS from './REQUIRED_EXTENSIONS';



export default function generateDatabaseInterface(
  databaseURL: string,
  schemaInfo: DatabaseRelevantSchemaInfo,
  config?: ?GestaltServerConfig,
): DatabaseInterface {
  const {objectTypes, relationships} = schemaInfo;

  const db = new DB({
    url: databaseURL,
    log: config != null && !!config.development,
  });

  const tables: Table[] = [];
  const enums: Enum[] = [];
  const tablesByName: {[key: string]: Table} = {};
  const indices: Index[] = [];

  // create tables and indexes for object types, take inventory of relationships
  Object.values(objectTypes).forEach(definition => {
    const table = tableFromObjectTypeDefinition(definition);
    tablesByName[table.name] = table;
    tables.push(table);

    indices.push(...indicesFromObjectTypeDefinition(definition));
  });

  // having looked at each type and recorded their relationships, we create
  // normalized descriptions of their relationships
  const segmentDescriptions = segmentDescriptionsFromRelationships(
    relationships
  );
  const segmentDescriptionsBySignature = keyMap(
    segmentDescriptions,
    segment => segment.signature
  );

  // create join tables, foreign key columns, and indices based on the
  // relationship descriptions
  segmentDescriptions.forEach(segment => {
    if (segment.type === 'join') {
      // add join table and indices
      tables.push(joinTableFromDescription(segment.storage));
      indices.push(...joinTableIndicesFromDescription(segment.storage));
    } else {
      // add foreign key and index
      const table = tablesByName[segment.storage.table];
      table.columns.push(columnFromForeignKeyDescription(segment.storage));
      indices.push(indexFromForeignKeyDescription(segment.storage));
    }
  });

  return {
    db,
    schema: {
      tables,
      indices,
      enums,
      extensions: REQUIRED_EXTENSIONS,
    },
    resolveNode: generateNodeResolver(db),
    generateRelationshipResolver: generateRelationshipResolver(
      segmentDescriptionsBySignature,
    ),
    prepareQueryContext: ctx => {
      const loaders = generateRelationshipLoaders(
        db,
        segmentDescriptionsBySignature,
        relationships
      );
      return {...ctx, db, loaders};
    },
  };
}

export function isDatabaseField(definition: FieldDefinition): boolean {
  // Fields with the @virtual directive are not recorded, fields with the
  // @relationship directive generate join tables or foreign keys which are
  // added seperately
  return (
    !definition.directives ||
    !definition.directives.some(
      d => d.name.value === 'virtual' || d.name.value === 'relationship'
    )
  );
}

export function validateDatabaseField(definition: FieldDefinition): void {
  // because we use the seq field for ordering, we can't allow it to be defined
  // as a database field
  invariant(
    definition.name !== 'seq',
    'The `seq` field is reserved by Gestalt and cannot be defined',
  );
}

export function isNonNullType(type: Type): boolean {
  return type.kind === 'NonNullType';
}

export function isListType(type: Type): boolean {
  return (
    type.kind === 'ListType' ||
    (type.kind === 'NonNullType' && type.type.kind === 'ListType')
  );
}

export function tableFromObjectTypeDefinition(
  definition: ObjectTypeDefinition,
): Table {
  const name = tableNameFromTypeName(definition.name.value);
  const columns = [
    // every table gets an auto incrementing field 'seq' used for ordering
    {
      name: 'seq',
      type: 'SERIAL',
      primaryKey: false,
      nonNull: true,
      unique: true,
      defaultValue: null,
      references: null,
    }
  ];

  definition.fields.forEach(field => {
    if (isDatabaseField(field)) {
      validateDatabaseField(field);
      columns.push(columnFromFieldDefintion(field));
    }
  });

  return {name, columns, constraints: []};
}

export function columnFromFieldDefintion(definition: FieldDefinition): Column {
  const isId = definition.name.value === 'id';
  return {
    name: snake(definition.name.value),
    type: columnTypeFromGraphQLType(definition.type),
    primaryKey: isId,
    nonNull: isNonNullType(definition.type),
    unique: definition.directives.some(d => d.name.value === 'unique'),
    defaultValue: isId ? 'gen_random_uuid()' : null,
    references: null,
  };
}

export function columnTypeFromGraphQLType(type: Type): ColumnType {
  if (type.isListType) {
    return 'jsonb';
  }

  switch (baseType(type).name.value) {
    case 'ID':
      return 'uuid';
    case 'String':
      return 'text';
    case 'Int':
      return 'integer';
    case 'Float':
      return 'double precision';
    case 'Date':
      return 'timestamp without time zone';
    case 'Money':
      return 'money';
    case 'SERIAL':
      return 'SERIAL';
    default:
      return 'jsonb';
  }
}

export function indicesFromObjectTypeDefinition(
  definition: ObjectTypeDefinition,
): Index[] {
  const indices = [];
  const table = tableNameFromTypeName(definition.name.value);
  definition.fields.forEach(field => {
    if (
      field.directives &&
      field.directives.some(directive => directive.name.value === 'index') &&
      // a uniqueness constraint implies an index, so if the @unique directive
      // is present we don't need to add an additional one
      !field.directives.some(directive => directive.name.value === 'unique')
    ) {
      indices.push({table, columns: [snake(field.name.value)]});
    }
  });
  return indices;
}

export function segmentDescriptionsFromRelationships(
  relationships: [Relationship]
): RelationshipSegmentDescription[] {
  const segments = flattenedUniqueSegmentsFromRelationships(relationships);

  // create map of segments by taking their signature along the relationship
  // direction
  const segmentMap: {[key: string]: RelationshipSegment[]} = {};
  segments.forEach(segment => {
    const signature = pairingSignatureFromRelationshipSegment(segment);
    segmentMap[signature] = (segmentMap[signature] || []).concat(segment);
  });

  // create RelationshipSegmentDescription objects
  return Object.keys(segmentMap).map(signature => {
    const pair = {};
    const matchingSegments = segmentMap[signature];
    matchingSegments.forEach(segment => pair[segment.direction] = segment);

    if (segmentPairRequiresJoinTable(pair)) {
      return {
        type: 'join',
        signature,
        pair,
        storage: joinTableDescriptionFromRelationshipSegmentPair(pair),
      };
    } else {
      return {
        type: 'foreignKey',
        signature,
        pair,
        storage: foreignKeyDescriptionFromRelationshipSegmentPair(pair),
      };
    }
  });
}

export function pairingSignatureFromRelationshipSegment(
  segment: RelationshipSegment
): string {
  const {fromType, toType, label, direction} = segment;
  return (
    (direction === 'in')
    ? `${toType}|${label}|${fromType}`
    : `${fromType}|${label}|${toType}`
  );
}

export function flattenedUniqueSegmentsFromRelationships(
  relationships: Relationship[]
): RelationshipSegment[] {
  const segmentMap: Map<string, RelationshipSegment> = new Map;
  relationships.forEach(relationship =>
    relationship.path.forEach(segment => {
      const signature = identitySignatureFromRelationshipSegment(segment);
      const existingSegment = segmentMap.get(signature);
      if (existingSegment == null || !existingSegment.nonNull) {
        segmentMap.set(signature, segment);
      }
    })
  );

  return Array.from(segmentMap.values());
}

export function identitySignatureFromRelationshipSegment(
  segment: RelationshipSegment
): string {
  const {fromType, toType, label, direction} = segment;
  return [fromType, toType, label, direction].join('|');
}

export function segmentPairRequiresJoinTable(
  pair: RelationshipSegmentPair
): boolean {
  return (
    (pair.in == null || pair.in.cardinality === 'plural') &&
    (pair.out == null || pair.out.cardinality === 'plural')
  );
}

export function joinTableDescriptionFromRelationshipSegmentPair(
  pair: RelationshipSegmentPair
): JoinTableDescription {
  const left = (pair.out && pair.out.fromType) || (pair.in && pair.in.toType);
  const right = (pair.out && pair.out.toType) || (pair.in && pair.in.fromType);
  const label = (pair.out && pair.out.label) || (pair.in && pair.in.label);

  invariant(
    left && right && label,
    'relationship segment pair must have at least one segment'
  );

  return {
    name: tableNameFromTypeName(`${left}_${label}_${right}`),
    leftTableName: tableNameFromTypeName(left),
    rightTableName: tableNameFromTypeName(right),
    leftColumnName: snake(`${left}_id`),
    rightColumnName: snake(`${label}_${right}_id`),
  };
}

export function joinTableFromDescription(
  description: JoinTableDescription
): Table {
  const {name, leftTableName, rightTableName, leftColumnName,
    rightColumnName} = description;

  return {
    name,
    columns: [
      {
        name: leftColumnName,
        type: 'uuid',
        nonNull: true,
        primaryKey: false,
        unique: false,
        defaultValue: null,
        references: {
          table: leftTableName,
          column: 'id',
        }
      },
      {
        name: rightColumnName,
        type: 'uuid',
        nonNull: true,
        primaryKey: false,
        unique: false,
        defaultValue: null,
        references: {
          table: rightTableName,
          column: 'id',
        },
      },
    ],
    constraints: [
      {
        type: 'UNIQUE',
        columns: [leftColumnName, rightColumnName],
      },
    ],
  };
}

export function joinTableIndicesFromDescription(
  description: JoinTableDescription
): Index[] {
  const {name, rightColumnName} = description;
  return [
    {
      table: name,
      columns: [rightColumnName],
    }
  ];
}

// when considering a segment pair we will use a foreign key if one or both of
// the segments are singular. We decide on which of the two tables to put the
// foreign key using the following rules:

// missing + singular:
//   - add the column to the fromType of the existing segment
// singular + plural:
//   - add the column to the fromType of the singular segment
// singular + singular:
//   - if one segment is non null, add the column to its fromType, otherwise
//     add it to the toType of the out segment.

export function foreignKeyDescriptionFromRelationshipSegmentPair(
  pair: RelationshipSegmentPair
): ForeignKeyDescription {
  let normalType;
  if (pair.in == null) {
    invariant(pair.out);
    normalType = {
      ...pair.out,
      direction: 'in',
      fromType: pair.out.toType,
      toType: pair.out.fromType,
    };
  } else {
    normalType = (
      (
        (pair.out == null) ||
        (pair.in.cardinality === 'plural') ||
        (pair.out.nonNull && !pair.in.nonNull)
      )
      ? pair.in
      : pair.out
    );
  }

  invariant(normalType, 'input pair does not require a foreign key');
  const {label, fromType, toType, direction} = normalType;

  return {
    direction,
    nonNull: (
      (pair.out != null && pair.out.nonNull) ||
      (pair.in != null && pair.in.nonNull)
    ),
    table: tableNameFromTypeName(toType),
    referencedTable: tableNameFromTypeName(fromType),
    column: snake(
      (direction === 'in')
      ? `${label}_${fromType}_id`
      : `${label}_by_${fromType}_id`
    ),
  };
}

export function indexFromForeignKeyDescription(
  description: ForeignKeyDescription
): Index {
  return {
    table: description.table,
    columns: [description.column]
  };
}

export function columnFromForeignKeyDescription(
  description: ForeignKeyDescription
): Column {
  return {
    name: description.column,
    type: 'uuid',
    primaryKey: false,
    nonNull: description.nonNull,
    unique: false,
    defaultValue: null,
    references: {
      table: description.referencedTable,
      column: 'id',
    },
  };
}

export function tableNameFromTypeName(typeName: string): string {
  return snake(plural(typeName));
}
