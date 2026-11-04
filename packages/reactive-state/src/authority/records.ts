import { resourceOf, type Value } from '../program.ts';
import {
  checkValue,
  type DatabaseDefinition,
  defaultOf,
  type FieldDefinition,
  type Table,
} from '../server/schema.ts';
import { digest } from './canonical.ts';

/**
 * A record as the authority answers it, read against the application's declaration: what the
 * declaration says a field holds is what is answered for it, whatever the record keeps.
 */

/**
 * What `field` of a record holds: what the record keeps for it, or the field's default where it
 * keeps nothing, or something the field may no longer hold — written before the declaration
 * changed.
 */
function fieldValue(
  definition: FieldDefinition,
  kept: Readonly<Record<string, unknown>> | undefined,
  field: string,
): Value {
  const value = kept !== undefined && Object.hasOwn(kept, field) ? kept[field] : undefined;
  return checkValue(definition, value) === undefined ? (value as Value) : defaultOf(definition);
}

/** Each of `fields` of a record of `table`, as `fieldValue` reads it, in their order. */
export function valuesOf(
  table: Table,
  kept: Readonly<Record<string, unknown>> | undefined,
  fields: readonly string[] = Object.keys(table.fields),
): Readonly<Record<string, Value>> {
  return Object.fromEntries(
    fields.map((field) => {
      const definition = table.fields[field];
      if (definition === undefined) {
        // The declaration's own names alone are read: its fields, and the public ones among them,
        // which `table()` saw to it are its own.
        throw new Error(`\`${field}\` is none of the table's fields`);
      }
      return [field, fieldValue(definition, kept, field)];
    }),
  );
}

/**
 * The digest of what a declaration says of its tables — their names, their fields, which are public
 * and the store an external one is read through — which what the authority renders from them is
 * kept under: a rendering of another declaration's showed other fields, or read them as something
 * else. A table the authority keeps is digested as it was before tables could be external.
 */
export function declarationDigest(database: DatabaseDefinition): string {
  return digest(
    [...database.tables].map(([name, table]) => {
      return table.external === undefined
        ? [name, table.fields, table.public]
        : [name, table.fields, table.public, table.external];
    }),
  );
}

/**
 * Whether a page without a session may show what `resource` names: a record of a table with public
 * fields. A session's resource is no record.
 */
export function publishes(database: DatabaseDefinition): (resource: string) => boolean {
  return (resource) => {
    const record = resourceOf(resource);
    const table = record === undefined ? undefined : database.tables.get(record.table);
    return table !== undefined && table.public.length > 0;
  };
}
