/**
 * The change log a PostgreSQL database keeps of the tables an authority follows, as triggers write
 * it in the writing transaction: whichever code wrote the table — the application's Drizzle, a
 * migration, `psql` — the log tells of it. A statement that changed rows of a followed table
 * appends an entry of each row it changed — of each row an update changed, one of the row before
 * it and one after — holding the values of the table's key columns (`keys.ts`) as PostgreSQL
 * writes them as text: what read rows of those values is rendered again. A statement that changed
 * more rows than `ROWS.logged`, or a table of no key columns, appends one entry naming the table
 * alone, which renders again whatever read the table; so does a `TRUNCATE`. A statement that
 * changed no row appends none.
 *
 * Each entry's number is taken from one counter row, which the writing transaction holds until it
 * commits: two transactions that write followed tables commit in the order of their numbers, so a
 * follower that has read an entry has read every entry before it. That orders those writers as
 * PostgreSQL orders writes of one row. The row is taken as the statement that first writes a
 * followed table ends, after that statement's own rows, and held to the end of the transaction: a
 * transaction whose later statement writes a row that another transaction's statement has written
 * meanwhile can deadlock with it where, without the capture, it would only have waited for it.
 * PostgreSQL ends one of the two with `40P01`, and an application retries that transaction as it
 * retries any deadlock. The log notifies its channel (`channelOf`) as it commits, for a host to
 * read it then rather than at its next interval. A table followed by the logs of two namespaces
 * holds the triggers of each, named by its namespace; a trigger of the application's of one of
 * those names is replaced, so a namespace is one of the log's own.
 *
 * The functions the triggers run, which are the only writers of the log, are `SECURITY DEFINER`: they
 * run as the role that made the log, so a role that writes a followed table needs no right to the
 * log's schema, and only the role that made it may call `note` itself or attach one of them to a
 * table. Their search path stays `pg_catalog, pg_temp`.
 */

/** A table of the application's, as PostgreSQL names it. */
export interface Relation {
  readonly schema: string;
  readonly name: string;
}

/** A table the log follows: and the key columns whose values it keeps of each changed row. */
export interface FollowedRelation extends Relation {
  readonly keys: readonly string[];
}

/**
 * The most rows of one statement the log keeps an entry of each of; past them, one entry names the
 * table alone.
 */
const ROWS = { logged: 100 } as const;

/**
 * The commands that change nothing a plan says — a right, a comment, a refreshed view, an index
 * made or built again, a trigger made or altered, which changes what a write does but no read —
 * which the schema's count leaves out: else each would render everything again, the log's own
 * triggers made again as each host starts too. An index made unique may let a plan leave out a join
 * it would have read, but a plan asked before reads more, never less; one dropped is counted
 * (`note_drop`), and so is `ALTER INDEX`, which may name a table.
 */
const SCHEMA_KEPT = [
  'ALTER DEFAULT PRIVILEGES',
  'ALTER TRIGGER',
  'COMMENT',
  'CREATE INDEX',
  'CREATE TRIGGER',
  'GRANT',
  'REFRESH MATERIALIZED VIEW',
  'REINDEX',
  'REVOKE',
  'SECURITY LABEL',
] as const;

/** The log's own tables in its schema, by name: of each, a relation and a row type. */
const LOG_TABLES = ['changes', 'ddl', 'head'] as const;

/** The indexes of the log's own tables' primary keys, by name. */
const LOG_INDEXES = ['changes_pkey', 'head_pkey'] as const;

/**
 * The functions of the log's own, which `captureSql()` makes anew in its schema, by their
 * signatures as PostgreSQL writes a function's identity: an application's function of one of
 * their names but other arguments is none of them.
 */
const LOG_FUNCTIONS = [
  'capture_all()',
  'capture_deleted()',
  'capture_inserted()',
  'capture_updated()',
  'ddl_count()',
  'fold_ddl(double precision)',
  'image_sql(pg_catalog.oid,pg_catalog.text[])',
  'note(pg_catalog.text,pg_catalog.text)',
  'note_ddl()',
  'note_drop()',
] as const;

/** How many keys one `jsonb_build_object` of a row's image takes: PostgreSQL's 100 arguments. */
const KEYS_A_CALL = 50;

/** The transition tables a trigger names: the rows a statement changed, before it and after it. */
const TRANSITION = { after: '"rows_after"', before: '"rows_before"' } as const;

