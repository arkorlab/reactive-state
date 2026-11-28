/**
 * The generation of the schema of each database a log follows, by the log's key: how many times a
 * store of it read that the schema changed, which drops every plan a client of it asked before. One
 * of the process's, which every copy of this module finds alike, as the evaluation's
 * (`context.ts`), so that a client of one `followDrizzle` is told what a store of another read; and
 * the digest of the schema the last change was read of, where a store keeps one (D1's).
 */

/** Where the generations are kept, on `globalThis`. */
const GENERATIONS = Symbol.for('arkorlab.reactive-state.drizzle-generations');

/** The generation of a database's schema, and the digest of the schema it is of. */
interface Generation {
  generation: number;
  digest?: string | undefined;
}

/** The generation of the schema of the database whose log `key` names. */
export function generationOf(key: string): Generation {
  const shared = globalThis as unknown as Record<symbol, Map<string, Generation> | undefined>;
  shared[GENERATIONS] ??= new Map();
  const all = shared[GENERATIONS];
  let schema = all.get(key);
  if (schema === undefined) {
    schema = { generation: 0 };
    all.set(key, schema);
  }
  return schema;
}
