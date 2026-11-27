import { Column, getTableColumns, is, Param, SQL, StringChunk } from 'drizzle-orm';
import {
  getTableConfig,
  type IndexedColumn,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';

import { digest } from '../authority/canonical.ts';
import { type BoundRow, type FieldRef, REFERENCE, type RowWrite, type Value } from '../program.ts';
import {
  boolean,
  type FieldDefinition,
  integer,
  isFieldName,
  type RowField,
  type TableRows,
  text,
} from '../server/schema.ts';
import { qualified, quoted } from './capture.ts';
import { codeOf } from './client.ts';
import type { Queryable } from './digest.ts';
import type { KeyColumn } from './keys.ts';
import { keyDigest } from './reads.ts';
import { valueText } from './values.ts';

/**
 * A row of a table of a Drizzle schema, as a state binds it: the condition `db.<table>.where(…)` is
 * given, read as data. Only `eq`s of the table's own columns, alone or under `and`, that hold a
 * primary key or a unique index whole, name one row whatever the database holds; the others among
 * them are held of each read and each write as well. A condition of any other shape is a fault,
 * and so is one written by a version of Drizzle that spells them otherwise: nothing here guesses.
 *
 * A row's read and its write are one statement each, through the connection the application's
 * Drizzle was given: a read of a render is noted as any of its queries is (`client.ts`), and a
 * write is logged by the table's triggers as any of the application's is.
 */

/** The columns' types a state may hold, as a value of JSON a page sends back the same. */
const INTEGERS = {
  PgInteger: { max: 2_147_483_647, min: -2_147_483_648 },
  PgSmallInt: { max: 32_767, min: -32_768 },
} as const;
/**
 * What the database says of a write, by SQLSTATE: of a unique key held twice, of a right or a policy
 * that refuses it, and of what the application's trigger raised; and the classes of what it refuses
 * of a value — its data, a constraint, a limit of what it can hold.
 */
const SQLSTATE = {
  classes: ['22', '23', '54'],
  data: '22',
  privilege: '42501',
  raised: 'P0001',
  unique: '23505',
} as const;
/** How many chunks Drizzle writes `eq(…)` of, and `and(…)` of more than one condition. */
const CHUNKS = { conjunction: 3, equality: 5 } as const;

/** Each column a condition names, as a statement runs with it: in the order of their names. */
type Named = ReadonlyMap<string, unknown>;

/** The value of a column of `C`, of a state that may bind it: nothing of one it may not. */
type Bindable<C> = C extends {
  readonly _: {
    readonly columnType:
      | 'PgBoolean'
      | 'PgEnumColumn'
      | 'PgEnumObjectColumn'
      | 'PgInteger'
      | 'PgSmallInt'
      | 'PgText'
      | 'PgUUID'
      | 'PgVarchar';
    readonly data: infer T extends Value;
    readonly generated: undefined;
    readonly identity: undefined;
    readonly notNull: true;
  };
}
  ? T
  : never;

/** The columns of `T`, a table, a state may bind: a reference of each, of the column's value. */
export type RowReferences<T> = T extends { readonly _: { readonly columns: infer C } }
  ? {
      readonly [K in keyof C as [Bindable<C[K]>] extends [never] ? never : K]: FieldRef<
        Bindable<C[K]>
      >;
    }
  : never;

/** What a fault of `db.<name>.where` says. */
function refused(name: string, reason: string): TypeError {
  return new TypeError(`db.${name}.where: ${reason}`);
}

/** The text a template wrote at `chunk`, where it wrote some. */
function writtenAt(chunk: unknown): string | undefined {
  return is(chunk, StringChunk) ? chunk.value.join('') : undefined;
}

/** `eq(column, value)`, as Drizzle writes it: a column, ` = ` and a parameter, nothing around them. */
function equalityIn(chunks: readonly unknown[]): readonly [Column, Param] | undefined {
  if (chunks.length !== CHUNKS.equality) return undefined;
  const [before, column, operator, parameter, after] = chunks;
  return writtenAt(before) === '' &&
    writtenAt(operator) === ' = ' &&
    writtenAt(after) === '' &&
    is(column, Column) &&
    is(parameter, Param)
    ? [column, parameter]
    : undefined;
}

/**
 * The conditions of `and(…)`, as Drizzle writes it — of one condition, that one as it is, as `or`
 * writes it of one too, which says the same — and nothing of anything else.
 */
function conjunctionIn(chunks: readonly unknown[]): readonly unknown[] | undefined {
  if (chunks.length === 1) return chunks;
  if (chunks.length !== CHUNKS.conjunction) return undefined;
  const [opening, joined, closing] = chunks;
  if (writtenAt(opening) !== '(' || writtenAt(closing) !== ')' || !is(joined, SQL)) {
    return undefined;
  }
  const parts = joined.queryChunks;
  const separated = parts.every((part, at) => at % 2 === 0 || writtenAt(part) === ' and ');
  return separated ? parts.filter((_, at) => at % 2 === 0) : undefined;
}

/** The `eq`s `condition` holds, as `and` gathers them; nothing of a condition of another shape. */
function equalitiesIn(condition: unknown): readonly (readonly [Column, Param])[] | undefined {
  const found: (readonly [Column, Param])[] = [];
  const pending = [condition];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!is(next, SQL)) return undefined;
    const equality = equalityIn(next.queryChunks);
    const parts = equality === undefined ? conjunctionIn(next.queryChunks) : [];
    if (parts === undefined) return undefined;
    if (equality !== undefined) found.push(equality);
    pending.push(...parts);
  }
  return found.length === 0 ? undefined : found;
}

