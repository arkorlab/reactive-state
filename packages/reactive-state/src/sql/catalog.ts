import { LOG_SQL_FUNCTIONS, relationKey } from './capture.ts';
import { namesTemporaryRowType, type TemporaryRowType } from './guards.ts';
import type { Followed, KeyKind } from './keys.ts';
import { renamesColumns } from './renames.ts';
import { type KnownType, type TypeKeywords, unknownTypeCast } from './type-guards.ts';

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

/** The name a statement gives the session's temporary schema, whatever its own name is. */
const TEMPORARY_SCHEMA = 'pg_temp';

/** The kinds of relation whose row type a statement may name: a table's, a view's and kin. */
const RELATION_KINDS: ReadonlySet<string> = new Set(['f', 'm', 'p', 'r', 'v']);

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
  /** Relations whose statement triggers cannot capture every write a scan can observe. */
  readonly unsupported?: ReadonlySet<string>;
  /** Temporary table row types whose changes nothing counts: a staging table's, as its DDL is not. */
  readonly temporaryTypes?: readonly TemporaryRowType[];
  /** Whether a known string-body SQL function names a temporary table row type. */
  readonly temporaryBody?: boolean;
  /** Permanent type identities an explicit cast or typed literal may use. */
  readonly castTypes?: readonly KnownType[];
  /** The server's keyword categories: proof of syntax words and unquoted column identifiers. */
  readonly typeKeywords?: TypeKeywords | undefined;
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
 * table, by its schema and name, its kind, whether it is a partition or its rows are hidden by a
 * policy, and of each column, its type, the kind of type, and whether its collation is
 * deterministic.
 */
