import { describe, expect, it } from 'vitest';

import { Dependencies, type RowChange } from '../src/authority/dependencies.ts';
import { matches, type Where } from '../src/authority/query.ts';
import { recordResource, type Value } from '../src/program.ts';

/**
 * A commit's rows are held to what a render read as they were row by row: the rows gathered once —
 * the records, the tables, the fields by a value — answer as each row held to each query did.
 */

/** What a commit changed of what was read, as each row was held to each query, one at a time. */
function rowByRow(
  read: {
    readonly records: ReadonlySet<string>;
    readonly recordTables: ReadonlySet<string>;
    readonly queries: ReadonlyMap<string, readonly Where[]>;
  },
  rows: readonly RowChange[],
): boolean {
  return rows.some((row) => {
    if (row.unknown === 'table' && read.recordTables.has(row.table)) return true;
    if (row.unknown !== 'table' && read.records.has(recordResource(row.table, row.id))) return true;
    const queries = read.queries.get(row.table);
    if (queries === undefined) return false;
    if (row.unknown !== undefined) return true;
    return queries.some((where) => {
      return (
        (row.before !== null && matches(where, row.id, row.before)) ||
        (row.after !== null && matches(where, row.id, row.after))
      );
    });
  });
}

/** Numbers of a sequence each case is made of alike each run: a linear congruential generator. */
const LCG = { increment: 12_345, modulus: 2_147_483_648, multiplier: 1_103_515_245 } as const;
const CASES = 3000;
const TABLES = ['a', 'b'] as const;
const IDS = ['x', 'y', 'z'] as const;
const FIELDS = ['f', 'g', 'id'] as const;
const VALUES: readonly Value[] = ['1', 1, true, false, '', 0];
const MOST = { queries: 4, records: 3, rows: 5 } as const;

function generator(seed: number) {
  let state = seed;
  const next = (below: number): number => {
    state = (state * LCG.multiplier + LCG.increment) % LCG.modulus;
    return state % below;
  };
  const pick = <T>(items: readonly T[]): T => items[next(items.length)] as T;
  const fields = (): Readonly<Record<string, Value>> => {
    const values: Record<string, Value> = {};
    for (const field of FIELDS) {
      if (next(3) !== 0) values[field] = pick(VALUES);
    }
    return values;
  };
  const row = (): RowChange => {
    const unknown = pick([undefined, undefined, undefined, 'fields', 'table'] as const);
    const table = pick(TABLES);
    if (unknown === 'table') return { after: null, before: null, id: '', table, unknown };
    const id = pick(IDS);
    if (unknown === 'fields') return { after: null, before: null, id, table, unknown };
    return {
      after: next(3) === 0 ? null : fields(),
      before: next(3) === 0 ? null : fields(),
      id,
      table,
    };
  };
  return { fields, next, pick, row };
}

describe("a commit's rows, held to what was read", () => {
  it.each([
    { frozen: false, what: 'as given' },
    { frozen: true, what: 'frozen, as a commit holds them' },
  ])('answers as each row held to each query did, of rows $what', ({ frozen }) => {
    const random = generator(frozen ? 7 : 11);
    for (let at = 0; at < CASES; at += 1) {
      const read = {
        queries: new Map<string, Where[]>(),
        recordTables: new Set<string>(),
        records: new Set<string>(),
      };
      const dependencies = new Dependencies();
      for (let count = random.next(MOST.records); count > 0; count -= 1) {
        const table = random.pick(TABLES);
        const id = random.pick(IDS);
        dependencies.record(table, id);
        read.records.add(recordResource(table, id));
        read.recordTables.add(table);
      }
      for (let count = random.next(MOST.queries); count > 0; count -= 1) {
        const table = random.pick(TABLES);
        const where = random.fields();
        dependencies.query(table, where);
        read.queries.set(table, [...(read.queries.get(table) ?? []), where]);
      }
      const given = Array.from({ length: random.next(MOST.rows) }, () => random.row());
      const rows = frozen ? Object.freeze(given) : given;

      expect(dependencies.changedBy(rows)).toBe(rowByRow(read, rows));
      // Rows gathered once answer each reader held to them alike.
      expect(Dependencies.of(dependencies.toJSON()).changedBy(rows)).toBe(rowByRow(read, rows));
    }
  });

  it('matches a query of no field by any row of its table that kept fields', () => {
    const dependencies = new Dependencies();
    dependencies.query('a', {});

    expect(
      dependencies.changedBy(Object.freeze([{ after: {}, before: null, id: 'x', table: 'a' }])),
    ).toBe(true);
    expect(
      dependencies.changedBy(Object.freeze([{ after: null, before: null, id: 'x', table: 'a' }])),
    ).toBe(false);
  });

  it('matches a field a row kept none of as `false`, and `id` by the record', () => {
    const missing = new Dependencies();
    missing.query('a', { f: false });
    const byId = new Dependencies();
    byId.query('a', { id: 'x' });
    const rows = Object.freeze([{ after: { id: 'y' }, before: null, id: 'x', table: 'a' }]);

    expect(missing.changedBy(rows)).toBe(true);
    expect(byId.changedBy(rows)).toBe(true);
  });
});