/** The schema the log and its functions are kept in, unless the host names another. */
export const DEFAULT_NAMESPACE = 'reactive_state';
/** What the event trigger that counts the schema's commands is named, after the log's namespace. */
const DDL_TRIGGER = '_ddl';
/** The kinds of relation a statement reads by their names: a table, a view, a sequence and kin. */
const READ_KINDS = "'r', 'p', 'v', 'm', 'f', 'S'";
/** Those of them a session's temporary schema holds. */
const TEMPORARY_KINDS = "'r', 'p', 'v', 'f', 'S'";
/**
 * What the setting of a session's is named, after the log's namespace, that says it made a
 * temporary relation a statement may read in place of the application's, or beside it.
 */
const TEMPORARY_READ = '.read_temporary';

/** The longest PostgreSQL identifier, in bytes, past which PostgreSQL cuts one short. */
const IDENTIFIER_BYTES = 63;

/**
 * A namespace's form: a name PostgreSQL holds as it is written, unquoted, as a host writes its
 * channel in `LISTEN` — PGlite's `listen` too — which folds a name of capitals to lower case.
 */
const NAMESPACE = /^[a-z_][a-z0-9_]*$/u;

/**
 * A schema PostgreSQL keeps for itself: each name of `pg_` — its catalog, its TOAST tables, a
 * session's temporary schema (`pg_temp`, `pg_temp_3`, `pg_toast_temp_3`), which the event trigger
 * reads of any name of `pg_temp` — which a server makes for no one (`CREATE SCHEMA` refuses the
 * prefix), and the standard's `information_schema`. A log there is no application's: a session's
 * goes with it, other sessions see none of it, and the schema's count reads none of their objects.
 */
const SYSTEM_SCHEMA = /^(?:pg_|information_schema$)/u;

/**
 * The schema PostgreSQL makes for the application, where its objects are unless it says otherwise:
 * no log's, as the schema's count takes the objects of the log's schema for the log's own.
 */
const DEFAULT_SCHEMA = 'public';

