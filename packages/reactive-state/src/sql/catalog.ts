import { relationKey } from './capture.ts';
import type { Followed, KeyKind } from './keys.ts';
import { renamesColumns } from './renames.ts';

/**
 * What the database itself says of the followed tables, asked once a connection — with the first
 * plan it is asked (`client.ts`) — before any of a plan's conditions is followed: whether
 * PostgreSQL writes them as `quals.ts` reads them, and of each table, the key columns whose values
 * PostgreSQL compares as their text does. A table whose rows a policy hides — whose plan's
 * conditions are its policy's too, of the role that reads — a partition or a view has none; so has
 * a column of a type the schema did not say, a domain, or a collation that finds two texts equal —
 * and so has each collatable column, of any table, in a database that holds such a collation: a
 * `COLLATE` of it in a statement compares a column by it, though a plan writes the comparison as
 * one of the column itself (`(users.email)::text = $1`, an index's `users.email = $1`, a condition
 * pushed into a branch of a `UNION` another branch of which collates).
 */

/** The first PostgreSQL that writes a subquery's value as `(InitPlan n)`, never as a `$n` of its own. */
const CONDITIONS_SINCE = 170_000;

/** The types a key of each kind may be, as PostgreSQL names them; of text, an enum's too. */
const TYPES: Readonly<Record<KeyKind, ReadonlySet<string>>> = {
  boolean: new Set(['bool']),
  integer: new Set(['int2', 'int4', 'int8']),
  text: new Set(['text', 'varchar']),
  uuid: new Set(['uuid']),
};

/** The types of a key's, and those PostgreSQL compares them as, by their names in the catalog. */
const EQUALS_TYPES = ['bool', 'bpchar', 'int2', 'int4', 'int8', 'name', 'text', 'uuid', 'varchar']
  .map((name) => `'${name}'`)
  .join(', ');

/** What the catalog says the followed tables' conditions may be followed by. */
export interface Catalog {
  /** Of each followed table, by its declared name, the key columns its conditions are followed by. */
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  /** Of each followed table, the type PostgreSQL names each of those keys by (`status`, `text`). */
  readonly types: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Of each followed table, the namespace of each key's type, for a qualified enum constant. */
  readonly typeSchemas?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Of each followed table, the oid of each of those keys' types, whose serializer sends a value. */
  readonly oids?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Whether the connection reads a string's `\` as itself (`standard_conforming_strings`), as the
   * check of a statement's names reads it (`renames.ts`): not known, as of no catalog, is not.
   */
  readonly conforming?: boolean;
  /**
   * The followed tables whose rows a policy hides: a statement that reads one is read whole, its
   * other tables too, which the policy's own conditions — of the role that reads — may scan.
   */
  readonly hidden: ReadonlySet<string>;
  /**
   * The partitioned tables and the partitions among the followed tables, and the partitions of a
   * followed partitioned table, by `relationKey`: a plan names a partitioned table's partitions, and
   * a write to the table is logged as the table's, so nothing follows either. Not known, as of no
   * catalog, is none.
   */
  readonly partitioned?: ReadonlySet<string>;
  /**
   * The followed tables that inherit from another table (`INHERITS`), and those that inherit from
   * them, by `relationKey` — partitions are `partitioned`'s: a write through a table's parent
   * changes its rows and is logged as the parent's, which a render that read the table alone is not
   * told of. Not known, as of no catalog, is none.
   */
  readonly inherited?: ReadonlySet<string>;
}

/** No condition followed: every read of a table is of the table whole. */
export const NO_CONDITIONS: Catalog = { hidden: new Set(), keys: new Map(), types: new Map() };

/**
 * `text` as a PostgreSQL string literal: an escape string, its backslashes and quotes doubled, read
 * alike whatever the session's `standard_conforming_strings` says (a table named `odd\`).
 */
function literal(text: string): string {
  const escaped = text.replaceAll('\\', String.raw`\\`).replaceAll("'", "''");
  return `E'${escaped}'`;
}

