import { isJson } from '../authority/canonical.ts';
import { type FieldRef, type Json, REFERENCE, type Value } from '../program.ts';
import { currentEvaluation, type Entry, type Evaluation } from './context.ts';

/**
 * The application's database as it declares it (`@/db`), and what its modules read and write it
 * through while the authority evaluates them. The authority keeps every record; the declaration
 * says which tables there are, what each field holds — and so what a write may put there — which
 * fields a page without a session may show, which fields no two records of a table may hold alike,
 * and the records the authority starts with. A table the declaration names `external` is none of
 * the authority's: its records are a database of the application's own, which the authority reads
 * through the store its host gives it by that name, and follows the change log of — read-only to
 * the application's components and operations alike, as its own code writes it.
 */

/** The longest text a field may hold, in UTF-16 units, as `<input maxLength>` counts them. */
export const MAX_TEXT_LENGTH = 2000;

const NAME = /^[A-Za-z]\w{0,63}$/u;
const RECORD_ID = /^[\w-]{1,64}$/u;
/**
 * Names no table may take: the authority's own resources (`session`), and the database's own
 * method (`db.transaction`), which a table of that name would hide.
 */
const RESERVED_TABLES: ReadonlySet<string> = new Set(['session', 'transaction']);

/** The type of a field's value, which a field carries in its type alone. */
declare const FIELD_VALUE: unique symbol;

interface TextDefinition {
  readonly type: 'text';
  readonly maxLength: number;
  readonly default: string;
}

interface BooleanDefinition {
  readonly type: 'boolean';
  readonly default: boolean;
}