/** `name` as a PostgreSQL identifier: quoted, its quotes doubled. */
function quoted(name: string): string {
  if (name === '' || Buffer.byteLength(name) > IDENTIFIER_BYTES || name.includes('\0')) {
    throw new TypeError(`\`${name}\` is not a PostgreSQL identifier.`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** `relation` as a statement names it: its schema and its name, each quoted. */
function qualified(relation: Relation): string {
  return `${quoted(relation.schema)}.${quoted(relation.name)}`;
}

/** A name a relation's key holds unquoted: of no `.` and no `"`, which would make two keys one. */
const UNQUOTED = /^[^".]*$/u;

/**
 * What a relation is keyed by in the log and in a query's plan: `schema.name`, unquoted; of a name
 * that holds a `.` or a `"`, each quoted, its quotes doubled.
 */
export function relationKey(relation: Relation): string {
  if (UNQUOTED.test(relation.schema) && UNQUOTED.test(relation.name)) {
    return `${relation.schema}.${relation.name}`;
  }
  const schema = relation.schema.replaceAll('"', '""');
  const name = relation.name.replaceAll('"', '""');
  return `"${schema}"."${name}"`;
}

/**
 * The log's own relations, as statements name them: its schema, its head, its entries, and the
 * changes of the schema an event trigger counted.
 */
interface LogRelations {
  readonly changes: string;
  readonly ddl: string;
  readonly head: string;
  readonly schema: string;
}

/** The log's own relations in `namespace`. */
export function logOf(namespace: string): LogRelations {
  const schema = quoted(namespace);
  return {
    changes: `${schema}."changes"`,
    ddl: `${schema}."ddl"`,
    head: `${schema}."head"`,
    schema,
  };
}

/**
 * `namespace`, refused where it is no name PostgreSQL holds unquoted, a schema PostgreSQL keeps for
 * itself or makes for the application, or where a name of its triggers would be cut short, as two
 * of them would alike.
 */
function checkedNamespace(namespace: string): string {
  if (!NAMESPACE.test(namespace)) {
    throw new TypeError(
      `\`${namespace}\` is not a namespace: a name PostgreSQL holds unquoted, of lower-case letters, digits and \`_\`.`,
    );
  }
  if (SYSTEM_SCHEMA.test(namespace)) {
    throw new TypeError(
      `\`${namespace}\` is not a namespace: a name of \`pg_\` is PostgreSQL's own, whose prefix \`CREATE SCHEMA\` refuses, and so is \`information_schema\`.`,
    );
  }
  if (namespace === DEFAULT_SCHEMA) {
    throw new TypeError(
      `\`${namespace}\` is not a namespace: it is the application's own default schema, whose objects the log's count would take for the log's.`,
    );
  }
  quoted(`${namespace}_truncate`);
  return namespace;
}

/**
 * What the log in `namespace` notifies as an entry commits, which a host listens on:
 * `<namespace>_changes`.
 */
export function channelOf(namespace: string): string {
  return `${checkedNamespace(namespace)}_changes`;
}

/**
 * `text` as a PostgreSQL string literal: an escape string, its backslashes and quotes doubled, read
 * alike whatever the session's `standard_conforming_strings` says (a table named `odd\`).
 */
function literal(text: string): string {
  const escaped = text.replaceAll('\\', String.raw`\\`).replaceAll("'", "''");
  return `E'${escaped}'`;
}

/**
 * `create`, a statement that makes a function the role that made the log alone may execute, with
 * what every other role is given of it taken away (`signature` names it), as one statement: a `DO`
 * block runs them in the transaction of its one statement, so that no committed state has the
 * function executable by a role but its owner — not between two statements, which a role that may
 * use the log's schema could meet, and not where an installation stops after the first. Executable
 * by another role it would be by `PUBLIC`, which `CREATE OR REPLACE` keeps for a function an
 * installation made before made so; by a role named in the installer's default privileges
 * (`ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO app`), which a function is made with;
 * or by one granted it since, which `CREATE OR REPLACE` keeps as well. So `PUBLIC`'s execution is
 * revoked, and each named role's that is not the owner, each with `CASCADE`, which also takes away
 * what a role with the grant option granted on (an owner's `REVOKE` takes away its own grants
 * alone). What is left is no entry of the function's ACL: a superuser, and a role that is a member
 * of the owner, which has the owner's rights. The function's own body is quoted by `$$`, the block
 * by another tag.
 */
function restricted(create: string, signature: string): string {
  const named = literal(signature);
  return `DO $restricted$ DECLARE "who" text; BEGIN ${create}; REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC CASCADE; FOR "who" IN SELECT DISTINCT x.grantee::pg_catalog.regrole::text FROM pg_catalog.pg_proc AS p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS x WHERE p.oid = ${named}::pg_catalog.regprocedure AND x.grantee NOT IN (0, p.proowner) LOOP EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM %s CASCADE', ${named}, "who"); END LOOP; END $restricted$`;
}

/**
 * The statements of each trigger a followed table holds: one each of the events it logs, named
 * `<namespace>_<event>`, so that the triggers of another namespace's log stay as they are. Each
 * names the table's key columns to the function it runs, as its arguments.
 */
function triggersOf(relation: FollowedRelation, namespace: string): readonly string[] {
  const on = qualified(relation);
  const { schema } = logOf(namespace);
  const keys = relation.keys.map((key) => literal(key)).join(', ');
  const named = (event: string): string => quoted(`${namespace}_${event.toLowerCase()}`);
  const logged = (event: string, images: string, run: string): string =>
    `CREATE OR REPLACE TRIGGER ${named(event)} AFTER ${event} ON ${on} REFERENCING ${images} FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.${quoted(run)}(${keys})`;
  return [
    logged('INSERT', `NEW TABLE AS ${TRANSITION.after}`, 'capture_inserted'),
    logged(
      'UPDATE',
      `OLD TABLE AS ${TRANSITION.before} NEW TABLE AS ${TRANSITION.after}`,
      'capture_updated',
    ),
    logged('DELETE', `OLD TABLE AS ${TRANSITION.before}`, 'capture_deleted'),
    `CREATE OR REPLACE TRIGGER ${named('TRUNCATE')} AFTER TRUNCATE ON ${on} FOR EACH STATEMENT EXECUTE FUNCTION ${schema}."capture_all"()`,
  ];
}

/**
 * The functions the triggers run: each counts the rows its statement changed and, of at most
 * `ROWS.logged` of them, appends an entry of each row's key values — of an update, the row before
 * and after — numbered in one move of the head; past them, or for a table of no keys, it appends
 * one entry naming the table alone. A row's keys are read alone, each as its text (`::text`), by a
 * statement the function writes of the keys its trigger names: a long column the row holds is
 * never read. The statement takes the function's values as parameters, and the function's own
 * variables come before a column of a row of their names.
 */
function rowFunctionsOf(namespace: string, channel: string): readonly string[] {
  const { changes, head, schema } = logOf(namespace);
  // Each row's entries are numbered after those of the rows before it: "last" is the head moved
  // past them all, "total" how many it moved.
  const logged = (side: 'after' | 'before', rows: string, offset: string): string =>
    `EXECUTE format('INSERT INTO ${changes} ("seq", "schema_name", "table_name", "side", "image") SELECT $1 - $2 + $5 + row_number() OVER (), $3, $4, $6, %s FROM ${rows} AS r', "image") USING "last", "total", TG_TABLE_SCHEMA, TG_TABLE_NAME, ${offset}, '${side}'::text`;
  // The rows of each side are counted and numbered of their own: an update may take out rows it
  // puts nowhere — a move across partitions a trigger of the partition it goes to skips.
  const made = (name: string, sides: readonly ('after' | 'before')[]): string => {
    const counted = sides
      .map((side) => `SELECT count(*) INTO "${side}_rows" FROM ${TRANSITION[side]}`)
      .join('; ');
    const inserts = sides
      .map((side) =>
        logged(side, TRANSITION[side], side === 'after' ? '"before_rows"' : '0::bigint'),
      )
      .join('; ');
    return `CREATE OR REPLACE FUNCTION ${schema}.${quoted(name)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ #variable_conflict use_variable\nDECLARE "before_rows" bigint := 0; "after_rows" bigint := 0; "changed" bigint; "total" bigint; "last" bigint; "image" text; BEGIN ${counted}; "changed" := greatest("before_rows", "after_rows"); IF "changed" = 0 THEN RETURN NULL; END IF; IF TG_NARGS = 0 OR "changed" > ${String(ROWS.logged)} THEN PERFORM ${schema}."note"(TG_TABLE_SCHEMA, TG_TABLE_NAME); RETURN NULL; END IF; "total" := "before_rows" + "after_rows"; "image" := ${schema}."image_sql"(TG_RELID, TG_ARGV); UPDATE ${head} SET "seq" = "seq" + "total" RETURNING "seq" INTO "last"; ${inserts}; PERFORM pg_notify(${channel}, "last"::text); RETURN NULL; END $$`;
  };
  return [
    // The expression of a row's image, `r`: an object of the text of each key the table still
    // has, of 50 keys a call — as its type's output writes it, by no cast the application may
    // define (an enum's to `text`); a boolean's as `true` or `false` — as its SHA-256, in hex: the
    // log keeps no key's value (a token, an e-mail) a role that may read the log could not read
    // of the table, and a read's condition is of the same digest (`reads.ts`). One dropped since its trigger
    // was made is left out of it, and the store reads the entry as of the table alone
    // (`store.ts`): the write goes on.
    `CREATE OR REPLACE FUNCTION ${schema}."image_sql"("relid" oid, "keys" text[]) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT coalesce(string_agg(format('jsonb_build_object(%s)', c.pairs), ' || ' ORDER BY c.chunk), '''{}''::jsonb') FROM (SELECT n.chunk, string_agg(format(CASE WHEN n.boolean THEN '%L, CASE WHEN r.%I IS NULL THEN NULL ELSE encode(sha256(convert_to(r.%I::text, getdatabaseencoding())), ''hex'') END' ELSE '%L, CASE WHEN r.%I IS NULL THEN NULL ELSE encode(sha256(convert_to(format(''%%s'', r.%I), getdatabaseencoding())), ''hex'') END' END, n.name, n.name, n.name), ', ' ORDER BY n.at) AS pairs FROM (SELECT u.name, u.at, (u.at - 1) / ${String(KEYS_A_CALL)} AS chunk, a.atttypid = 'boolean'::regtype AS boolean FROM unnest("keys") WITH ORDINALITY AS u(name, at) JOIN pg_attribute AS a ON a.attrelid = "relid" AND a.attname = u.name AND a.attnum > 0 AND NOT a.attisdropped) AS n GROUP BY n.chunk) AS c $$`,
    // Of each writer, which the trigger's function calls it as, though the database's default
    // privileges keep functions from `PUBLIC`: it reads the catalog's attributes alone.
    `GRANT EXECUTE ON FUNCTION ${schema}."image_sql"(oid, text[]) TO PUBLIC`,
    // As `capture_all`'s: a trigger needs the right as it is made, and runs without it.
    restricted(made('capture_inserted', ['after']), `${schema}."capture_inserted"()`),
    restricted(made('capture_deleted', ['before']), `${schema}."capture_deleted"()`),
    restricted(made('capture_updated', ['before', 'after']), `${schema}."capture_updated"()`),
  ];
}

/**
 * The catalogs of the objects of a session's temporary schema a statement names as `pg_temp`'s,
 * whose making or altering changes what a plan of it reads (their drops are counted by kind).
 */
const NAMED_CLASSES = [
  'pg_collation',
  'pg_conversion',
  'pg_opclass',
  'pg_operator',
  'pg_opfamily',
  'pg_proc',
  'pg_ts_config',
  'pg_ts_dict',
  'pg_ts_parser',
  'pg_ts_template',
  'pg_type',
] as const;

/**
 * The statements that count each change of the database's schema, by an event trigger of each
 * command — a table altered, a view or a function defined again, an enum's label renamed — and of
 * each drop, which appends a row to the log's own `"ddl"` table, and the store counts its rows
 * beside the log as they commit: no change is missed, though it is made and made back between two
 * reads of the schema's digest. A row of its own, which no writer's trigger takes, holds no writer
 * behind a migration, nor a migration behind a writer. Where the host may not make an event trigger
 * — a role that is no superuser, or one that does not own both the log's schema and its count — the
 * digest alone tells, once a second at most.
 */
function ddlCounterOf(namespace: string): readonly string[] {
  const { ddl, schema } = logOf(namespace);
  const own = literal(namespace);
  const skipped = SCHEMA_KEPT.map((tag) => literal(tag)).join(', ');
  const me = '(SELECT r.oid FROM pg_roles AS r WHERE r.rolname = current_user)';
  // Made only where the log's schema and its count are the role's own: else the role that made them
  // first would own what the event trigger's function, run as its maker, writes into.
  const owned = `(SELECT n.nspowner FROM pg_namespace AS n WHERE n.nspname = ${own}) = ${me} AND (SELECT c.relowner FROM pg_class AS c WHERE c.oid = ${literal(ddl)}::regclass) = ${me}`;
  // Fired in each session, a replica's too (`session_replication_role`), as `ENABLE ALWAYS` says.
  const made = (event: string, name: string, run: string): string => {
    const trigger = quoted(namespace + name);
    return `DO $$ BEGIN IF ${owned} THEN BEGIN CREATE EVENT TRIGGER ${trigger} ON ${event} EXECUTE FUNCTION ${schema}.${quoted(run)}(); EXCEPTION WHEN duplicate_object THEN NULL; END; ALTER EVENT TRIGGER ${trigger} ENABLE ALWAYS; END IF; EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN NULL; END $$`;
  };
  // As the role that made it, of no search path the caller set: a role of no right to the log
  // changes the schema as it may, and is counted; nothing of the count fails a command. Of no
  // quoting the caller set either (`quote_all_identifiers`), as a command's object's identity is
  // written as the function reads it, and the log's own are known by theirs.
  const counted = (name: string, body: string): string =>
    `CREATE OR REPLACE FUNCTION ${schema}.${quoted(name)}() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET quote_all_identifiers = off AS $$ BEGIN ${body} EXCEPTION WHEN OTHERS THEN NULL; END $$`;
  const note = `INSERT INTO ${ddl} DEFAULT VALUES;`;
  const application = `(an.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', ${own}) AND an.nspname !~ '^pg_(toast_)?temp_')`;
  // A relation or a type of the application's of the name `name`, which a temporary one of it
  // stands before.
  const shadowed = (name: string): string =>
    `EXISTS (SELECT 1 FROM pg_class AS a JOIN pg_namespace AS an ON an.oid = a.relnamespace WHERE a.relname = ${name} AND a.relkind IN (${READ_KINDS}) AND ${application})`;
  const typeShadowed = (name: string): string =>
    `EXISTS (SELECT 1 FROM pg_type AS a JOIN pg_namespace AS an ON an.oid = a.typnamespace WHERE a.typname = ${name} AND ${application})`;
  // Whether the session made a relation of its temporary schema a statement may read in place of
  // the application's, or beside it: each change of its temporary relations is counted from then.
  const flag = literal(namespace + TEMPORARY_READ);
  const flagged = `coalesce(current_setting(${flag}, true), '') = 'on'`;
  // Such a relation: a view, a table or a sequence of a name of the application's relations, which
  // a statement's name of it resolves to first, or one that inherits from the application's table;
  // and an object of the schema a statement names as `pg_temp`'s — a type, a composite type's
  // attributes, a function, an operator, a collation, a text search object, an operator class or
  // family, a conversion — but none it names not, a constraint or statistics of a temporary table's,
  // nor the table's own alterations, which its making of `LIKE … INCLUDING ALL` holds.
  const relation = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::regclass WHERE t.relpersistence = 't' AND t.relkind IN (${TEMPORARY_KINDS}) AND (${flagged} OR t.relkind = 'v' OR ${shadowed('t.relname')} OR ${typeShadowed('t.relname')} OR EXISTS (SELECT 1 FROM pg_inherits AS i JOIN pg_class AS p ON p.oid = i.inhparent WHERE i.inhrelid = t.oid AND p.relpersistence <> 't')))`;
  const composite = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::regclass WHERE t.relkind = 'c' AND t.relnamespace = pg_my_temp_schema())`;
  const named = NAMED_CLASSES.map((name) => `${literal(name)}::regclass`).join(', ');
  const routine = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c WHERE c.schema_name ~ '^pg_(toast_)?temp' AND c.classid IN (${named}))`;
  // A temporary relation whose row type, or its array, an object a statement names is of — a domain
  // over it, a function's argument or result, a composite type's attribute — of a dependency of its
  // own, which no staging table of `LIKE … INCLUDING ALL` has but its array's; or of a relation that
  // inherits from it, whose columns a change of it changes.
  // A relation that never had children has no descendants. The catalog flag may stay true after
  // its last child goes, which only leaves the walk in place; false safely skips its scans.
  const kin = `WITH RECURSIVE "kin" ("oid") AS (SELECT t.oid UNION SELECT i.inhrelid FROM pg_inherits AS i JOIN "kin" AS k ON i.inhparent = k.oid WHERE t.relhassubclass)`;
  const dependedOn = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::regclass WHERE t.relpersistence = 't' AND EXISTS (${kin} SELECT 1 FROM "kin" AS k JOIN pg_class AS r ON r.oid = k.oid JOIN pg_type AS y ON y.oid = r.reltype JOIN pg_depend AS p ON p.refclassid = 'pg_type'::regclass AND p.refobjid IN (y.oid, y.typarray) AND p.deptype = 'n'))`;
  // An object a statement names, or a relation one is of: counted, but no other relation's change
  // after it, which changes what no name of `pg_temp`'s means — the session's flag is a relation's
  // a statement may read in place of the application's alone.
  const namedTemporary = `(${composite} OR ${routine} OR ${dependedOn})`;
  // Of the log's own schema, each object of the application's put in it — a view, a table, a type,
  // a function — but none of the log's own, which `captureSql()` makes anew as each host starts: its
  // tables, their primary keys and row types, its functions, each by its kind and its identity.
  const identities = (names: readonly string[]): string =>
    `(SELECT pg_catalog.quote_ident(${own}) || '.' || o.name FROM unnest(ARRAY[${names.map((name) => literal(name)).join(', ')}]) AS o(name))`;
  const of = (name: string): string => `${literal(name)}::pg_catalog.regclass`;
  const logRelations = identities([...LOG_TABLES, ...LOG_INDEXES]);
  const theLog = (row: 'c' | 'd'): string =>
    `(${row}.classid = ${of('pg_class')} AND ${row}.object_identity IN ${logRelations}) OR (${row}.classid = ${of('pg_type')} AND ${row}.object_identity IN ${identities(LOG_TABLES)}) OR (${row}.classid = ${of('pg_proc')} AND ${row}.object_identity IN ${identities(LOG_FUNCTIONS)})`;
  const ownMade = `coalesce(NOT (${theLog('c')}), true)`;
  const ownDropped = `coalesce(NOT (${theLog('d')}), true)`;
  const commands = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c WHERE c.schema_name IS NULL OR (c.schema_name !~ '^pg_(toast_)?temp' AND (c.schema_name <> ${own} OR ${ownMade})))`;
  // The dropped relations' own row types and their arrays, of the drop's objects read once: a
  // temporary table's drop drops no type a statement names — a domain over it, dropped of
  // `CASCADE`, is none of them. A type is looked up in them by a hash, not a scan of the drop.
  const relations = `r.object_type IN ('table', 'view', 'materialized view', 'sequence', 'foreign table')`;
  const ownRowTypes = `"own" ("identity") AS (SELECT r.object_identity FROM "dropped" AS r WHERE ${relations} UNION ALL SELECT r.object_identity || '[]' FROM "dropped" AS r WHERE ${relations})`;
  const ownRowType = `coalesce(d.object_identity IN (SELECT o."identity" FROM "own" AS o WHERE o."identity" IS NOT NULL), false)`;
  const drops = `EXISTS (SELECT 1 FROM pg_event_trigger_dropped_objects() AS d WHERE d.schema_name IS NULL OR (NOT d.is_temporary AND d.schema_name !~ '^pg_(toast_)?temp' AND (d.schema_name <> ${own} OR ${ownDropped})))`;
  const temporaryDrops = `EXISTS (WITH "dropped" AS MATERIALIZED (SELECT * FROM pg_event_trigger_dropped_objects()), ${ownRowTypes} SELECT 1 FROM "dropped" AS d WHERE d.is_temporary AND ((d.object_type IN ('table', 'view', 'sequence', 'foreign table') AND (${flagged} OR ${shadowed('d.object_name')})) OR (d.object_type IN ('type', 'domain', 'composite type') AND (d.original OR ${flagged} OR ${typeShadowed('d.object_name')} OR NOT ${ownRowType})) OR d.object_type IN ('function', 'procedure', 'aggregate', 'operator', 'operator class', 'operator family', 'collation', 'conversion', 'text search configuration', 'text search dictionary', 'text search parser', 'text search template', 'composite type column')))`;
  return [
    `CREATE TABLE IF NOT EXISTS ${ddl} ("at" timestamptz NOT NULL DEFAULT clock_timestamp(), "n" bigint NOT NULL DEFAULT 1)`,
    // A count of rows a prune folded into one (`pruneSqlChanges`): a log made before it counts each
    // row as one.
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ${literal(ddl)}::regclass AND attname = 'n' AND NOT attisdropped) THEN ALTER TABLE ${ddl} ADD COLUMN IF NOT EXISTS "n" bigint NOT NULL DEFAULT 1; END IF; END $$`,
    // Its rows deleted as a prune folds them where a publication of all tables publishes deletes,
    // which a table of no replica identity refuses.
    `DO $$ BEGIN IF (SELECT c.relreplident FROM pg_class AS c WHERE c.oid = ${literal(ddl)}::regclass) <> 'f' THEN ALTER TABLE ${ddl} REPLICA IDENTITY FULL; END IF; END $$`,
    // The count, and the fold of rows a prune makes (`pruneSqlChanges`), as the role that made the
    // log: a store's role of the rights it had on the log before this table is no other's.
    `CREATE OR REPLACE FUNCTION ${schema}."ddl_count"() RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT coalesce(sum("n"), 0) FROM ${ddl} $$`,
    `CREATE OR REPLACE FUNCTION ${schema}."fold_ddl"("before" double precision) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ WITH "gone" AS (DELETE FROM ${ddl} WHERE "at" < to_timestamp("before" / 1000) RETURNING "n") INSERT INTO ${ddl} ("n") SELECT sum(g."n") FROM "gone" AS g HAVING count(*) > 0 $$`,
    // Of any role that may use the log's schema, though the database's default privileges keep
    // functions from `PUBLIC`: the count says how many, and the fold keeps their sum.
    `GRANT EXECUTE ON FUNCTION ${schema}."ddl_count"(), ${schema}."fold_ddl"(double precision) TO PUBLIC`,
    // A command that made or changed an object of the application's: one that changed nothing (`IF
    // NOT EXISTS` of one there is), or of the log's own, is not; nor is one of temporary objects,
    // unless of a relation a statement may read in place of the application's, or beside it.
    counted(
      'note_ddl',
      `IF TG_TAG IN (${skipped}) THEN RETURN; END IF; IF ${commands} THEN ${note} ELSIF ${relation} THEN PERFORM set_config(${flag}, 'on', false); ${note} ELSIF ${namedTemporary} THEN ${note} END IF;`,
    ),
    // A command that dropped an object of the application's — an index among them, which a plan may
    // have relied on being unique: a drop of nothing, or of temporary objects alone, is not, unless
    // of a temporary relation of a name of the application's, or once the session made one such.
    counted('note_drop', `IF ${drops} OR ${temporaryDrops} THEN ${note} END IF;`),
    made('ddl_command_end', DDL_TRIGGER, 'note_ddl'),
    made('sql_drop', '_drop', 'note_drop'),
  ];
}