export function catalogSql(followed: Followed): string {
  const relations = followed.relations.map(
    (relation) => `(${literal(relation.schema)}, ${literal(relation.name)})`,
  );
  const listed = relations.length === 0 ? '(NULL, NULL)' : relations.join(', ');
  const nondeterministic =
    'EXISTS (SELECT 1 FROM pg_collation AS x WHERE NOT x.collisdeterministic)';
  const deterministic = `a.attcollation = 0 OR (coalesce(co.collisdeterministic, true) AND NOT ${nondeterministic})`;
  const columns = `(SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', t.typname, 'type_schema', tn.nspname, 'category', t.typtype, 'oid', t.oid::pg_catalog.int8, 'builtin', t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace, 'visible', pg_type_is_visible(t.oid), 'deterministic', ${deterministic})), '[]'::pg_catalog.json) FROM pg_attribute AS a JOIN pg_type AS t ON t.oid = a.atttypid JOIN pg_namespace AS tn ON tn.oid = t.typnamespace LEFT JOIN pg_collation AS co ON co.oid = a.attcollation WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)`;
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
  const kept = `SELECT r.ev_action::pg_catalog.text AS tree FROM pg_rewrite AS r JOIN pg_class AS c ON c.oid = r.ev_class JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${others} UNION ALL SELECT p.prosqlbody::pg_catalog.text FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE p.prosqlbody IS NOT NULL AND ${others}`;
  const trees = `(WITH "kept" AS MATERIALIZED (${kept}) SELECT coalesce(json_agg(k.tree), '[]'::pg_catalog.json) FROM "kept" AS k WHERE k.tree ~ ${aliasList})`;
  // Of them, none of a log's own functions, of this log or of another an event trigger tells of: a
  // word of their text (`keys`, `n`) is no type's, though a staging table has its name. An
  // application's function of such a name, of other arguments or another schema, is read.
  const logFunctions = LOG_SQL_FUNCTIONS.map((signature) => literal(signature)).join(', ');
  const logSchema = `(n.nspname = ${literal(followed.namespace)} OR EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger AS e JOIN pg_catalog.pg_proc AS q ON q.oid = e.evtfoid WHERE q.pronamespace = n.oid AND q.proname = 'note_ddl' AND e.evtname = n.nspname || '_ddl'))`;
  // A text of each, as a row's comparison finds no `=` where the application's stands before ours.
  const logFunction = `(${logSchema} AND pg_catalog.format('%s(%s)', p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) IN (${logFunctions}))`;
  const bodies = `(SELECT coalesce(json_agg(p.prosrc), '[]'::pg_catalog.json) FROM pg_proc AS p JOIN pg_language AS l ON l.oid = p.prolang JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE l.lanname = 'sql' AND p.prosqlbody IS NULL AND ${others} AND NOT ${logFunction})`;
  const builtinTypes = `(SELECT json_agg(json_build_array(t.typname, pg_type_is_visible(t.oid))) FROM pg_type AS t WHERE t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace AND t.typrelid = 0)`;
  // User-defined scalar and explicitly declared composite types are permanent too, even where
  // no followed column uses them. Automatic table row types and arrays stay out of this list.
  const permanentTypes = `(SELECT json_agg(json_build_array(n.nspname, t.typname, pg_type_is_visible(t.oid))) FROM pg_type AS t JOIN pg_namespace AS n ON n.oid = t.typnamespace LEFT JOIN pg_class AS c ON c.oid = t.typrelid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(toast_)?temp_' AND t.typelem = 0 AND (t.typrelid = 0 OR c.relkind = 'c'))`;
  const keywords = `(SELECT json_agg(json_build_array(word, catcode)) FROM pg_catalog.pg_get_keywords())`;
  const inherited = `EXISTS (SELECT 1 FROM pg_inherits AS i WHERE i.inhrelid = c.oid)`;
  // A temporary relation's row type the schema's count follows as it changes, whether an event
  // trigger counts the schema's commands (`capture.ts`) or the digest alone tells (`digest.ts`):
  // a view's, one of the name of a type of PostgreSQL's or of the application's — the log's own
  // schema's are the digest's alone — or one a domain, a range, a function or a composite type's
  // attribute is of, whose drop and change are counted too: none of the log's own schema, the
  // log's place, whose own functions are counted of nothing. A staging table's
  // column, rule or constraint is none such: its drop is counted of nothing, after which a change
  // of the type would be of nothing either. Nor, to keep the first plan's catalog lean, is a view.
  // Each dependency names its object's kind — a domain's and a range's are a type's — and schema,
  // quoted as an identifier is (a log of a keyword's name, `user`), of no join of their catalogs.
  const application = `(o.nspname = 'pg_catalog' OR (o.nspname NOT IN ('information_schema', 'pg_toast', ${literal(followed.namespace)}) AND o.nspname !~ '^pg_(toast_)?temp_'))`;
  const dependent = `EXISTS (SELECT 1 FROM pg_depend AS p, pg_catalog.pg_identify_object(p.classid, p.objid, 0) AS d WHERE p.refclassid = 'pg_type'::pg_catalog.regclass AND p.refobjid IN (t.oid, t.typarray) AND p.deptype = 'n' AND d.type IN ('aggregate', 'composite type', 'function', 'procedure', 'type') AND d.schema IS DISTINCT FROM pg_catalog.quote_ident(${literal(followed.namespace)}))`;
  const counted = `(c.relkind = 'v' OR EXISTS (SELECT 1 FROM pg_type AS a JOIN pg_namespace AS o ON o.oid = a.typnamespace WHERE a.typname = t.typname AND ${application}) OR ${dependent})`;
  // Each type of the session's temporary schema but an array, as of the application's: its
  // relation's kind, where it is a row type, and whether the count follows that relation.
  const temporary = `(SELECT json_agg(json_build_array(n.nspname, t.typname, pg_type_is_visible(t.oid), c.relkind, t.typrelid <> 0 AND ${counted})) FROM pg_type AS t JOIN pg_namespace AS n ON n.oid = t.typnamespace LEFT JOIN pg_class AS c ON c.oid = t.typrelid WHERE t.typnamespace = pg_my_temp_schema() AND t.typelem = 0)`;
  return `SELECT current_setting('server_version_num')::pg_catalog.int4 AS "version", current_setting('standard_conforming_strings') = 'on' AS "conforming", getdatabaseencoding() = 'UTF8' AS "utf8", ${operators} AS "operators", ${trees} AS "trees", ${bodies} AS "bodies", ${temporary} AS "temporary", ${builtinTypes} AS "builtinTypes", ${permanentTypes} AS "permanentTypes", ${keywords} AS "keywords", coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'typeVisible', pg_type_is_visible(c.reltype), 'partition', c.relispartition, 'inherited', ${inherited}, 'hidden', c.relrowsecurity, 'columns', ${columns})) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE (n.nspname, c.relname) IN (${listed})), '[]'::pg_catalog.json) AS "tables"`;
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

/**
 * The types of `value`, a list of JSON's of `[schema, name, visible]` items — of `[name, visible]`
 * items where `schema` is the schema of them all.
 */
function typesOf(value: unknown, schema?: string): KnownType[] {
  const types: KnownType[] = [];
  const items = listOf(value);
  for (const each of items) {
    const parts = Array.isArray(each) ? (each as unknown[]) : [];
    const [namespace, name, visible] = schema === undefined ? parts : [schema, ...parts];
    if (typeof namespace === 'string' && typeof name === 'string') {
      types.push({ name, schema: namespace, visible: visible === true });
    }
  }
  return types;
}

/** The types of the followed tables' columns, and each table's row type, as `tables` says them. */
function tableTypesOf(tables: readonly unknown[]): KnownType[] {
  const types: KnownType[] = [];
  for (const each of tables) {
    const table = recordOf(each) ?? {};
    const columns = listOf(table['columns']);
    for (const column of columns) {
      const type = recordOf(column) ?? {};
      if (typeof type['type'] === 'string' && typeof type['type_schema'] === 'string') {
        types.push({
          name: type['type'],
          schema: type['type_schema'],
          visible: type['visible'] === true,
        });
      }
    }
    if (typeof table['name'] === 'string' && typeof table['schema'] === 'string') {
      types.push({
        name: table['name'],
        schema: table['schema'],
        visible: table['typeVisible'] === true,
      });
    }
  }
  return types;
}

/** The temporary row types whose changes nothing counts, and the temporary types a cast may name. */
interface Temporary {
  readonly known: readonly KnownType[];
  readonly unfollowed: readonly TemporaryRowType[];
}

/**
 * Of the session's temporary types as `temporary` says them, the row types of relations whose
 * changes nothing counts — staging tables' — and those a cast may name, by the schema's own name
 * and as `pg_temp`'s: a domain, an enum, a range, a composite type, and a row type the count
 * follows.
 */
function temporaryOf(value: unknown): Temporary {
  const known: KnownType[] = [];
  const unfollowed: TemporaryRowType[] = [];
  const items = listOf(value);
  for (const each of items) {
    const [schema, name, visible, kind, counted] = Array.isArray(each) ? (each as unknown[]) : [];
    if (typeof schema !== 'string' || typeof name !== 'string') continue;
    const type = { name, schema, visible: visible === true };
    if (kind === null || kind === 'c' || counted === true) {
      known.push(type, { ...type, schema: TEMPORARY_SCHEMA });
    } else if (typeof kind === 'string' && RELATION_KINDS.has(kind)) {
      unfollowed.push(type);
    }
  }
  return { known, unfollowed };
}

/**
 * The types an explicit cast or a typed literal may name, of the initial catalog: PostgreSQL's, the
 * application's, the followed tables' columns' and rows', and the session's temporary types the
 * schema's count follows (`temporaryOf`).
 */
function castTypesOf(
  row: Readonly<Record<string, unknown>>,
  temporary: readonly KnownType[],
): readonly KnownType[] {
  return [
    ...typesOf(row['builtinTypes'], 'pg_catalog'),
    ...typesOf(row['permanentTypes']),
    ...tableTypesOf(listOf(row['tables'])),
    ...temporary,
  ];
}

/** PostgreSQL's keyword classes, without a second query on a render's path. */
function keywordsOf(row: Readonly<Record<string, unknown>>): TypeKeywords | undefined {
  const all = new Set<string>();
  const nonTypes = new Set<string>();
  const reserved = new Set<string>();
  const keywords = listOf(row['keywords']);
  for (const each of keywords) {
    const [word, category] = Array.isArray(each) ? (each as unknown[]) : [];
    if (typeof word !== 'string') continue;
    all.add(word);
    if (category === 'R' || category === 'C') nonTypes.add(word);
    if (category === 'R') reserved.add(word);
  }
  return all.size === 0 ? undefined : { all, nonTypes, reserved };
}

/** Admission metadata stays available even where no row condition can be followed safely. */
function admissionOf(row: Readonly<Record<string, unknown>>, followed: Followed) {
  const temporary = temporaryOf(row['temporary']);
  const castTypes = castTypesOf(row, temporary.known);
  const typeKeywords = keywordsOf(row);
  const unsupported = new Set<string>();
  const tables = listOf(row['tables']);
  for (const each of tables) {
    const table = recordOf(each) ?? {};
    if (table['partition'] !== true && table['kind'] !== 'p' && table['inherited'] !== true)
      continue;
    const declared = followed.byRelation.get(
      relationKey({ name: String(table['name']), schema: String(table['schema']) }),
    );
    if (declared !== undefined) unsupported.add(declared);
  }
  const temporaryTypes = temporary.unfollowed;
  const temporaryBody = listOf(row['bodies']).some((body) => {
    return (
      typeof body === 'string' &&
      (namesTemporaryRowType(body, temporaryTypes, row['conforming'] === true) ||
        unknownTypeCast(body, castTypes, row['conforming'] === true, typeKeywords))
    );
  });
  return { castTypes, temporaryBody, temporaryTypes, typeKeywords, unsupported };
}

/** What the rows `catalogSql` answered say, of the tables `followed` follows. */
export function catalogOf(rows: unknown, followed: Followed): Catalog {
  const [first] = Array.isArray(rows) ? (rows as unknown[]) : [];
  const row = recordOf(first) ?? {};
  const version = row['version'];
  const conforming = row['conforming'] === true;
  const utf8 = row['utf8'] === true;
  const admission = admissionOf(row, followed);
  if (
    typeof version !== 'number' ||
    version < CONDITIONS_SINCE ||
    row['operators'] !== false ||
    renamesIn(row['trees'], row['bodies'], conforming)
  ) {
    return { ...NO_CONDITIONS, ...admission, conforming };
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
  return { ...admission, conforming, hidden, keys, oids, types, typeSchemas };
}
