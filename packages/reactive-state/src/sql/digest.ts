import { describeThrown } from '../authority/errors.ts';
import type { Relation } from './capture.ts';

/** What runs a statement with its values: a PGlite, or a node-postgres client or pool. */
export interface Queryable {
  readonly query: (
    sql: string,
    values: unknown[],
  ) => Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * What the application's schema is, as a digest the store reads beside its log (`store.ts`): what
 * a plan said of a statement's conditions, and what a render read by them, holds while it stays
 * as it was. It is made of what the catalog defines of the application's schemas — not
 * PostgreSQL's own, nor the log's: each relation (its options, a view's `security_invoker` among
 * them), column, constraint, unique index, inheritance (a temporary table's of the application's
 * too), default and generated expression, rule, function, aggregate, type, enum label, operator,
 * operator class and family, collation, cast, text search configuration and dictionary, and policy;
 * of each relation of the session's temporary schema a statement may read in place of the
 * application's, of the search path and the schemas it resolves to, and of the role the store reads
 * as, by name. It holds what the role the store reads as may read and run besides — of the
 * application's relations, functions, types and schemas, and the roles whose rights it has, which a
 * policy's `TO` names — but not a grant of another's. A table altered, a view or a function defined again, an enum's label renamed, a policy
 * made, a role granted changes it. Nothing a write of rows changes is of it — a refreshed view,
 * statistics; a truncation too, where an event trigger counts the schema's commands — so a change
 * of it is a change of the schema alone. It is read at most once a `DIGEST.everyMs`, so that a page
 * read of the log, each of a turn's and each an operation asks, costs the database no more than it
 * did.
 */

/** How often the schema's digest is read again, at most. */
const DIGEST = { everyMs: 1000 } as const;
/** The first oid PostgreSQL gives what is made after its own catalog (`FirstNormalObjectId`). */
const FIRST_NORMAL_OID = 16_384;
/** The kinds of relation a statement reads by their names: a table, a view, a sequence and kin. */
const READ_KINDS = "'r', 'p', 'v', 'm', 'f', 'S'";
/** Those of them a session's temporary schema holds. */
const TEMPORARY_KINDS = "'r', 'p', 'v', 'f', 'S'";

/**
 * `text` as a PostgreSQL string literal: an escape string, its backslashes and quotes doubled, read
 * alike whatever the session's `standard_conforming_strings` says (a table named `odd\`).
 */
function literal(text: string): string {
  const escaped = text.replaceAll('\\', String.raw`\\`).replaceAll("'", "''");
  return `E'${escaped}'`;
}

/** The followed tables `relations`, as a list of `(schema, name)` pairs. */
function followedList(relations: readonly Relation[]): string {
  const pairs = relations.map(
    (relation) => `(${literal(relation.schema)}, ${literal(relation.name)})`,
  );
  return pairs.length === 0 ? '(NULL, NULL)' : pairs.join(', ');
}

/** `expression`'s text, as a digest PostgreSQL makes of it: SHA-256, which FIPS mode keeps. */
function hashed(expression: string): string {
  return `encode(sha256(convert_to(${expression}, 'UTF8')), 'hex')`;
}

/**
 * The digest of the row `row` of a catalog, but its column of rights `rights`: a grant of another
 * role's changes it not.
 */
function definedOf(row: string, rights: string): string {
  return hashed(`(to_jsonb(${row}) - ${literal(rights)})::text`);
}

/** The digest of the rows of `catalog` whose `column` is `oid`, in their order of `order`. */
function rowsOf(catalog: string, column: string, oid: string, order: string): string {
  const rows = hashed(`coalesce(string_agg(r::text, ',' ORDER BY ${order}), '')`);
  return `(SELECT ${rows} FROM ${catalog} AS r WHERE r.${column} = ${oid})`;
}

/**
 * The roles a statement reads as, as `"readers"`: the session's, and the owner of each view of the
 * application's, whose rights a view that is no `security_invoker` reads its tables by, and whose
 * policies of them it reads by. `own` says which schemas are the application's.
 */
function readersSql(own: string): string {
  return `"readers" AS MATERIALIZED (SELECT r.oid FROM pg_roles AS r WHERE r.rolname = current_user UNION SELECT c.relowner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${own})`;
}

/** Of each role a statement reads as (`readersSql`), by its oid `r.oid`, what `answers` answers. */
function readersOf(answers: string): string {
  return `(SELECT string_agg(concat_ws('.', r.oid, ${answers}), ',' ORDER BY r.oid) FROM "readers" AS r)`;
}

/** What the catalog defines of the application's relations: `own` says which schemas are its. */
function relationParts(own: string): readonly string[] {
  const related = (column: string): string =>
    `JOIN pg_class AS c ON c.oid = ${column} JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE ${own}`;
  return [
    // An index's own relation is of no digest: what a unique one says is (`u`). Of each other, what
    // each role a statement reads as may read of it, which a statement that reads it fails without;
    // and of a column, the rights granted of it alone, to any role.
    `SELECT concat_ws(':', 'c', c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, c.reloptions::text, ${readersOf("has_table_privilege(r.oid, c.oid, 'SELECT'), has_any_column_privilege(r.oid, c.oid, 'SELECT')")}) AS x FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE ${own} AND c.relkind NOT IN ('i', 'I')`,
    `SELECT concat_ws(':', 'a', a.attrelid, a.attnum, a.attname, a.atttypid, a.atttypmod, a.attcollation, a.attnotnull, a.attisdropped, a.attgenerated, a.attacl::text) FROM pg_attribute AS a ${related('a.attrelid')} AND a.attnum > 0 AND c.relkind NOT IN ('i', 'I')`,
    // A column's default and a generated column's expression: one set again rewrites its rows.
    `SELECT concat_ws(':', 'd', d.adrelid, d.adnum, ${hashed('pg_get_expr(d.adbin, d.adrelid)')}) FROM pg_attrdef AS d ${related('d.adrelid')}`,
    // A table that inherits from one of the application's — a temporary one too — whose rows a
    // statement that reads it reads besides.
    `SELECT concat_ws(':', 'i', i.inhrelid, i.inhparent, i.inhseqno) FROM pg_inherits AS i ${related('i.inhparent')}`,
    `SELECT concat_ws(':', 'k', k.oid, k.conrelid, k.contype, ${hashed('pg_get_constraintdef(k.oid)')}) FROM pg_constraint AS k ${related('k.conrelid')}`,
    // A unique index, by which a plan leaves out an outer join that adds no rows: one dropped reads
    // the join again. By its name, which an index built again (`REINDEX CONCURRENTLY`) keeps.
    `SELECT concat_ws(':', 'u', x.indrelid, ci.relname, x.indkey::text, x.indclass::text, x.indcollation::text, x.indimmediate, x.indisvalid, ${hashed("coalesce(pg_get_expr(x.indpred, x.indrelid), '')")}, ${hashed("coalesce(pg_get_expr(x.indexprs, x.indrelid), '')")}) FROM pg_index AS x JOIN pg_class AS ci ON ci.oid = x.indexrelid ${related('x.indrelid')} AND x.indisunique`,
    `SELECT concat_ws(':', 'r', r.oid, ${hashed('r.ev_action::text')}, ${hashed("coalesce(r.ev_qual::text, '')")}) FROM pg_rewrite AS r ${related('r.ev_class')}`,
    `SELECT concat_ws(':', 'p', p.oid, ${hashed('p::text')}) FROM pg_policy AS p`,
  ];
}

/** What the catalog defines in the application's schemas but its relations. */
function definitionParts(own: string): readonly string[] {
  const of = (namespace: string): string =>
    `JOIN pg_namespace AS n ON n.oid = ${namespace} WHERE ${own}`;
  const ofType = of('t.typnamespace');
  return [
    `SELECT concat_ws(':', 'f', p.oid, ${definedOf('p', 'proacl')}, has_function_privilege(p.oid, 'EXECUTE')) FROM pg_proc AS p ${of('p.pronamespace')}`,
    // An aggregate's functions and first state, which `CREATE OR REPLACE AGGREGATE` sets again.
    `SELECT concat_ws(':', 'g', g.aggfnoid, ${hashed('g::text')}) FROM pg_aggregate AS g JOIN pg_proc AS p ON p.oid = g.aggfnoid ${of('p.pronamespace')}`,
    `SELECT concat_ws(':', 't', t.oid, ${definedOf('t', 'typacl')}, has_type_privilege(t.oid, 'USAGE')) FROM pg_type AS t ${ofType}`,
    `SELECT concat_ws(':', 'e', e.oid, e.enumtypid, e.enumsortorder, e.enumlabel) FROM pg_enum AS e JOIN pg_type AS t ON t.oid = e.enumtypid ${ofType}`,
    // A domain's constraints, which its type's own row says nothing of.
    `SELECT concat_ws(':', 'kd', k.oid, k.contypid, ${hashed('pg_get_constraintdef(k.oid)')}) FROM pg_constraint AS k JOIN pg_type AS t ON t.oid = k.contypid ${ofType}`,
    `SELECT concat_ws(':', 'o', o.oid, ${hashed('o::text')}) FROM pg_operator AS o ${of('o.oprnamespace')}`,
    // An operator class and family: what an index's and a sort's comparisons are.
    `SELECT concat_ws(':', 'q', q.oid, ${hashed('q::text')}) FROM pg_opclass AS q ${of('q.opcnamespace')}`,
    `SELECT concat_ws(':', 'h', h.oid, ${hashed('h::text')}, ${rowsOf('pg_amop', 'amopfamily', 'h.oid', 'r.oid')}, ${rowsOf('pg_amproc', 'amprocfamily', 'h.oid', 'r.oid')}) FROM pg_opfamily AS h ${of('h.opfnamespace')}`,
    `SELECT concat_ws(':', 'l', l.oid, ${hashed('l::text')}) FROM pg_collation AS l ${of('l.collnamespace')}`,
    // The casts of the application's: PostgreSQL's own are numbered below its first free oid.
    `SELECT concat_ws(':', 'x', x.oid, x.castsource, x.casttarget, x.castfunc, x.castcontext, x.castmethod) FROM pg_cast AS x WHERE x.oid >= ${String(FIRST_NORMAL_OID)}`,
    // Text search: a configuration and the dictionaries it maps each kind of token to, a
    // dictionary's options, a parser and a template.
    `SELECT concat_ws(':', 'y', y.oid, ${hashed('y::text')}, ${rowsOf('pg_ts_config_map', 'mapcfg', 'y.oid', 'r.maptokentype, r.mapseqno')}) FROM pg_ts_config AS y ${of('y.cfgnamespace')}`,
    `SELECT concat_ws(':', 'b', b.oid, ${hashed('b::text')}) FROM pg_ts_dict AS b ${of('b.dictnamespace')}`,
    `SELECT concat_ws(':', 'z', z.oid, ${hashed('z::text')}) FROM pg_ts_parser AS z ${of('z.prsnamespace')}`,
    `SELECT concat_ws(':', 'j', j.oid, ${hashed('j::text')}) FROM pg_ts_template AS j ${of('j.tmplnamespace')}`,
  ];
}

/**
 * What a statement reads by besides, of the session the store reads through and of its role: its
 * temporary relations, the search path, the schemas it may use, the roles whose rights it has; and
 * where no event trigger counts the schema's commands, the file each followed table's rows are in.
 */
function sessionParts(own: string, relations: readonly Relation[]): readonly string[] {
  return [
    // A view of the session's temporary schema, with its options (`security_invoker`, which says
    // by whose rights and policies the view's tables are read; none is of no more than before); a
    // relation or a type of it of a name of the application's, which a statement's name of it
    // resolves to first; and a function of it, which a statement names as `pg_temp`'s: a temporary
    // table a plan names is one nothing follows, a fault of the render once a plan is asked again.
    `SELECT concat_ws(':', 'v', c.oid, c.relname, c.reloptions::text, ${hashed('r.ev_action::text')}) FROM pg_class AS c JOIN pg_rewrite AS r ON r.ev_class = c.oid WHERE c.relnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'm', t.oid, t.relname, t.relkind) FROM pg_class AS t WHERE t.relnamespace = pg_my_temp_schema() AND t.relkind IN (${TEMPORARY_KINDS}) AND EXISTS (SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relname = t.relname AND c.relkind IN (${READ_KINDS}) AND ${own})`,
    // A temporary type of a name of the application's, which a statement's name of it resolves to
    // first, and every one a statement names as `pg_temp`'s — but a table's row type and an array,
    // unless an object a statement names is of it or of its array (a domain over it, a function's
    // result).
    `SELECT concat_ws(':', 'tt', t.oid, t.typname, ${definedOf('t', 'typacl')}, ${rowsOf('pg_constraint', 'contypid', 't.oid', 'r.oid')}, ${rowsOf('pg_enum', 'enumtypid', 't.oid', 'r.enumsortorder')}, ${rowsOf('pg_attribute', 'attrelid', 't.typrelid', 'r.attnum')}) FROM pg_type AS t LEFT JOIN pg_class AS k ON k.oid = t.typrelid WHERE t.typnamespace = pg_my_temp_schema() AND (t.typname IN (SELECT o.typname FROM pg_type AS o JOIN pg_namespace AS n ON n.oid = o.typnamespace WHERE ${own}) OR (t.typelem = 0 AND (t.typrelid = 0 OR k.relkind = 'c')) OR EXISTS (SELECT 1 FROM pg_depend AS p WHERE p.refclassid = 'pg_type'::regclass AND p.refobjid IN (t.oid, t.typarray) AND p.deptype = 'n'))`,
    `SELECT concat_ws(':', 'tf', p.oid, ${definedOf('p', 'proacl')}) FROM pg_proc AS p WHERE p.pronamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'to', o.oid, ${hashed('o::text')}) FROM pg_operator AS o WHERE o.oprnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'tl', l.oid, ${hashed('l::text')}) FROM pg_collation AS l WHERE l.collnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'ty', y.oid, ${hashed('y::text')}, ${rowsOf('pg_ts_config_map', 'mapcfg', 'y.oid', 'r.maptokentype, r.mapseqno')}) FROM pg_ts_config AS y WHERE y.cfgnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'tb', b.oid, ${hashed('b::text')}) FROM pg_ts_dict AS b WHERE b.dictnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'tz', z.oid, ${hashed('z::text')}) FROM pg_ts_parser AS z WHERE z.prsnamespace = pg_my_temp_schema()`,
    `SELECT concat_ws(':', 'tj', j.oid, ${hashed('j::text')}) FROM pg_ts_template AS j WHERE j.tmplnamespace = pg_my_temp_schema()`,
    // The file a followed table's rows are in: a command that rewrites them of no other definition —
    // a column's type set to its own `USING` an expression — makes another, which a session that
    // fires no event trigger (`event_triggers`) is counted of by nothing else; so does a
    // truncation, of the table alone.
    `SELECT concat_ws(':', 'w', c.oid, c.relfilenode) FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE (n.nspname, c.relname) IN (${followedList(relations)})`,
    `SELECT concat_ws(':', 'n', n.oid, n.nspname, has_schema_privilege(n.oid, 'USAGE')) FROM pg_namespace AS n WHERE ${own}`,
    // Each role's own rights over every row, and the roles whose rights it has, inherited or not:
    // a policy's `TO`.
    `SELECT concat_ws(':', 'role', s.oid, s.rolsuper, s.rolinherit, s.rolbypassrls, CASE WHEN s.rolsuper THEN '' ELSE (SELECT string_agg(concat_ws('.', g.oid, pg_has_role(s.oid, g.oid, 'USAGE')), ',' ORDER BY g.oid) FROM pg_roles AS g WHERE pg_has_role(s.oid, g.oid, 'MEMBER')) END) FROM pg_roles AS s WHERE s.oid IN (SELECT r.oid FROM "readers" AS r)`,
    // The role the session reads as and the one it logged in as, by name, which a policy may name
    // (`current_user`, `session_user`): the rows a statement reads differ with them where no right
    // does, as the readers' rights say nothing of which of them reads; quoted, so that no two pairs
    // of names make one text. The search path as it is set, the schemas it resolves to —
    // `"$user"`'s, of the role — whether a policy's rows are read or refused (`row_security`), how a
    // string's `\` is read, and what a plan folds of the session's settings: a float's or a
    // `bytea`'s text, whose functions PostgreSQL holds immutable (`extra_float_digits`,
    // `bytea_output`), a date's, a time's, an interval's or an array's constant as its text is read
    // (`DateStyle`, `TimeZone`, `timezone_abbreviations`, `IntervalStyle`, `array_nulls`), and
    // `= NULL` read as `IS NULL` (`transform_null_equals`).
    `SELECT concat_ws(':', 's', quote_ident(current_user), quote_ident(session_user), current_setting('search_path'), current_schemas(false)::text, current_setting('row_security'), current_setting('standard_conforming_strings'), current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('DateStyle'), current_setting('TimeZone'), current_setting('timezone_abbreviations'), current_setting('IntervalStyle'), current_setting('array_nulls'), current_setting('transform_null_equals'))`,
  ];
}

/** The statement that answers the digest of the schema, as `"digest"`, of the followed `relations`. */
function digestSql(relations: readonly Relation[]): string {
  // The application's schemas: not PostgreSQL's own, nor a session's temporary one. The log's is of
  // them, whose own objects change as `captureSql()` makes them anew alone: an object of the
  // application's put in it is followed as any other.
  const own = `(n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(toast_)?temp_')`;
  const parts = [...relationParts(own), ...definitionParts(own), ...sessionParts(own, relations)];
  return `WITH ${readersSql(own)} SELECT ${hashed("coalesce(string_agg(f.x, ',' ORDER BY f.x), '')")} AS "digest" FROM (${parts.join(' UNION ALL ')}) AS f`;
}

/**
 * The schema's digest, read through `client` at most once a `DIGEST.everyMs`; and how many times
 * it was another than the one read before — the first read's too, for a plan kept before it.
 */
export class SchemaDigest {
  readonly #client: Queryable;
  readonly #statement: string;
  readonly #clock: () => number;
  #read: { readonly digest: string; readonly at: number } | undefined;
  #unread = 0;

