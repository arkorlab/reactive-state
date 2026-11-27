import { type BoundRow, type FieldRef, isFieldRef, type Value } from '../program.ts';
import { type DatabaseDefinition, defaultOf, isRecordId } from '../server/schema.ts';
import type { Dependencies } from './dependencies.ts';
import { renderEvaluation, type Scope } from './evaluation.ts';
import type { StateOrigin } from './skeleton.ts';

/**
 * What a component's states read of the rows they bind (`db.<table>.where(…)`): each row once, for
 * all its states bind of it, in an evaluation of the render's own — so that the read is noted as
 * what the render depends on, as a query of the component's code is, and held to the call's time.
 * The component's own evaluation has settled by then: it answered what it binds, not what that holds.
 */

/** What each row holds of what the states bind, by the reference's id: nothing where none is. */
export type RowValues = ReadonlyMap<string, Readonly<Record<string, Value>> | undefined>;

/** What `states`, a component's, bind of rows: each row by its id, with the fields it is asked. */
function rowsAsked(
  states: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, { readonly row: BoundRow; readonly fields: readonly string[] }> {
  const asked = new Map<string, { readonly row: BoundRow; readonly fields: string[] }>();
  for (const state of Object.values(states)) {
    if (isFieldRef(state) && state.row !== undefined) {
      const fields = asked.get(state.id)?.fields ?? [];
      if (!fields.includes(state.field)) fields.push(state.field);
      asked.set(state.id, { fields, row: state.row });
    }
  }
  return asked;
}

/** Reads what `states` bind of rows, noted in `track`, each read told to `queried`. */
export async function rowValues(
  scope: Scope,
  states: Readonly<Record<string, unknown>>,
  track: Dependencies,
  queried: () => void,
): Promise<RowValues> {
  const values = new Map<string, Readonly<Record<string, Value>> | undefined>();
  const asked = rowsAsked(states);
  if (asked.size > 0) {
    await scope.call.run(renderEvaluation(scope, track, queried), async () => {
      for (const [id, { fields, row }] of asked) {
        values.set(id, await row.read(fields));
      }
    });
  }
  return values;
}

/**
 * Where a state a field reference makes comes from: the field it binds — one the database declares,
 * of a record that may be, whose record is read — or of a row, the column it binds and what the row
 * holds there, read with the rendering: the column's default where no row is (`rows`).
 */
export function boundOrigin(
  tables: DatabaseDefinition['tables'],
  {
    component,
    dependencies,
    key,
    rows,
  }: {
    readonly component: string;
    readonly dependencies: Dependencies;
    readonly key: string;
    readonly rows: RowValues;
  },
  state: FieldRef,
): StateOrigin {
  const { field, id, row, table: name } = state;
  const table = tables.get(name);
  const declared = row === undefined ? table?.fields : table?.rows?.fields;
  if (declared === undefined || !Object.hasOwn(declared, field) || !isRecordId(id)) {
    throw new Error(
      `${component} binds \`${key}\` to ${name}/${id}.${field}, which the database does not declare.`,
    );
  }
  const bound = { field, id, table: name };
  if (row === undefined) {
    dependencies.record(name, id);
    return { field: bound };
  }
  const column = table?.rows?.fields[field];
  const value = rows.get(id)?.[field] ?? (column && defaultOf(column.definition));
  return { field: { ...bound, ...(value !== undefined && { value }) } };
}
