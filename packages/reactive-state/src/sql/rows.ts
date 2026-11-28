import { Column, getTableColumns, is, Param, SQL, StringChunk, type Table } from 'drizzle-orm';

import { digest } from '../authority/canonical.ts';
import { type BoundRow, type FieldRef, REFERENCE, type RowWrite, type Value } from '../program.ts';
import {
  type FieldDefinition,
  isFieldName,
  type RowField,
  type TableRows,
} from '../server/schema.ts';

/**
 * A row of a table of a Drizzle schema, as a state binds it: the condition `db.<table>.where(…)` is
 * given, read as data. Only `eq`s of the table's own columns, alone or under `and`, that hold a
 * primary key or a unique index whole, name one row whatever the database holds; the others among
 * them are held of each read and each write as well. A condition of any other shape is a fault,
 * and so is one written by a version of Drizzle that spells them otherwise: nothing here guesses.
 *
 * A row's read and its write are one statement each, through the connection the application's
 * Drizzle was given, as its dialect writes them (`RowDialect`): a read of a render is noted as any
 * of its queries is, and a write is logged by the table's triggers as any of the application's is.
 * What a column holds is what Drizzle reads and writes of it, as `mapFromDriverValue` and
 * `mapToDriverValue` say: of SQLite, a boolean is an integer.
 */

/** How many chunks Drizzle writes `eq(…)` of, and `and(…)` of more than one condition. */
const CHUNKS = { conjunction: 3, equality: 5 } as const;

/** Each column a condition names, as a statement runs with it: in the order of their names. */
export type Named = ReadonlyMap<string, unknown>;

/** What a table declares of its keys, as each dialect's `getTableConfig` answers it. */
interface TableKeys {
  readonly columns: readonly Pick<Column, 'isUnique' | 'name' | 'primary'>[];
  readonly indexes: readonly {
    readonly config: {
      readonly columns: readonly unknown[];
      readonly unique: boolean;
      readonly where?: unknown;
    };
  }[];
  readonly primaryKeys: readonly { readonly columns: readonly { readonly name: string }[] }[];
  readonly uniqueConstraints: readonly {
    readonly columns: readonly { readonly name: string }[];
  }[];
}

/** One write, as a statement runs with it: of the column, to `value`, where it holds `held`. */
export interface RowUpdate {
  readonly column: string;
  readonly value: unknown;
  readonly held?: Value;
}

