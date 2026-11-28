import type { Edge } from './closure.ts';
import type { SqliteKeyKind } from './keys.ts';
import type { TableSource } from './sources.ts';
import { sqliteKeyText } from './values.ts';
import type { Term } from './where.ts';

/**
 * The reads a plan notes of a table, and what names the rows of a joined table no parameter reaches.
 *
 * A candidate is a small statement of the source that drives such a table, its driver: the values
 * the driver's rows hold of the column the table is equal to. A row of the table of another value
 * joins no row of the driver, so it changes no answer while the driver stays as it was, and any row
 * that comes to count in the driver holds the driver's key terms, whose read renders the statement
 * again, and the candidate is asked anew. That is why a driver is a source read by its own key
 * terms: two sources each named by the other would each wait for a change only the other notes. A
 * candidate reads the driver by those terms alone, the rows its read follows: any other term may
 * name what is no column of its table, a result's alias, which reads otherwise in a statement of
 * its own.
 *
 * A candidate is asked in an event stream's render alone (`streamedRender`), beside its statement,
 * of a plan kept from before: a page's render reads the table whole, as it read it, and so does a
 * stream's that asks its plan, or whose statement waits for its reads. A candidate there would be
 * one round trip more, in a call a page behind it in the authority's queue waits for.
 */

/** A term of a plan: a key's field, how its value is written, and the parameters it is equal to. */
export interface KeyTerm {
  readonly field: string;
  readonly kind: SqliteKeyKind;
  readonly params: readonly number[];
}

/** The rows of a table a read names: every record of a `where` of no field. */
export type Where = Readonly<Record<string, string>>;

/** A statement of the values that name a source's rows, of the key they are read by. */
interface Candidate {
  readonly field: string;
  readonly kind: SqliteKeyKind;
  /** The statement's parameters, as places among those of the statement it stands beside. */
  readonly params: readonly number[];
  readonly sql: string;
}

/** A time a statement reads a table: by the terms of its keys, or of none, by a candidate if any. */
export interface SourceRead {
  readonly terms: readonly KeyTerm[];
  readonly candidate?: Candidate | undefined;
}

/** A time a statement reads a table by a candidate. */
export interface CandidateRead extends SourceRead {
  readonly candidate: Candidate;
}

/** How many records a read names at most. */
const MOST_WHERES = 32;

/** An SQL identifier, quoted. */
export function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Each value's text of a term of `kind`, or nothing where one is no key's text. */
function textsOf(term: KeyTerm, values: readonly unknown[]): readonly string[] | undefined {
  const texts = term.params.map((at) => sqliteKeyText(term.kind, values[at]));
  return texts.includes(undefined) ? undefined : (texts as readonly string[]);
}

/**
 * The records `terms` name of `values`: each of their combinations, as many as `MOST_WHERES` at
 * most — of a term of more values left out, which reads more, never fewer — or every record.
 */
export function wheresOf(terms: readonly KeyTerm[], values: readonly unknown[]): readonly Where[] {
  const named = new Map<string, readonly string[]>();
  for (const term of terms) {
    const texts = textsOf(term, values);
    // A second term of one key holds of fewer rows than the first: the first names them all.
    if (texts !== undefined && !named.has(term.field)) named.set(term.field, texts);
  }
  const sorted = [...named].toSorted(([, a], [, b]) => a.length - b.length);
  let wheres: Record<string, string>[] = [{}];
  for (const [field, texts] of sorted) {
    if (wheres.length * texts.length > MOST_WHERES) break;
    wheres = wheres.flatMap((where) => texts.map((text) => ({ ...where, [field]: text })));
  }
  return wheres;
}

/**
 * The reads of a table a statement stands in `sources` times: once of each, and once whole where a
 * source of no term and no candidate holds what the others name.
 */
export function readsApart(sources: readonly SourceRead[]): readonly SourceRead[] {
  if (sources.some((each) => each.terms.length === 0 && each.candidate === undefined)) {
    return [{ terms: [] }];
  }
  return [...new Map(sources.map((each) => [JSON.stringify(each), each])).values()];
}

/**
 * What the `wheres` of a table's several sources name together, each once: the table whole where one
 * of them is, or where they name more than a read may.
 */
export function wheresTogether(wheres: readonly Where[]): readonly Where[] {
  const distinct = [...new Map(wheres.map((where) => [JSON.stringify(where), where])).values()];
  const whole = distinct.some((where) => Object.keys(where).length === 0);
  return whole || distinct.length > MOST_WHERES ? [{}] : distinct;
}

/** The statement of the values `column` holds in `table`'s rows of `terms`, one past a read's. */
function candidateText(table: string, column: string, terms: readonly Term[]): string {
  const held = terms.map(
    ({ column: of, params }) => `${quoted(of)} IN (${params.map(() => '?').join(', ')})`,
  );
  const limit = String(MOST_WHERES + 1);
  return `SELECT DISTINCT ${quoted(column)} AS "value" FROM ${quoted(table)} WHERE ${held.join(' AND ')} LIMIT ${limit}`;
}

/**
 * The candidate that names the rows of `source`, a source of no key term: of the first equality that
 * holds of its rows with a column of a source read by key terms of its own, and by those alone.
 * `keyTerms` answers which of a source's terms are of its keys.
 */
export function candidateOf(
  source: TableSource,
  read: { readonly edges: readonly Edge[]; readonly sources: readonly TableSource[] },
  keyTerms: (of: TableSource, terms: readonly Term[]) => readonly KeyTerm[],
): Candidate | undefined {
  for (const { from, to } of read.edges) {
    const driver = read.sources.find((each) => each.occurrence === from.occurrence);
    if (driver !== undefined && to.occurrence === source.occurrence) {
      const [key] = keyTerms(source, [{ column: to.column, params: [] }]);
      const held = driver.terms.filter((term) => keyTerms(driver, [term]).length > 0);
      if (key !== undefined && held.length > 0) {
        const { field, kind } = key;
        const params = held.flatMap((term) => term.params);
        return { field, kind, params, sql: candidateText(driver.table, from.column, held) };
      }
    }
  }
  return undefined;
}

/**
 * The records the rows of a candidate's answer name, by the column `value`: none of a `NULL`, which
 * equals nothing; every record past what a read names, of a value that is no key's text, or of what
 * is no list of rows.
 */
export function wheresNamed(
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
  { field, kind }: Pick<Candidate, 'field' | 'kind'>,
): readonly Where[] {
  if (rows === undefined || rows.length > MOST_WHERES) return [{}];
  const held = rows.map((row) => row['value']).filter((value) => value !== null);
  const texts = held.map((value) => sqliteKeyText(kind, value));
  if (texts.includes(undefined)) return [{}];
  return (texts as readonly string[]).map((text) => ({ [field]: text }));
}