  constructor(client: Queryable, relations: readonly Relation[], clock: () => number = Date.now) {
    this.#client = client;
    this.#statement = digestSql(relations);
    this.#clock = clock;
  }

  /**
   * The digest, and whether it is another than the one read before it, or the first: read anew of a
   * `fresh` one, though the one before was read within `DIGEST.everyMs`.
   */
  async read(fresh = false): Promise<{ readonly digest: string; readonly changed: boolean }> {
    const now = this.#clock();
    const kept = this.#read;
    if (!fresh && kept !== undefined && now - kept.at < DIGEST.everyMs) {
      return { changed: false, digest: kept.digest };
    }
    let digest: unknown;
    try {
      const [row] = (await this.#client.query(this.#statement, [])).rows;
      digest = typeof row === 'object' && row !== null ? Reflect.get(row, 'digest') : undefined;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`The schema's digest was not read: ${describeThrown(error)}`);
    }
    if (typeof digest !== 'string') {
      // A schema not known is another than any read before: everything renders again, every plan
      // is asked again, and the next read asks anew — the log's changes are followed on.
      this.#read = undefined;
      this.#unread += 1;
      return { changed: true, digest: `unread-${String(this.#unread)}` };
    }
    this.#read = { at: now, digest };
    return { changed: digest !== kept?.digest, digest };
  }
}