interface IntegerDefinition {
  readonly type: 'integer';
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** A document an external table's store answers whole, as JSON: `null` where it holds none. */
interface JsonDefinition {
  readonly type: 'json';
  readonly default: null;
}

export type FieldDefinition =
  | BooleanDefinition
  | IntegerDefinition
  | JsonDefinition
  | TextDefinition;

/** A field of a table: what it holds, with the type of its value for the application's code. */
export type Field<T extends Json> = FieldDefinition & { readonly [FIELD_VALUE]?: T };

type Fields = Readonly<Record<string, Field<Json>>>;

/** The type of the value a field holds. */
export type FieldType<F> = F extends Field<infer T> ? T : never;

/** A record as the application reads it: its id and every field. */
export type RecordOf<F extends Fields> = {
  readonly [K in keyof F]: FieldType<F[K]>;
} & { readonly id: string };

/** The fields a query may ask of and order by: each but a document (`json()`). */
type Comparable<F extends Fields> = {
  readonly [K in keyof F]: FieldType<F[K]> extends Value ? K : never;
}[keyof F];

/**
 * What a query asks of a record: each field it names equal to the value given — the record's `id`
 * too — and all of them together. A field given `undefined` is not asked of, as a condition that
 * is there in one branch of the application's code and not in the other leaves it.
 */
export type Where<F extends Fields> = {
  readonly [K in Comparable<F>]?: FieldType<F[K]> | undefined;
} & { readonly id?: string | undefined };

/** The fields a query answers of each record, its `id` among them where it is named. */
export type Select<F extends Fields> = Partial<Readonly<Record<keyof F | 'id', true>>>;

/**
 * A record as a query that selects `S` answers it: the fields it selects, and nothing else. A field
 * `S` may leave out — any, of a selection typed `Select<F>` — is one the record may not hold.
 */
export type Selected<F extends Fields, S> = {
  readonly [K in keyof S as K extends keyof F | 'id' ? K : never]: K extends 'id'
    ? string
    : FieldType<F[K & keyof F]>;
};

type Sortable<F extends Fields> = (Comparable<F> & string) | 'id';

/** One key of an order: a field, or `id`, ascending or descending. One key to each. */
export type Order<F extends Fields> = {
  readonly [K in Sortable<F>]: Readonly<Record<K, 'asc' | 'desc'>>;
}[Sortable<F>];

export interface Query<F extends Fields> {
  readonly where: Where<F>;
  /** Each key in turn, ties broken by the next, and the last tie by `id`, ascending. */
  readonly orderBy?: readonly Order<F>[];
  /** The most records answered, the first of them in that order: every one where none is given. */
  readonly limit?: number;
}

/** A record's fields as a write gives them: those it leaves out of a new record hold their default. */
export type Writable<F extends Fields> = { readonly [K in keyof F]?: FieldType<F[K]> };

export interface Table<F extends Fields = Fields> {
  readonly fields: F;
  /**
   * The fields a page rendered without a session may show (`publicView`). Names alone: a table is
   * one of any database's whatever its fields are called (`table()` checks they are its own).
   */
  readonly public: readonly string[];
  /** The groups of fields no two records of the table may hold the same values of. */
  readonly unique: readonly (readonly string[])[];
  /**
   * The store the table's records are read through, by the name its host gives it, where they are
   * a database of the application's own: none for a table the authority keeps.
   */
  readonly external?: string | undefined;
}

/**
 * A table as the application's modules read and write it, inside the authority. Every read is
 * noted as what the evaluation depends on: a change to a record it read, or to a record a query
 * named or now names, renders it again.
 */
export interface TableHandle<F extends Fields> {
  /** The record, or `null`, an id no record could have included. */
  readonly get: (id: string) => Promise<RecordOf<F> | null>;
  /** A reference to each field of the record, for a component to bind its state to. */
  readonly ref: (id: string) => {
    readonly [K in Comparable<F> & string]: FieldRef<FieldType<F[K]> & Value>;
  };
  /** The records `where` names, in the order asked for: by `id` where none is. */
  readonly findMany: {
    <const S extends Select<F>>(
      query: Query<F> & { readonly select: S },
    ): Promise<readonly Selected<F, S>[]>;
    (query: Query<F>): Promise<readonly RecordOf<F>[]>;
  };
  /** How many records `where` names. */
  readonly count: (query: { readonly where: Where<F> }) => Promise<number>;
  /**
   * Makes a record, in the server operation's transaction: its id is the authority's to give, and
   * a field left out holds its default.
   */
  readonly insert: (fields: Writable<F>) => Promise<RecordOf<F>>;
  /** Changes fields of the record, in the transaction; a record there is not is not found. */
  readonly update: (id: string, patch: Writable<F>) => Promise<RecordOf<F>>;
  /** Deletes the record, in the transaction; a record there is not is not found. */
  readonly delete: (id: string) => Promise<void>;
}

type Tables = Readonly<Record<string, Table>>;

/** The records the authority starts with, by table and id; a field left out holds its default. */
export type Seed<T extends Tables> = {
  readonly [K in keyof T]?: Readonly<
    Record<string, { readonly [F in keyof T[K]['fields']]?: FieldType<T[K]['fields'][F]> }>
  >;
};

/** What the authority keeps a database as. */
export interface DatabaseDefinition {
  readonly tables: ReadonlyMap<string, Table>;
  /** Every seed record, its fields complete. */
  readonly seed: readonly {
    readonly table: string;
    readonly id: string;
    readonly values: Readonly<Record<string, Value>>;
  }[];
}

/** Where a database keeps its declaration, for the authority to read it from: no table's name. */
const DEFINITION: unique symbol = Symbol.for('arkorlab.reactive-state.database');

/** Any database a `database()` declared, as the authority is given one. */
export interface AnyDatabase {
  readonly [DEFINITION]: DatabaseDefinition;
}

export type Database<T extends Tables> = AnyDatabase & {
  readonly [K in keyof T]: TableHandle<T[K]['fields']>;
} & {
  /**
   * Runs `body` as one transaction — of a server operation, and its only one — in which every
   * `db` call is made, the application's permissions' included: its reads see its writes, and
   * its writes land together once it returns, or none of them when it throws.
   */
  readonly transaction: <R>(body: () => Promise<R>) => Promise<R>;
};

function fail(message: string): never {
  throw new TypeError(`database(): ${message}`);
}

export function text(
  options: { readonly maxLength?: number | undefined; readonly default?: string | undefined } = {},
): Field<string> {
  // Left out alone, a default is the field's own: `null`, from JavaScript or through `any`, is
  // checked as the value it is, and refused.
  const { default: value = '', maxLength = MAX_TEXT_LENGTH } = options;
  if (!Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > MAX_TEXT_LENGTH) {
    fail(`a text field's maxLength is a whole number up to ${String(MAX_TEXT_LENGTH)}`);
  }
  const definition: TextDefinition = { default: value, maxLength, type: 'text' };
  if (checkValue(definition, value) !== undefined) {
    fail("a text field's default is text it may hold");
  }
  return Object.freeze(definition);
}

export function boolean(options: { readonly default?: boolean | undefined } = {}): Field<boolean> {
  const { default: value = false } = options;
  const definition: BooleanDefinition = { default: value, type: 'boolean' };
  // As the others check theirs: a caller in JavaScript, or through `any`, may give another value.
  if (checkValue(definition, definition.default) !== undefined) {
    fail("a boolean field's default is a boolean");
  }
  return Object.freeze(definition);
}

export function integer(
  options: {
    readonly min?: number | undefined;
    readonly max?: number | undefined;
    readonly default?: number | undefined;
  } = {},
): Field<number> {
  const { max = Number.MAX_SAFE_INTEGER, min = Number.MIN_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    fail("an integer field's min and max are safe integers, min no more than max");
  }
  const { default: value = Math.min(Math.max(0, min), max) } = options;
  const definition: IntegerDefinition = { default: value, max, min, type: 'integer' };
  if (checkValue(definition, value) !== undefined) {
    fail("an integer field's default is an integer it may hold");
  }
  return Object.freeze(definition);
}

/**
 * A document of an external table's, as its store answers it: JSON, read-only, which no query asks
 * of or orders by. A table the authority keeps holds none: what it would put there is a state's.
 */
export function json(): Field<Json> {
  const definition: JsonDefinition = { default: null, type: 'json' };
  return Object.freeze(definition);
}

/**
 * A field as its factory declares it, which checks it, whatever the application gave: a call of
 * the factory, or an object written by hand, as a caller in JavaScript, or through `any`, may give.
 */
function fieldOf(name: string, definition: unknown): FieldDefinition {
  const written = (
    typeof definition === 'object' && definition !== null ? definition : {}
  ) as Readonly<Partial<Record<string, unknown>>>;
  switch (written['type']) {
    case 'text': {
      return text({
        default: written['default'] as string | undefined,
        maxLength: written['maxLength'] as number | undefined,
      });
    }
    case 'boolean': {
      return boolean({ default: written['default'] as boolean | undefined });
    }
    case 'integer': {
      return integer({
        default: written['default'] as number | undefined,
        max: written['max'] as number | undefined,
        min: written['min'] as number | undefined,
      });
    }
    case 'json': {
      return json();
    }
    default: {
      return fail(
        `\`${name}\` is no field: a field is declared by text(), boolean(), integer() or json()`,
      );
    }
  }
}

/**
 * The groups of fields a table's records hold apart, as declared: each a list of its own fields,
 * none twice — a record's `id` is its own already, and needs none.
 */
function uniqueOf(fields: Fields, unique: unknown): readonly (readonly string[])[] {
  if (unique === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(unique)) {
    return fail('`unique` is a list of groups of the table’s fields');
  }
  return Object.freeze(
    unique.map((group: unknown) => {
      const names: readonly unknown[] = Array.isArray(group) ? group : [];
      if (
        names.length === 0 ||
        new Set(names).size !== names.length ||
        names.some((name) => typeof name !== 'string' || !Object.hasOwn(fields, name))
      ) {
        fail('each group of `unique` names fields of the table, at least one, none twice');
      }
      return Object.freeze([...(names as readonly string[])]);
    }),
  );
}

/**
 * What an external table may not declare: what the authority keeps of a table of its own — its
 * fields a page of no session shows, its `unique` groups, which its writes are held to — and a
 * store's name that is none.
 */
function checkExternal(
  external: string | undefined,
  options: {
    readonly public?: readonly unknown[] | undefined;
    readonly unique?: readonly unknown[] | undefined;
  },
): void {
  if (external === undefined) {
    return;
  }
  if (!NAME.test(external)) {
    fail(`\`${external}\` is not a store's name: a letter, then letters, digits or _`);
  }
  if ((options.public?.length ?? 0) > 0 || (options.unique?.length ?? 0) > 0) {
    fail(
      `a table of the store \`${external}\` declares no public fields and no unique groups: the authority keeps neither of a database of the application's own`,
    );
  }
}

export function table<F extends Fields>(
  fields: F,
  options: {
    readonly public?: readonly (keyof F & string)[];
    readonly unique?: readonly (readonly (keyof F & string)[])[] | undefined;
    /**
     * The store, by the name its host gives it, the table's records are read through: a database
     * of the application's own, which the authority follows the change log of and never writes.
     */
    readonly external?: string | undefined;
  } = {},
): Table<F> {
  const { external } = options;
  checkExternal(external, options);
  for (const name of Object.keys(fields)) {
    if (name === 'id' || !NAME.test(name)) {
      fail(
        `\`${name}\` is not a field's name: a letter, then letters, digits or _, and never \`id\``,
      );
    }
  }
  const visible = [...new Set(options.public)];
  for (const name of visible) {
    if (!Object.hasOwn(fields, name)) {
      fail(`the public field \`${name}\` is not one of the table's`);
    }
  }
  // The table as it is declared now, whatever becomes of the objects it was declared with after:
  // the authority keeps its records' digest, public views and checks of each write by it.
  const declared = Object.fromEntries(
    Object.entries(fields).map(([name, definition]) => [name, fieldOf(name, definition)]),
  );
  if (external === undefined) {
    const document = Object.keys(declared).find((name) => declared[name]?.type === 'json');
    if (document !== undefined) {
      fail(
        `\`${document}\` is a document, which an external table's store answers alone: what the authority would keep in it is a state's`,
      );
    }
  }
  return Object.freeze({
    fields: Object.freeze(declared) as F,
    public: Object.freeze(visible),
    unique: uniqueOf(fields, options.unique),
    ...(external !== undefined && { external }),
  });
}

/**
 * Why `value` cannot be what the field holds, or nothing when it can: text within the field's
 * length that is well formed (a lone surrogate would not come back from SQLite as it went in), a
 * boolean, or a safe integer within the field's range.
 */
export function checkValue(definition: FieldDefinition, value: unknown): string | undefined {
  switch (definition.type) {
    case 'text': {
      if (typeof value !== 'string') {
        return 'The value is not text.';
      }
      if (value.length > definition.maxLength) {
        return `The text is longer than ${String(definition.maxLength)}.`;
      }
      return value.isWellFormed() ? undefined : 'The text is not well formed.';
    }
    case 'boolean': {
      return typeof value === 'boolean' ? undefined : 'The value is not a boolean.';
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return 'The value is not an integer.';
      }
      return value < definition.min || value > definition.max
        ? `The value is not between ${String(definition.min)} and ${String(definition.max)}.`
        : undefined;
    }
    case 'json': {
      return isJson(value) ? undefined : 'The value is not JSON.';
    }
  }
}