/** Whether `value` is one a statement runs with as it is: no object a driver would read as JSON. */
function isDriverValue(value: unknown): boolean {
  return ['bigint', 'boolean', 'number', 'string'].includes(typeof value);
}

/** The columns `condition` names of `table`, each with the value a statement runs with. */
function namedBy(name: string, table: PgTable, condition: unknown): Named {
  const equalities = equalitiesIn(condition);
  if (equalities === undefined) {
    throw refused(
      name,
      'a row is named by `eq(column, value)`, alone or under `and`, of no other shape of condition',
    );
  }
  const named = new Map<string, unknown>();
  for (const [column, parameter] of equalities) {
    if (column.table !== table) {
      throw refused(name, `\`${column.name}\` is a column of another table`);
    }
    if (named.has(column.name)) {
      throw refused(name, `\`${column.name}\` is named twice`);
    }
    // Of `null`, which equals nothing, and of a value left out, an encoder may answer anything.
    const given: unknown = parameter.value;
    const value = given === null ? undefined : given;
    const sent = value === undefined ? value : parameter.encoder.mapToDriverValue(value);
    if (!isDriverValue(sent)) {
      throw refused(name, `\`${column.name}\` equals no value a row is named by`);
    }
    named.set(column.name, sent);
  }
  return new Map([...named].toSorted(([one], [other]) => one.localeCompare(other)));
}

/**
 * The groups of columns of `table` that name one row whatever else it holds: a primary key, a unique
 * column or constraint, a unique index — of no condition of its own, and of no expression.
 */
function keyGroupsOf(table: PgTable): readonly (readonly string[])[] {
  const { columns, indexes, primaryKeys, uniqueConstraints } = getTableConfig(table);
  const groups: (readonly string[])[] = [
    ...columns.filter((column) => column.primary || column.isUnique).map(({ name }) => [name]),
    ...primaryKeys.map((key) => key.columns.map(({ name }) => name)),
    ...uniqueConstraints.map((unique) => unique.columns.map(({ name }) => name)),
  ];
  for (const { config } of indexes) {
    const names = config.columns.map((column) =>
      is(column, SQL) ? undefined : (column as IndexedColumn).name,
    );
    if (config.unique && config.where === undefined && !names.includes(undefined)) {
      groups.push(names as readonly string[]);
    }
  }
  return groups;
}

