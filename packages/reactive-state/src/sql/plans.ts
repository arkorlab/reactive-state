import { type Relation, relationKey } from './capture.ts';
import { type Condition, conditionsOf } from './quals.ts';

/**
 * What a statement of a render reads, as PostgreSQL plans it: every table a scan of its plan names —
 * a join's, a subquery's, a CTE's, and those a view reads in its place — by `EXPLAIN (GENERIC_PLAN)`,
 * which plans a statement of `$1` parameters whatever their values. The plan of one text names the
 * same tables whatever its values, so it is asked once a text. Tables a function reads inside its
 * body are none of a plan's: SQL that hides its reads in a function is not followed.
 */

/**
 * The plan of `sql` as a cursor's, `DECLARE … CURSOR FOR`, as `EXPLAIN (GENERIC_PLAN, VERBOSE,
 * FORMAT JSON)` answers it: a cursor is declared of one query alone, which PostgreSQL holds the text
 * to as it parses it — a statement that is no query, `SELECT … INTO`, which makes a table, and a
 * data-modifying `WITH` are refused there — and the plan is the query's. Nothing is declared.
 */
export function explainSql(sql: string): string {
  return `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) DECLARE "reactive_state_plan" NO SCROLL CURSOR FOR ${sql}`;
}

/** The schemas PostgreSQL keeps of itself, which a render may read and nothing follows. */
const CATALOGS = new Set(['information_schema', 'pg_catalog']);

/** A node of a plan, as its JSON says it. */
type PlanNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The plan `EXPLAIN (FORMAT JSON)` answered: its one row's one column, `[{ Plan }]`. */
function rootOf(answer: unknown): PlanNode {
  const rows = Array.isArray(answer) ? answer : [];
  const [row] = rows as unknown[];
  const column: unknown = isNode(row) ? row['QUERY PLAN'] : undefined;
  const parsed: unknown = typeof column === 'string' ? JSON.parse(column) : column;
  const [top] = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const plan = isNode(top) ? top['Plan'] : undefined;
  if (!isNode(plan)) {
    throw new TypeError('PostgreSQL answered EXPLAIN with no plan.');
  }
  return plan;
}

/**
 * One scan of a plan: the relation it reads, and the conditions every row it reads holds
 * (`quals.ts`), as its `Filter`, `Index Cond` and `Recheck Cond` say them — of a scan of a kind
 * whose conditions are those alone. Of any other — a sample's, a foreign table's, a custom scan's —
 * none: it reads the relation whole.
 */
export interface Scan {
  readonly relation: Relation;
  readonly conditions: readonly Condition[];
}

/**
 * What a plan reads, and whether it writes or locks rows: the relations its scans name, and each
 * scan; any `ModifyTable`, and any `LockRows` — `FOR UPDATE`, `FOR SHARE` and their kin, in a
 * subquery too.
 */
export interface PlanReads {
  readonly relations: readonly Relation[];
  readonly scans: readonly Scan[];
  readonly writes: boolean;
  readonly locks: boolean;
}

/** The scans whose conditions are their `Filter`, `Index Cond` and `Recheck Cond` alone. */
const CONDITIONED = new Set(['Bitmap Heap Scan', 'Index Only Scan', 'Index Scan', 'Seq Scan']);
/** The fields of a scan's node that hold the conditions its rows hold. */
const CONDITION_FIELDS = ['Filter', 'Index Cond', 'Recheck Cond'] as const;

/** The conditions of a scan `node` of `relation`, as its fields say them. */
function scanOf(node: PlanNode, relation: Relation): Scan {
  const alias = node['Alias'];
  if (typeof alias !== 'string' || !CONDITIONED.has(String(node['Node Type']))) {
    return { conditions: [], relation };
  }
  const conditions: Condition[] = [];
  for (const field of CONDITION_FIELDS) {
    const expression = node[field];
    if (typeof expression === 'string') {
      conditions.push(...conditionsOf(expression, alias));
    }
  }
  return { conditions, relation };
}

/**
 * The relations the plan in `answer` — the rows `EXPLAIN (VERBOSE, FORMAT JSON)` answered — reads,
 * but PostgreSQL's catalogs and `namespace`, the log's own, and whether any node of it writes or
 * locks rows.
 */
export function planReads(answer: unknown, namespace: string): PlanReads {
  const found = new Map<string, Relation>();
  const scans: Scan[] = [];
  let writes = false;
  let locks = false;
  const pending: PlanNode[] = [rootOf(answer)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    writes ||= node['Node Type'] === 'ModifyTable';
    locks ||= node['Node Type'] === 'LockRows';
    const relation = relationOf(node, namespace);
    if (relation !== undefined) {
      found.set(relationKey(relation), relation);
      scans.push(scanOf(node, relation));
    }
    pending.push(...childrenOf(node));
  }
  return { locks, relations: [...found.values()], scans, writes };
}

/** The table a node of a plan scans, but a catalog or the log itself; none for a node of no scan. */
function relationOf(node: PlanNode, namespace: string): Relation | undefined {
  const name = node['Relation Name'];
  const schema = node['Schema'];
  if (typeof name !== 'string' || typeof schema !== 'string') {
    return undefined;
  }
  return schema === namespace || CATALOGS.has(schema) ? undefined : { name, schema };
}

/** The nodes a node of a plan holds below it. */
function childrenOf(node: PlanNode): readonly PlanNode[] {
  const children = node['Plans'];
  if (!Array.isArray(children)) {
    return [];
  }
  return (children as unknown[]).filter((child) => isNode(child));
}