/**
 * What a field of a table the authority keeps holds where a record keeps nothing: its default — no
 * document's, which such a table declares none of (`table()`).
 */
export function defaultOf(definition: FieldDefinition): Value {
  if (definition.type === 'json') {
    throw new TypeError(
      "A document is an external table's field, whose records the authority never keeps.",
    );
  }
  return definition.default;
}

/** Whether `id` is one a record may have: 1 to 64 letters, digits, `_` or `-`. */
export function isRecordId(id: unknown): id is string {
  return typeof id === 'string' && RECORD_ID.test(id);
}

/**
 * What a record holds of one of its table's `unique` groups, as one value: two records that hold
 * the same are refused together.
 */
export function uniqueValue(
  group: readonly string[],
  values: Readonly<Record<string, Value>>,
): string {
  return JSON.stringify(group.map((field) => values[field] ?? null));
}

/**
 * A promise, as a database call is to the application, though the authority's answer is not one:
 * the call is made before it is answered, so an error the authority throws is its rejection.
 */
function promised<T>(call: () => T): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function handle(name: string, definition: Table): Readonly<Record<string, unknown>> {
  const fieldNames = Object.keys(definition.fields);
  const ref = (id: string): Readonly<Record<string, FieldRef>> => {
    if (definition.external !== undefined) {
      throw new TypeError(
        `db.${name}.ref: ${name} is read through the store \`${definition.external}\`, whose records no state is bound to: the authority never writes them`,
      );
    }
    if (!isRecordId(id)) {
      throw new TypeError(`db.${name}.ref: a record's id is 1 to 64 letters, digits, _ or -`);
    }
    const refs = fieldNames.map((field) => {
      const reference: FieldRef = { [REFERENCE]: true, field, id, kind: 'field', table: name };
      Object.freeze(reference);
      return [field, reference] as const;
    });
    return Object.freeze(Object.fromEntries(refs));
  };
  const call = async <T>(method: string, body: (evaluation: Evaluation) => T): Promise<T> =>
    promised(() => body(currentEvaluation(`db.${name}.${method}`)));
  return Object.freeze({
    count: async (query: unknown) => call('count', (evaluation) => evaluation.count(name, query)),
    delete: async (id: unknown) => {
      return call('delete', (evaluation) => {
        evaluation.delete(name, id);
      });
    },
    findMany: async (query: unknown) =>
      call('findMany', (evaluation) => evaluation.findMany(name, query)),
    get: async (id: unknown): Promise<Entry | null> =>
      call('get', (evaluation) => evaluation.get(name, id)),
    insert: async (fields: unknown) =>
      call('insert', (evaluation) => evaluation.insert(name, fields)),
    ref,
    update: async (id: unknown, patch: unknown) =>
      call('update', (evaluation) => evaluation.update(name, id, patch)),
  });
}