/** What a write may put in `column`, of a type a state may hold; nothing of any other. */
function definitionOf(column: PgColumn): FieldDefinition | undefined {
  switch (column.columnType) {
    case 'PgBoolean': {
      return boolean();
    }
    case 'PgInteger':
    case 'PgSmallInt': {
      return integer(INTEGERS[column.columnType]);
    }
    case 'PgEnumColumn':
    case 'PgEnumObjectColumn':
    case 'PgText':
    case 'PgUUID':
    case 'PgVarchar': {
      return text();
    }
    default: {
      return undefined;
    }
  }
}

/** Why no state binds `column`, the schema's `field`, or nothing where one may. */
function whyNotBound(field: string, column: PgColumn): string | undefined {
  if (!isFieldName(field)) {
    return 'a binding names a column by a letter, then letters, digits or _';
  }
  if (column.generated !== undefined || column.generatedIdentity !== undefined) {
    return 'PostgreSQL generates it, and takes no write';
  }
  if (!column.notNull) {
    return 'it may hold NULL, which no state holds';
  }
  return definitionOf(column) === undefined
    ? `a state holds text, a whole number or a boolean, and no ${column.columnType}`
    : undefined;
}

/** The columns a state may bind, by the names the schema gives them. */
function fieldsOf(columns: Readonly<Record<string, PgColumn>>): Readonly<Record<string, RowField>> {
  const fields: Record<string, RowField> = {};
  for (const [field, column] of Object.entries(columns)) {
    const definition = whyNotBound(field, column) === undefined ? definitionOf(column) : undefined;
    if (definition !== undefined) {
      fields[field] = { column: column.name, definition, labels: column.enumValues };
    }
  }
  return Object.freeze(fields);
}

/** The log's image of the row `named` holds: each key among them, as the log keeps it. */
function imageOf(named: Named, keys: readonly KeyColumn[]): Readonly<Record<string, string>> {
  const image: Record<string, string> = {};
  for (const key of keys) {
    const written = named.has(key.column) ? valueText(key.kind, named.get(key.column)) : undefined;
    if (written !== undefined) image[key.field] = keyDigest(written);
  }
  return Object.freeze(image);
}

/** Whether `error` is the database's refusal of data, which no row of it could hold. */
function isOfData(error: unknown): boolean {
  return String(codeOf(error)).startsWith(SQLSTATE.data);
}

/**
 * What a write that failed with `error` became, where sending it again would answer the same; a
 * fault of anything else, which the page sends again.
 */
function writeRefusedBy(error: unknown): RowWrite {
  const code = String(codeOf(error));
  if (code === SQLSTATE.unique) return 'taken';
  if (code === SQLSTATE.privilege) return 'denied';
  if (code === SQLSTATE.raised || SQLSTATE.classes.some((kind) => code.startsWith(kind))) {
    return 'invalid';
  }
  throw error;
}

/** What reads and writes the rows of one table. */
interface RowAccess {
  readonly connected: () => Queryable;
  readonly fields: Readonly<Record<string, RowField>>;
  readonly keys: readonly KeyColumn[];
  readonly relation: string;
}

/** The condition `named` as a statement writes it, of the parameters from `$first` on. */
function matching(named: Named, first: number): string {
  const columns = [...named.keys()];
  return columns.map((column, at) => `${quoted(column)} = $${String(first + at)}`).join(' AND ');
}

/** The name in the table of the column a state binds as `field`. */
function columnOf({ fields }: RowAccess, field: string): string {
  return fields[field]?.column ?? field;
}

/** What the row `named` holds of `asked`: nothing of no row, or of no value a row could hold. */
async function rowRead(
  access: RowAccess,
  named: Named,
  asked: readonly string[],
): Promise<Readonly<Record<string, Value>> | undefined> {
  const columns = asked.map((field) => quoted(columnOf(access, field))).join(', ');
  const statement = `SELECT ${columns} FROM ${access.relation} WHERE ${matching(named, 1)}`;
  let rows: readonly unknown[];
  try {
    ({ rows } = await access.connected().query(statement, [...named.values()]));
  } catch (error) {
    if (isOfData(error)) return;
    throw error;
  }
  const [row] = rows as readonly (Readonly<Record<string, Value>> | undefined)[];
  if (row === undefined) return;
  return Object.fromEntries(
    asked.map((field) => [field, row[columnOf(access, field)]] as [string, Value]),
  );
}