/**
 * The statement that asks of the followed tables of `followed`: the server's version, and of each
 * table, by its schema and name, its kind, whether it is a partition, inherits from another table
 * or its rows are hidden by a policy, and of each column, its type, the kind of type, and whether
 * its collation is deterministic. The tables that inherit from a followed table, partitions
 * included, are asked of the same way.
 */
export function catalogSql(followed: Followed): string {
  const relations = followed.relations.map(
    (relation) => `(${literal(relation.schema)}, ${literal(relation.name)})`,
  );
  const listed = relations.length === 0 ? '(NULL, NULL)' : relations.join(', ');
  const nondeterministic =
    'EXISTS (SELECT 1 FROM pg_collation AS x WHERE NOT x.collisdeterministic)';
  const deterministic = `a.attcollation = 0 OR (coalesce(co.collisdeterministic, true) AND NOT ${nondeterministic})`;
  const columns = `(SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', t.typname, 'type_schema', tn.nspname, 'category', t.typtype, 'oid', t.oid::bigint, 'builtin', t.typnamespace = 'pg_catalog'::regnamespace, 'deterministic', ${deterministic})), '[]'::json) FROM pg_attribute AS a JOIN pg_type AS t ON t.oid = a.atttypid JOIN pg_namespace AS tn ON tn.oid = t.typnamespace LEFT JOIN pg_collation AS co ON co.oid = a.attcollation WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)`;
  // An `=` of the application's of a type a key may be — one PostgreSQL may resolve before
  // its own, as the search path orders them — compares otherwise than the key's text does.
  const operators = `EXISTS (SELECT 1 FROM pg_operator AS o JOIN pg_namespace AS n ON n.oid = o.oprnamespace JOIN pg_type AS l ON l.oid = o.oprleft JOIN pg_type AS r ON r.oid = o.oprright WHERE o.oprname = '=' AND n.nspname <> 'pg_catalog' AND (l.typtype IN ('e', 'p') OR r.typtype IN ('e', 'p') OR l.typname IN (${EQUALS_TYPES}) OR r.typname IN (${EQUALS_TYPES})))`;
  // What a plan reads in place of a view, or of a SQL function it inlines: the trees PostgreSQL
  // keeps of a view's rule and of a function's body of SQL's standard — of them, those of an alias
  // that names its columns, of a table or not — and the text of each other SQL function's body.
  const others = `n.nspname NOT IN ('pg_catalog', 'information_schema')`;
  // A name of the tree's, its spaces and parentheses escaped (`a\ p`): of no space unescaped.
  const aliasList = String.raw`E':alias [{]ALIAS :aliasname (?:[^ \\\\]|\\\\.)+ :colnames [(]'`;
  // The application's trees first, then the pattern of them alone: PostgreSQL would else match the
  // pattern within its scan of every rule, its own views' too, before it leaves those out (some
  // 40 ms of a PGlite's 3 MB of them, on a first plan).
  const kept = `SELECT r.ev_action::text AS tree FROM pg_rewrite AS r JOIN pg_class AS c ON c.oid = r.ev_class JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${others} UNION ALL SELECT p.prosqlbody::text FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE p.prosqlbody IS NOT NULL AND ${others}`;
  const trees = `(WITH "kept" AS MATERIALIZED (${kept}) SELECT coalesce(json_agg(k.tree), '[]'::json) FROM "kept" AS k WHERE k.tree ~ ${aliasList})`;
  const bodies = `(SELECT coalesce(json_agg(p.prosrc), '[]'::json) FROM pg_proc AS p JOIN pg_language AS l ON l.oid = p.prolang JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE l.lanname = 'sql' AND p.prosqlbody IS NULL AND ${others})`;
  // The tables, at any depth, that inherit from a followed table, its partitions among them
  // (`pg_inherits` holds both): a plan of a table names them, and a plan of a partitioned table
  // names them alone.
  const descendantsOfListed = `WITH RECURSIVE "tree"("oid") AS (SELECT p.oid FROM pg_class AS p JOIN pg_namespace AS pn ON pn.oid = p.relnamespace WHERE (pn.nspname, p.relname) IN (${listed}) UNION SELECT i.inhrelid FROM pg_inherits AS i JOIN "tree" AS t ON i.inhparent = t."oid") SELECT "oid" FROM "tree"`;
  const inherits = `EXISTS (SELECT 1 FROM pg_inherits AS h WHERE h.inhrelid = c.oid)`;
  return `SELECT current_setting('server_version_num')::int AS "version", current_setting('standard_conforming_strings') = 'on' AS "conforming", getdatabaseencoding() = 'UTF8' AS "utf8", ${operators} AS "operators", ${trees} AS "trees", ${bodies} AS "bodies", coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'partition', c.relispartition, 'inherits', ${inherits}, 'hidden', c.relrowsecurity, 'columns', ${columns})) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE (n.nspname, c.relname) IN (${listed}) OR c.oid IN (${descendantsOfListed})), '[]'::json) AS "tables"`;
}