/** The record `values` describes, every field there: a field left out holds its default. */
function complete(
  name: string,
  id: string,
  definition: Table,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Value>> {
  const record: Record<string, Value> = {};
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(definition.fields, key)) {
      fail(`the seed record ${name}/${id} has \`${key}\`, which is not one of the table's fields`);
    }
  }
  for (const [field, kind] of Object.entries(definition.fields)) {
    const value = Object.hasOwn(values, field) ? values[field] : kind.default;
    const wrong = checkValue(kind, value);
    if (wrong !== undefined) {
      fail(`the seed record ${name}/${id} cannot hold its \`${field}\`: ${wrong}`);
    }
    record[field] = value as Value;
  }
  return record;
}

/** Refuses seed records of one table that hold the same values of one of its `unique` groups. */
function checkSeedUnique(
  seed: DatabaseDefinition['seed'],
  tables: ReadonlyMap<string, Table>,
): void {
  for (const [name, declared] of tables) {
    for (const group of declared.unique) {
      const held = new Map<string, string>();
      for (const { id, table: of, values } of seed) {
        if (of !== name) {
          continue;
        }
        const value = uniqueValue(group, values);
        const other = held.get(value);
        if (other !== undefined) {
          fail(
            `the seed records ${name}/${other} and ${name}/${id} hold the same ${group.join(', ')}`,
          );
        }
        held.set(value, id);
      }
    }
  }
}