/**
 * Writes `value` to `field` of the row `named`, where it holds `held` there, if given: as its text,
 * of no collation, which may find what another writer left equal to it.
 */
async function rowWrite(
  access: RowAccess,
  named: Named,
  { field, held, value }: { readonly field: string; readonly held?: Value; readonly value: Value },
): Promise<RowWrite> {
  const column = quoted(columnOf(access, field));
  const values = [value, ...named.values()];
  const guard =
    held === undefined
      ? ''
      : ` AND ${column}::pg_catalog.text COLLATE pg_catalog."C" = $${String(values.length + 1)}`;
  const statement = `UPDATE ${access.relation} SET ${column} = $1 WHERE ${matching(named, 2)}${guard} RETURNING 1`;
  try {
    const { rows } = await access
      .connected()
      .query(statement, held === undefined ? values : [...values, String(held)]);
    return rows.length > 0 ? 'written' : 'absent';
  } catch (error) {
    // A condition's own value may be what the database refuses, of which there is no row.
    if (isOfData(error) && (await rowRead(access, named, [field])) === undefined) return 'absent';
    return writeRefusedBy(error);
  }
}

/** The row `named` holds, as `access` reads and writes it. */
function boundRow(access: RowAccess, named: Named): BoundRow {
  return {
    image: imageOf(named, access.keys),
    read: async (asked) => rowRead(access, named, asked),
    write: async (field, value, held) =>
      rowWrite(access, named, { field, value, ...(held !== undefined && { held }) }),
  };
}

/** What reading a column no state may bind does, of the table `name`: a fault that says why. */
function refusedColumn(name: string, field: string, reason: string): PropertyDescriptor {
  return {
    enumerable: false,
    get: () => {
      throw new TypeError(`db.${name}.where(…).${field}: ${reason}`);
    },
  };
}

/** A reference of each column of the row `id` a state may bind, of the table `name`. */
function referencesOf(
  columns: Readonly<Record<string, PgColumn>>,
  {
    id,
    name,
    named,
    row,
  }: {
    readonly id: string;
    readonly name: string;
    readonly named: Named;
    readonly row: BoundRow;
  },
): Readonly<Record<string, FieldRef>> {
  const references: Record<string, FieldRef> = {};
  for (const [field, column] of Object.entries(columns)) {
    const why = named.has(column.name)
      ? 'it names the row: a write to it would leave the state no row to follow'
      : whyNotBound(field, column);
    if (why === undefined) {
      const reference: FieldRef = { [REFERENCE]: true, field, id, kind: 'field', row, table: name };
      references[field] = Object.freeze(reference);
    } else {
      Object.defineProperty(references, field, refusedColumn(name, field, why));
    }
  }
  return Object.freeze(references);
}

/** The rows of `table`, of the keys `keys`, a state may bind, through what `connected` answers. */
export function rowsOf(
  table: PgTable,
  keys: readonly KeyColumn[],
  connected: () => Queryable,
): TableRows<unknown> {
  const columns = getTableColumns(table) as Readonly<Record<string, PgColumn>>;
  const fields = fieldsOf(columns);
  const groups = keyGroupsOf(table);
  const { name: relation, schema = 'public' } = getTableConfig(table);
  const access = { connected, fields, keys, relation: qualified({ name: relation, schema }) };
  return Object.freeze({
    fields,
    where: (name: string, condition: unknown) => {
      const named = namedBy(name, table, condition);
      if (groups.every((group) => group.some((column) => !named.has(column)))) {
        throw refused(
          name,
          'the columns of the condition hold no key of the table whole: a primary key, a unique column or constraint, or a unique index of no condition and no expression',
        );
      }
      const row = boundRow(access, named);
      // Of the table's name in the database: two stores may each hold this relation and this key.
      const id = digest(['row', name, [...named].map(([key, value]) => [key, String(value)])]);
      return referencesOf(columns, { id, name, named, row });
    },
  });
}