/** `value` as a record of fields, where it is an object of JSON's. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The items of `value`, a list of JSON's, as PostgreSQL answered it or as its text. */
function listOf(value: unknown): readonly unknown[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as unknown[]) : [];
}

/** The names of PostgreSQL's types a key may be, which an enum of such a name stands apart from. */
const BUILTIN_NAMES = new Set(Object.values(TYPES).flatMap((types) => [...types]));

/**
 * Whether a column of the type `type`, of the kind `category` — PostgreSQL's own, if `builtin` —
 * holds a key of `kind`: an enum of a name of PostgreSQL's types is none.
 */
function fits(kind: KeyKind, column: Readonly<Record<string, unknown>>): boolean {
  const { builtin, category, type } = column;
  if (typeof type !== 'string') return false;
  if (category === 'e') {
    return kind === 'text' && !BUILTIN_NAMES.has(type);
  }
  return category === 'b' && builtin === true && TYPES[kind].has(type);
}

/** Where a range table's entry of a stored tree begins: each of its relations, calls, subqueries. */
const ENTRY = '{RANGETBLENTRY ';

/**
 * Whether a tree PostgreSQL keeps of a view's rule or of a function's body holds a table (an
 * entry of `:rtekind 0`) of an alias that names its columns (`:alias` of `:colnames (`), which a
 * plan writes them by. A name in a tree is escaped of spaces and parentheses, so neither word
 * stands in one.
 */
function treeRenames(tree: string): boolean {
  return tree
    .split(ENTRY)
    .slice(1)
    .some((entry) => {
      const named = entry.indexOf(' :eref ');
      const alias = named === -1 ? entry : entry.slice(0, named);
      const kind = / :rtekind (\d+)/u.exec(entry)?.[1];
      // A view's or a materialized view's: a plan reads the view's own tables by their names, and
      // scans a materialized view, which nothing follows, of its own.
      const relation = / :relkind ([a-z])/u.exec(entry)?.[1];
      return alias.includes(':colnames (') && kind === '0' && relation !== 'v' && relation !== 'm';
    });
}

/**
 * Whether a view or a SQL function names a table's columns otherwise: by the trees PostgreSQL keeps
 * of them (`trees`), or by the text of a function's body (`bodies`, `renames.ts`). A plan writes
 * the columns by the names given them, which may be others'.
 */
function renamesIn(trees: unknown, bodies: unknown, conforming: boolean): boolean {
  return (
    listOf(trees).some((tree) => typeof tree === 'string' && treeRenames(tree)) ||
    listOf(bodies).some((body) => typeof body === 'string' && renamesColumns(body, conforming))
  );
}

/**
 * The key columns of one table the catalog says its conditions are followed by, each by the type
 * PostgreSQL names it by, and by its type's oid.
 */