/** What a table's rows are read and written by, as its database's dialect writes them. */
export interface RowDialect {
  readonly keys: TableKeys;
  /** What a write may put in `column`, of a type a state may hold; nothing of any other. */
  readonly definitionOf: (column: Column) => FieldDefinition | undefined;
  /** What the change log keeps of the row `named` holds, of the keys among them. */
  readonly imageOf: (named: Named) => Readonly<Record<string, string>>;
  /** What the row holds of `columns`: nothing of no row, or of no value a row could hold. */
  readonly read: (
    named: Named,
    columns: readonly string[],
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Writes the row, as `RowWrite` says it came to; a fault of anything else. */
  readonly write: (named: Named, update: RowUpdate) => Promise<RowWrite>;
}

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
      | 'PgVarchar'
      | 'SQLiteBoolean'
      | 'SQLiteInteger'
      | 'SQLiteText';
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
function namedBy(name: string, table: Table, condition: unknown): Named {
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

/** The name of a column an index holds; nothing of an expression. */
function indexedName(column: unknown): string | undefined {
  if (typeof column !== 'object' || column === null || is(column, SQL)) return undefined;
  const name: unknown = Reflect.get(column, 'name');
  return typeof name === 'string' ? name : undefined;
}

/**
 * The groups of columns a table declares that name one row whatever else it holds: a primary key, a
 * unique column or constraint, a unique index — of no condition of its own, and of no expression.
 */
function keyGroupsOf(keys: TableKeys): readonly (readonly string[])[] {
  const { columns, indexes, primaryKeys, uniqueConstraints } = keys;
  const groups: (readonly string[])[] = [
    ...columns.filter((column) => column.primary || column.isUnique).map(({ name }) => [name]),
    ...primaryKeys.map((key) => key.columns.map(({ name }) => name)),
    ...uniqueConstraints.map((unique) => unique.columns.map(({ name }) => name)),
  ];
  for (const { config } of indexes) {
    const names = config.columns.map((column) => indexedName(column));
    if (config.unique && config.where === undefined && !names.includes(undefined)) {
      groups.push(names as readonly string[]);
    }
  }
  return groups;
}

/** Why no state binds `column`, the schema's `field`, or nothing where one may. */
function whyNotBound(dialect: RowDialect, field: string, column: Column): string | undefined {
  if (!isFieldName(field)) {
    return 'a binding names a column by a letter, then letters, digits or _';
  }
  if (column.generated !== undefined || column.generatedIdentity !== undefined) {
    return 'the database generates it, and takes no write';
  }
  if (!column.notNull) {
    return 'it may hold NULL, which no state holds';
  }
  return dialect.definitionOf(column) === undefined
    ? `a state holds text, a whole number or a boolean, and no ${column.columnType}`
    : undefined;
}

/** The columns a state may bind, by the names the schema gives them. */
function fieldsOf(
  dialect: RowDialect,
  columns: Readonly<Record<string, Column>>,
): Readonly<Record<string, RowField>> {
  const fields: Record<string, RowField> = {};
  for (const [field, column] of Object.entries(columns)) {
    const bound = whyNotBound(dialect, field, column) === undefined;
    const definition = bound ? dialect.definitionOf(column) : undefined;
    if (definition !== undefined) {
      fields[field] = { column: column.name, definition, labels: column.enumValues };
    }
  }
  return Object.freeze(fields);
}

/** Whether a column's `value` is one a state may hold: SQLite keeps any value in any column. */
function isValue(value: unknown): value is Value {
  return ['boolean', 'number', 'string'].includes(typeof value);
}

/** The row `named` holds, of the table's `columns`, as `dialect` reads and writes it. */
function boundRow(
  dialect: RowDialect,
  columns: Readonly<Record<string, Column>>,
  named: Named,
): BoundRow {
  const columnOf = (field: string): Column => {
    const column = columns[field];
    if (column === undefined) throw new TypeError(`\`${field}\` is no column of the row.`);
    return column;
  };
  return {
    image: dialect.imageOf(named),
    read: async (asked) => {
      const read = await dialect.read(
        named,
        asked.map((field) => columnOf(field).name),
      );
      if (read === undefined) return;
      const values = new Map<string, Value>();
      for (const field of asked) {
        const column = columnOf(field);
        const held = read[column.name];
        if (isValue(held)) values.set(field, column.mapFromDriverValue(held) as Value);
      }
      return Object.fromEntries(values);
    },
    write: async (field, value, held) => {
      const column = columnOf(field);
      return dialect.write(named, {
        column: column.name,
        value: column.mapToDriverValue(value),
        ...(held !== undefined && { held: column.mapToDriverValue(held) as Value }),
      });
    },
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
  dialect: RowDialect,
  columns: Readonly<Record<string, Column>>,
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
      : whyNotBound(dialect, field, column);
    if (why === undefined) {
      const reference: FieldRef = { [REFERENCE]: true, field, id, kind: 'field', row, table: name };
      references[field] = Object.freeze(reference);
    } else {
      Object.defineProperty(references, field, refusedColumn(name, field, why));
    }
  }
  return Object.freeze(references);
}

/** The rows of `table` a state may bind, as `dialect` reads and writes them. */
export function rowsOf(table: Table, dialect: RowDialect): TableRows<unknown> {
  const columns: Readonly<Record<string, Column>> = getTableColumns(table);
  const groups = keyGroupsOf(dialect.keys);
  return Object.freeze({
    fields: fieldsOf(dialect, columns),
    where: (name: string, condition: unknown) => {
      const named = namedBy(name, table, condition);
      if (groups.every((group) => group.some((column) => !named.has(column)))) {
        throw refused(
          name,
          'the columns of the condition hold no key of the table whole: a primary key, a unique column or constraint, or a unique index of no condition and no expression',
        );
      }
      const row = boundRow(dialect, columns, named);
      // Of the table's name in the database: two stores may each hold this relation and this key.
      const id = digest(['row', name, [...named].map(([key, value]) => [key, String(value)])]);
      return referencesOf(dialect, columns, { id, name, named, row });
    },
  });
}
