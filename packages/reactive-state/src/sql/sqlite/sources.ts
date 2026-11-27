import type { SchemaEntry } from './bytecode.ts';
import { type Comparison, comparisonOf, type Edge, edgesOf, termsOf } from './closure.ts';
import type { Occurrence, StatementRead } from './scopes.ts';
import { folded, type Term } from './where.ts';

/**
 * What a statement read scope by scope (`scopes.ts`) reads of the database's tables, of what a plan's
 * batch says they are: each source of a table its bytecode opens, and the terms that restrict it. Its
 * tables are read whole where it names what is no table — a view reads tables its text does not name,
 * of rows no term of the text restricts — or opens one it names not; and every followed table is, of
 * a virtual table among them, whose reads no root page names, and which a function of JSON the text
 * names, left out of its bytecode, may stand beside in the count of what it opens.
 */

/** A table of a module of its own, whose rows no b-tree of it holds. */
const VIRTUAL_TABLE = /^\s*create\s+virtual\b/iu;
/** A table's SQL that may compare its columns otherwise than by their bytes. */
export const COLLATED = /\bcollate\b/iu;

/** Each column's declared type, by the column's name. */
export type ColumnTypes = ReadonlyMap<string, string>;

/** What a plan's batch says of a statement read scope by scope. */
export interface PlanAnswers {
  /** Each table's columns, by the name the text gives it. */
  readonly columns: ReadonlyMap<string, ColumnTypes>;
  /** The tables the bytecode opens, by the schema's names. */
  readonly opened: ReadonlySet<string>;
  readonly schema: readonly SchemaEntry[];
  /** How many virtual tables the bytecode opens. */
  readonly virtuals: number;
}

/** A time a statement reads a table, by the schema's name, and what restricts its rows. */
export interface TableSource {
  readonly columns: ColumnTypes;
  readonly occurrence: Occurrence;
  readonly table: string;
  readonly terms: readonly Term[];
}

/** What a statement reads: every followed table, its own tables whole, or each by its sources. */
export type Sources =
  | { readonly kind: 'every' }
  | { readonly kind: 'whole' }
  | {
      readonly kind: 'sources';
      readonly sources: readonly TableSource[];
      /** The equalities between columns compared alike, which a candidate names a source's rows by. */
      readonly edges: readonly Edge[];
    };

/** The tables `read` names, once each, by a name of the text. */
export function tablesNamed(read: StatementRead | undefined): readonly string[] {
  if (read === undefined) return [];
  const named = new Set<string>();
  for (const { table } of read.occurrences) {
    if (table !== undefined) named.add(table);
  }
  return [...named];
}

/** The tables of `schema`, by their names as SQLite compares them. */
function tablesOf(schema: readonly SchemaEntry[]): ReadonlyMap<string, SchemaEntry> {
  const tables = new Map<string, SchemaEntry>();
  for (const entry of schema) {
    if (entry.type === 'table') tables.set(folded(entry.name), entry);
  }
  return tables;
}

/** The schema's names of what `sources` name, where each is a table with rows of its own. */
function plainTables(
  sources: readonly Occurrence[],
  tables: ReadonlyMap<string, SchemaEntry>,
): ReadonlySet<string> | undefined {
  const named = new Set<string>();
  for (const source of sources) {
    const entry = tables.get(folded(source.table ?? ''));
    if (entry === undefined || VIRTUAL_TABLE.test(entry.sql ?? '')) return undefined;
    named.add(entry.name);
  }
  return named;
}

/** What `read` reads, of what its plan's batch answered. */
export function sourcesOf(read: StatementRead, answers: PlanAnswers): Sources {
  const { columns, opened, schema, virtuals } = answers;
  const tables = tablesOf(schema);
  if (read.functions.some((name) => tables.has(name))) return { kind: 'every' };
  const named = read.occurrences.filter((each) => each.table !== undefined);
  const plain = plainTables(named, tables);
  const whole: Sources = { kind: virtuals > 0 ? 'every' : 'whole' };
  if (plain === undefined) return whole;
  for (const name of opened) {
    if (!plain.has(name)) return whole;
  }
  const entryOf = (of: Occurrence) => tables.get(folded(of.table ?? ''));
  const typesOf = (of: Occurrence): ColumnTypes => columns.get(of.table ?? '') ?? new Map();
  const comparison: Comparison = ({ column, occurrence }) => {
    const collated = COLLATED.test(entryOf(occurrence)?.sql ?? '');
    return comparisonOf(typesOf(occurrence).get(column), collated);
  };
  const terms = termsOf(read, comparison);
  const sources = named.flatMap((source) => {
    const table = entryOf(source)?.name;
    // A source the bytecode opens not is SQLite's left join left out: the schema's digest holds it.
    if (table === undefined || !opened.has(table)) return [];
    return [
      { columns: typesOf(source), occurrence: source, table, terms: terms.get(source) ?? [] },
    ];
  });
  return { edges: edgesOf(read, comparison), kind: 'sources', sources };
}