function keysOfTable(
  table: Readonly<Record<string, unknown>>,
  kinds: ReadonlyMap<string, KeyKind>,
): {
  readonly oids: Map<string, number>;
  readonly types: Map<string, string>;
  readonly schemas: Map<string, string>;
} {
  const usable = {
    oids: new Map<string, number>(),
    schemas: new Map<string, string>(),
    types: new Map<string, string>(),
  };
  if (table['kind'] !== 'r' || table['partition'] !== false || table['hidden'] !== false) {
    return usable;
  }
  const columns = listOf(table['columns']);
  for (const each of columns) {
    const column = recordOf(each) ?? {};
    const name = column['name'];
    const kind = typeof name === 'string' ? kinds.get(name) : undefined;
    if (kind !== undefined && column['deterministic'] === true && fits(kind, column)) {
      usable.types.set(name as string, String(column['type']));
      if (typeof column['type_schema'] === 'string') {
        usable.schemas.set(name as string, column['type_schema']);
      }
      if (typeof column['oid'] === 'number') usable.oids.set(name as string, column['oid']);
    }
  }
  return usable;
}

/** The tables of `tables`, the rows of `catalogSql`'s list, that are partitioned or are partitions. */
function partitionedIn(tables: readonly unknown[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const each of tables) {
    const table = recordOf(each) ?? {};
    if (table['kind'] === 'p' || table['partition'] === true) {
      found.add(relationKey({ name: String(table['name']), schema: String(table['schema']) }));
    }
  }
  return found;
}

/** The tables of `tables` that inherit from another and are no partitions. */
function inheritedIn(tables: readonly unknown[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const each of tables) {
    const table = recordOf(each) ?? {};
    if (table['inherits'] === true && table['kind'] !== 'p' && table['partition'] !== true) {
      found.add(relationKey({ name: String(table['name']), schema: String(table['schema']) }));
    }
  }
  return found;
}

/** What the rows `catalogSql` answered say, of the tables `followed` follows. */
export function catalogOf(rows: unknown, followed: Followed): Catalog {
  const [first] = Array.isArray(rows) ? (rows as unknown[]) : [];
  const row = recordOf(first) ?? {};
  const version = row['version'];
  const conforming = row['conforming'] === true;
  const utf8 = row['utf8'] === true;
  const partitioned = partitionedIn(listOf(row['tables']));
  const inherited = inheritedIn(listOf(row['tables']));
  if (
    typeof version !== 'number' ||
    version < CONDITIONS_SINCE ||
    row['operators'] !== false ||
    renamesIn(row['trees'], row['bodies'], conforming)
  ) {
    // No condition is followed, but which tables are partitioned or inherit is not a condition's
    // fact.
    return { ...NO_CONDITIONS, inherited, partitioned };
  }
  const keys = new Map<string, ReadonlySet<string>>();
  const types = new Map<string, ReadonlyMap<string, string>>();
  const typeSchemas = new Map<string, ReadonlyMap<string, string>>();
  const oids = new Map<string, ReadonlyMap<string, number>>();
  const hidden = new Set<string>();
  const tables = listOf(row['tables']);
  for (const each of tables) {
    const table = recordOf(each) ?? {};
    const declared = followed.byRelation.get(
      relationKey({ name: String(table['name']), schema: String(table['schema']) }),
    );
    if (declared === undefined) continue;
    // Of a database of another encoding than UTF-8, no text key: the text of its value is of
    // other bytes than the digest of a read's text (`reads.ts`), and two texts may be one there.
    const kinds = new Map(
      (followed.keysByTable.get(declared) ?? [])
        .filter((key) => utf8 || key.kind !== 'text')
        .map((key) => [key.column, key.kind] as const),
    );
    const usable = keysOfTable(table, kinds);
    keys.set(declared, new Set(usable.types.keys()));
    types.set(declared, usable.types);
    typeSchemas.set(declared, usable.schemas);
    oids.set(declared, usable.oids);
    if (table['hidden'] !== false) hidden.add(declared);
  }
  return { conforming, hidden, inherited, keys, oids, partitioned, types, typeSchemas };
}
