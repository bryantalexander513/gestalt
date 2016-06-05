// @flow

import generateDatabaseInterface from './generateDatabaseInterface';
import type {DatabaseInterfaceDefinitionFn} from 'gestalt-utils';

export default function gestaltPostgres(
  databaseURL: string
): DatabaseInterfaceDefinitionFn {
  return (objectDefinitions, relationships) =>
    generateDatabaseInterface(databaseURL, objectDefinitions, relationships);
}
