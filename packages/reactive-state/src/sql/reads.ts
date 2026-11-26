import { createHash } from 'node:crypto';

import type { TableRead } from '../server/context.ts';
import type { Catalog } from './catalog.ts';
import type { Followed, KeyColumn } from './keys.ts';
import type { Condition, Operand } from './quals.ts';
import type { Bound } from './serialized.ts';
import { constantText, valueText } from './values.ts';

/**
 * What a statement a render ran read, of the scans its plan holds and the values it ran with: of
 * each scan's table, the records its conditions name — each key a condition names equal to the
 * text of its value — or the table whole where none of them is one followed. A condition of a
 * column the catalog does not follow (`catalog.ts`), of a value whose text is not known
 * (`values.ts`), or of more values than `LIMITS.wheres` reads, is left out: the read is followed by
 * more changes, never fewer.
 */

/**
 * A key's value as the log keeps it (`capture.ts`): the SHA-256 of its text, in UTF-8, in hex — the
 * same of the same text, and no value of the row's.
 */
export function keyDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One scan of a statement's plan: its table, as declared, and its conditions. */
export interface TableScan {
  readonly table: string;
  readonly conditions: readonly Condition[];
}

/**
 * The most queries one scan's read is noted as, of its conditions' lists of values; and the most
 * bytes of a parameter's text a text key is named by: a parameter PostgreSQL reads as a `name`,
 * which no cast in the plan shows, keeps 63 of them.
 */
const LIMITS = { nameBytes: 63, wheres: 32 } as const;

/** The types PostgreSQL writes a constant of a key of each kind as, that compare as the key does. */
const CONSTANT_TYPES = {
  boolean: new Set(['boolean']),
  integer: new Set(['bigint', 'integer', 'smallint']),
  text: new Set(['character varying', 'text']),
  uuid: new Set(['uuid']),
} as const;

/** Of a key, its kind and the type PostgreSQL names it by. */
interface Typed {
  readonly oid?: number | undefined;
  readonly key: KeyColumn;
  readonly type: string | undefined;
  readonly schema: string | undefined;
}

/**
 * The text of a constant a plan names, of the type it was written of, for `typed`: of no type, or of
 * one that compares as the key does — the key's own (an enum's), or the language's of its kind.
 */
function constantOf(
  { constant, schema, type }: Extract<Operand, { readonly constant: string }>,
  typed: Typed,
): string | undefined {
  if (schema !== undefined && (schema !== typed.schema || type !== typed.type)) {
    return undefined;
  }
  if (type !== undefined && type !== typed.type && !CONSTANT_TYPES[typed.key.kind].has(type)) {
    return undefined;
  }
  return constantText(typed.key.kind, constant);
}

/** Whether the text of a parameter's value is longer than PostgreSQL's `name` keeps of one. */
function pastName(text: string): boolean {
  return new TextEncoder().encode(text).length > LIMITS.nameBytes;
}

/**
 * The text `operand` says a key of `key`'s kind equals, of the statement's `values`: `null` of a
 * `NULL`, which equals nothing; nothing where it is not known.
 */
function operandText(
  operand: Operand,
  typed: Typed,
  values: readonly unknown[],
  bound: Bound,
): string | null | undefined {
  if ('constant' in operand) {
    return constantOf(operand, typed);
  }
  if (operand.parameter < 1 || operand.parameter > values.length) {
    return undefined;
  }
  const value = values[operand.parameter - 1];
  if (value === null || value === undefined) {
    return null;
  }
  if (!bound(value, typed.key.kind, typed.oid)) {
    return undefined;
  }
  const text = valueText(typed.key.kind, value);
  return text !== undefined && typed.key.kind === 'text' && pastName(text) ? undefined : text;
}

/**
 * The texts `operands` say a key of `key`'s kind equals, of the statement's `values`: none of a
 * `NULL`, which equals nothing; and no list at all where one's text is not known.
 */
