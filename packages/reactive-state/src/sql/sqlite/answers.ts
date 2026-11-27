import type { Instruction, SchemaEntry } from './bytecode.ts';
import type { ColumnTypes } from './sources.ts';

/**
 * What a batch of D1 answers a plan: each statement's rows, as the schema's entries, a table's columns
 * and a program's instructions.
 */

/** The rows of a batch's result, as D1 answers them; none of what is no such answer. */
export function rowsIn(result: unknown): readonly Readonly<Record<string, unknown>>[] | undefined {
  const rows: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'results') : undefined;
  return Array.isArray(rows) ? (rows as Readonly<Record<string, unknown>>[]) : undefined;
}

/** The rows of a batch's result, of what is no such answer no row. */
function rowsOf(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  return rowsIn(result) ?? [];
}

/** The schema's entries of a batch's result. */
export function schemaOf(result: unknown): readonly SchemaEntry[] {
  return rowsOf(result).map((row) => {
    return {
      name: String(row['name']),
      rootpage: Number(row['rootpage']),
      sql: typeof row['sql'] === 'string' ? row['sql'] : null,
      tableName: String(row['tbl_name']),
      type: String(row['type']),
    };
  });
}

/** Each column's declared type of a batch's result of `PRAGMA table_info`, by the column's name. */
export function columnTypesOf(result: unknown): ColumnTypes {
  const types = new Map<string, string>();
  for (const row of rowsOf(result)) {
    types.set(String(row['name']), typeof row['type'] === 'string' ? row['type'] : '');
  }
  return types;
}

/** The instructions of a batch's result of `EXPLAIN`. */
export function instructionsOf(result: unknown): readonly Instruction[] {
  return rowsOf(result).map((row) => {
    return {
      opcode: String(row['opcode']),
      p1: row['p1'],
      p2: row['p2'],
      p3: row['p3'],
    };
  });
}