/**
 * The application's database: its tables and the records the authority starts with. What it
 * answers is read inside the authority alone, while it evaluates the application's code; the
 * authority is given the database itself, and reads the declaration from it.
 */
export function database<T extends Tables>(
  tables: T,
  options: { readonly seed?: Seed<T> } = {},
): Database<T> {
  const definitions = new Map<string, Table>();
  const handles: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tables)) {
    if (!NAME.test(name) || RESERVED_TABLES.has(name)) {
      fail(
        `\`${name}\` is not a table's name: a letter, then letters, digits or _, and neither \`session\` nor \`transaction\``,
      );
    }
    // Declared again as `table()` declares it, should it be written by hand or changed since.
    const declared = table(definition.fields, {
      external: definition.external,
      public: definition.public,
      unique: definition.unique,
    });
    definitions.set(name, declared);
    handles[name] = handle(name, declared);
  }
  const seed: { table: string; id: string; values: Readonly<Record<string, Value>> }[] = [];
  const seeded: Readonly<Record<string, unknown>> = options.seed ?? {};
  for (const [name, records] of Object.entries(seeded)) {
    const definition = definitions.get(name);
    if (definition === undefined) {
      fail(`the seed names \`${name}\`, which is not a table of the database`);
    }
    if (definition.external !== undefined) {
      fail(
        `the seed names \`${name}\`, whose records are the store \`${definition.external}\`'s, which the authority never writes`,
      );
    }
    const byId = records as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    for (const [id, values] of Object.entries(byId)) {
      if (!RECORD_ID.test(id)) {
        fail(
          `the seed of ${name} names \`${id}\`: a record's id is 1 to 64 letters, digits, _ or -`,
        );
      }
      seed.push({ id, table: name, values: complete(name, id, definition, values) });
    }
  }
  checkSeedUnique(seed, definitions);
  handles['transaction'] = async <R>(body: () => Promise<R>): Promise<R> =>
    currentEvaluation('db.transaction').transaction(body);
  const declared: DatabaseDefinition = { seed, tables: definitions };
  Object.defineProperty(handles, DEFINITION, { value: declared });
  return Object.freeze(handles) as unknown as Database<T>;
}

/** What a `database()` declared, as the authority keeps it; anything else is refused. */
export function definitionOf(declaration: AnyDatabase): DatabaseDefinition {
  const declared = (declaration as Partial<AnyDatabase> | null | undefined)?.[DEFINITION];
  if (declared === undefined) {
    throw new TypeError(
      'The authority is given the database `database()` of `@arkorlab/reactive-state/server` declared.',
    );
  }
  return declared;
}