function textsOf(
  operands: readonly Operand[],
  typed: Typed,
  values: readonly unknown[],
  bound: Bound,
): readonly string[] | undefined {
  const texts: string[] = [];
  for (const operand of operands) {
    const text = operandText(operand, typed, values, bound);
    if (text === undefined) return undefined;
    if (text !== null) texts.push(text);
  }
  return texts;
}

/**
 * Whether `condition` may name records of `key`, of the type `type`: a cast of a text or varchar
 * key alone — of an enum's, a cast the application may define otherwise, compared as text by any
 * collation — and a boolean key alone.
 */
function takes(condition: Condition, key: KeyColumn, type: string | undefined): boolean {
  return (
    (!condition.cast || type === 'text' || type === 'varchar') &&
    (!condition.bare || key.kind === 'boolean')
  );
}

/** What a statement ran with: its values, and whether each was sent as its text (`serialized.ts`). */
export interface Run {
  readonly values: unknown;
  readonly bound?: Bound | undefined;
}

/** Of one scan's table, the keys the catalog follows: the type of each, and its type's oid. */
interface Usable {
  readonly types: ReadonlyMap<string, string>;
  readonly oids: ReadonlyMap<string, number>;
  readonly schemas: ReadonlyMap<string, string>;
}

/** The queries one scan's read is noted as: each set of its followed conditions' values. */
function wheresOf(
  scan: TableScan,
  { bound, values }: { readonly values: readonly unknown[]; readonly bound: Bound },
  keys: ReadonlyMap<string, KeyColumn>,
  usable: Usable,
): readonly Readonly<Record<string, string>>[] {
  let wheres: Readonly<Record<string, string>>[] = [{}];
  for (const condition of scan.conditions) {
    const key = keys.get(condition.column);
    if (key === undefined || !usable.types.has(key.column)) continue;
    const typed = {
      key,
      oid: usable.oids.get(key.column),
      schema: usable.schemas.get(key.column),
      type: usable.types.get(key.column),
    };
    if (!takes(condition, key, typed.type)) continue;
    // A key one condition already names: the rows hold both, so the first names more of them.
    if (wheres.some((where) => Object.hasOwn(where, key.field))) continue;
    // A list past the queries a read is noted as, left out before any of its values is read.
    if (wheres.length * condition.operands.length > LIMITS.wheres) continue;
    const texts = textsOf(condition.operands, typed, values, bound);
    if (texts === undefined || texts.length === 0) continue;
    if (wheres.length * texts.length > LIMITS.wheres) continue;
    wheres = wheres.flatMap((where) =>
      texts.map((text) => ({ ...where, [key.field]: keyDigest(text) })),
    );
  }
  return wheres;
}

/**
 * What a statement of `scans`, as it was `run`, read of the tables `followed` follows: of no
 * condition on a value that was not sent as its text (`Run.bound`).
 */
export function readsOf(
  scans: readonly TableScan[],
  run: Run,
  followed: Followed,
  catalog: Catalog,
): readonly TableRead[] {
  const given = {
    bound: run.bound ?? (() => true),
    values: Array.isArray(run.values) ? (run.values as readonly unknown[]) : [],
  };
  // A table whose rows a policy hides: the statement is read whole, as the policy's own scans of the
  // role that planned it were.
  const whole = scans.some((scan) => catalog.hidden.has(scan.table));
  const reads: TableRead[] = [];
  for (const scan of scans) {
    const keys = new Map(
      (followed.keysByTable.get(scan.table) ?? []).map((key) => [key.column, key] as const),
    );
    const usable: Usable = {
      oids: catalog.oids?.get(scan.table) ?? new Map<string, number>(),
      schemas: catalog.typeSchemas?.get(scan.table) ?? new Map<string, string>(),
      types: whole
        ? new Map<string, string>()
        : (catalog.types.get(scan.table) ?? new Map<string, string>()),
    };
    for (const where of wheresOf(scan, given, keys, usable)) {
      reads.push({ table: scan.table, where });
    }
  }
  return reads;
}