/**
 * The statements that make the log in `namespace` and the triggers of each of `relations`, each to
 * be run by itself, in order, as the role that made the log, which may create triggers on the
 * followed tables: once, or each time a host starts, after the application's migrations, which may
 * have made a followed table again without its triggers. Each may be run again: the log's tables
 * keep their rows and gain what an installation made before lacks (the column `n` of `ddl` and its
 * `FULL` replica identity, the columns `side` and `image` of `changes`), and its functions and
 * triggers are made anew, which brings an installation made before up to date. Another role's run
 * fails at the first function it would replace (`must be owner of function`), by PostgreSQL's rule
 * for `CREATE OR REPLACE FUNCTION`. A function that only the role that made the log may execute is
 * made in the one statement that takes every other role's execution from it (`restricted`), so
 * that a run that stops anywhere leaves none executable by a role that may use the log's schema. A role that
 * only writes followed tables needs nothing of the log's schema, and a host that only reads the log
 * runs none of them: it needs `USAGE` on the schema and `SELECT` on `head` and `changes`. A table
 * no longer followed keeps its triggers until the application drops them.
 */
export function changeCaptureSql(
  relations: readonly FollowedRelation[],
  namespace: string = DEFAULT_NAMESPACE,
): readonly string[] {
  const { changes, head, schema } = logOf(checkedNamespace(namespace));
  const channel = literal(channelOf(namespace));
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${head} ("one" boolean PRIMARY KEY DEFAULT true CHECK ("one"), "epoch" text NOT NULL, "seq" bigint NOT NULL DEFAULT 0)`,
    `INSERT INTO ${head} ("epoch") VALUES (gen_random_uuid()::text) ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS ${changes} ("seq" bigint PRIMARY KEY, "schema_name" text NOT NULL, "table_name" text NOT NULL, "at" timestamptz NOT NULL DEFAULT clock_timestamp())`,
    // A log made before entries kept rows: its entries of none name their tables alone. Altered
    // only where it lacks them, so that a start locks the log for no writer.
    `DO $$ BEGIN IF (SELECT count(*) FROM pg_attribute WHERE attrelid = ${literal(changes)}::regclass AND attname IN ('side', 'image') AND NOT attisdropped) < 2 THEN ALTER TABLE ${changes} ADD COLUMN IF NOT EXISTS "side" text, ADD COLUMN IF NOT EXISTS "image" jsonb; END IF; END $$`,
    // Of the role that made the log alone, of which the functions run: any other that may use the
    // log's schema could else append an entry that renders what read a table again, or attach a
    // trigger function to a table of its own.
    restricted(
      `CREATE OR REPLACE FUNCTION ${schema}."note"("schema_name" text, "table_name" text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE "next" bigint; BEGIN UPDATE ${head} SET "seq" = "seq" + 1 RETURNING "seq" INTO "next"; INSERT INTO ${changes} ("seq", "schema_name", "table_name") VALUES ("next", "schema_name", "table_name"); PERFORM pg_notify(${channel}, "next"::text); END $$`,
      `${schema}."note"(text, text)`,
    ),
    restricted(
      `CREATE OR REPLACE FUNCTION ${schema}."capture_all"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN PERFORM ${schema}."note"(TG_TABLE_SCHEMA, TG_TABLE_NAME); RETURN NULL; END $$`,
      `${schema}."capture_all"()`,
    ),
    ...rowFunctionsOf(namespace, channel),
    ...ddlCounterOf(namespace),
    ...relations.flatMap((relation) => triggersOf(relation, namespace)),
  ];
}
