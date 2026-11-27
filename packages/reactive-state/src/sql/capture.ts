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
 * A transaction's entries are held in a setting of its own until it commits, then written at once
 * and numbered from a sequence, under an advisory lock its commit lets go of (`logFunctionsOf`): two
 * transactions that write followed tables commit in the order of their numbers, so a follower that
 * has read an entry has read every entry before it. No statement of a writer reads the log or takes
 * a row of it, so a writer waits on no transaction but one committing, whatever its isolation. A
 * number a failed commit took stays a gap of the log, which a follower reads past. The sequence is
 * not replicated by a subscription, so a read of the log finds one left behind and moves it past the
 * log, in a new epoch (`store.ts`). The log notifies its channel (`channelOf`) as it commits, for a
 * host to read it then rather than at its next interval. A table followed by the logs of two
 * namespaces holds the triggers of each, named by its namespace; a trigger of the application's of
 * one of those names is replaced, so a namespace is one of the log's own.
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
 * The most bytes of entries one transaction holds: past them, a statement's entries become one
 * naming the table alone. A setting is copied at each statement, so a long transaction pays for
 * what it holds that often.
 */
const HOLD = { bytes: 262_144 } as const;

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
const LOG_TABLES = ['changes', 'ddl', 'head', 'marks'] as const;

/** The indexes of the log's own tables' primary keys, by name. */
const LOG_INDEXES = ['changes_pkey', 'head_pkey'] as const;

/** The sequences of the log's own, by name. */
const LOG_SEQUENCES = ['changes_seq'] as const;

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
  'catch_up()',
  'ddl_count()',
  'fold_ddl(double precision)',
  'hold(pg_catalog.text)',
  'image_sql(pg_catalog.oid,pg_catalog.text[])',
  'next_number()',
  'note(pg_catalog.text,pg_catalog.text)',
  'note_ddl()',
  'note_drop()',
  'prune(double precision)',
  'settle()',
] as const;

/**
 * The log's own functions of SQL's language, by name and the oids of their arguments as `pg_proc`
 * holds them, PostgreSQL's own (`float8`, `oid`, `text[]`): a text no render reads, whose words name
 * no type. Of no name a lookup reads, which a role of no right to the schema fails.
 */
export const LOG_SQL_FUNCTIONS = [
  'ddl_count()',
  'fold_ddl(701)',
  'image_sql(26 1009)',
  'next_number()',
  'prune(701)',
] as const;

/**
 * The functions of the log's own that the role that made it alone may execute, by their names and
 * what each takes: the triggers' functions, which run as that role whoever's statement or commit
 * enters them, and what those call. Another role that may use the log's schema could else attach
 * one of the triggers' functions to a table of its own, whose rows' entries would reach the log, or
 * hold an entry itself (`ownersAloneSql`). The functions a store's role reads the log by, and the
 * event triggers', which only an event trigger runs, are none of them.
 */
const OWNERS_ALONE = {
  capture_all: '',
  capture_deleted: '',
  capture_inserted: '',
  capture_updated: '',
  hold: 'pg_catalog.text',
  image_sql: 'pg_catalog.oid, pg_catalog.text[]',
  note: 'pg_catalog.text, pg_catalog.text',
  settle: '',
} as const;

/**
 * The advisory lock `captureSql()` runs under, one of a database whatever the log's namespace: two
 * hosts that start at once make the log one after the other, and neither fails on the catalog rows
 * the other is writing.
 */
const CAPTURE_LOCK = 0x72_73_63_61;

/**
 * The advisory lock a transaction numbers its entries under, until it commits: one of a database, as
 * two logs of one table would otherwise take theirs in either order, and wait for each other.
 */
const NUMBERING_LOCK = 0x72_73_6e_6f;

/** How many keys one `jsonb_build_object` of a row's image takes: PostgreSQL's 100 arguments. */
const KEYS_A_CALL = 50;

/** The transition tables a trigger names: the rows a statement changed, before it and after it. */
const TRANSITION = { after: 'rows_after', before: 'rows_before' } as const;

/** What `pg_trigger` holds of a trigger of each event: after its statement, of no other event. */
const TRIGGER_TYPES = { DELETE: 8, INSERT: 4, TRUNCATE: 32, UPDATE: 16 } as const;

/** The schema the log and its functions are kept in, unless the host names another. */
export const DEFAULT_NAMESPACE = 'reactive_state';
/** What the event trigger that counts the schema's commands is named, after the log's namespace. */
const DDL_TRIGGER = '_ddl';
/** What the setting a transaction holds its entries in is named, after the log's namespace. */
const HELD = '.held';
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
 * session's temporary schema (`pg_temp`, `pg_temp_3`, `pg_toast_temp_3`) — which a server makes for
 * no one (`CREATE SCHEMA` refuses the prefix), and the standard's `information_schema`. A log there
 * is no application's: a session's goes with it, other sessions see none of it, and the schema's
 * count reads none of their objects.
 */
const SYSTEM_SCHEMA = /^(?:pg_|information_schema$)/u;

/**
 * A session's temporary schema, as a statement's pattern: `pg_temp`, as a command's object says it
 * of the session's own, or a name of the prefixes PostgreSQL reads as temporary (`pg_temp_3`,
 * `pg_toast_temp_3`). A schema of another name of those letters (`pg_tempdata`, which PGlite's
 * single user may make) is the application's.
 */
const TEMPORARY_SCHEMA = "'^pg_temp$|^pg_(toast_)?temp_'";

/**
 * The schema PostgreSQL makes for the application, where its objects are unless it says otherwise:
 * no log's, as the schema's count takes the objects of the log's schema for the log's own.
 */
const DEFAULT_SCHEMA = 'public';

/** `name` as a PostgreSQL identifier: quoted, its quotes doubled. */
export function quoted(name: string): string {
  if (name === '' || Buffer.byteLength(name) > IDENTIFIER_BYTES || name.includes('\0')) {
    throw new TypeError(`\`${name}\` is not a PostgreSQL identifier.`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** `relation` as a statement names it: its schema and its name, each quoted. */
export function qualified(relation: Relation): string {
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
 * The log's own relations, as statements name them: its schema, its head, its entries and what
 * numbers them, the changes of the schema an event trigger counted, and the marks of a transaction
 * that holds entries.
 */
interface LogRelations {
  readonly changes: string;
  readonly ddl: string;
  readonly head: string;
  readonly marks: string;
  readonly schema: string;
  readonly sequence: string;
}

/** The log's own relations in `namespace`. */
export function logOf(namespace: string): LogRelations {
  const schema = quoted(namespace);
  return {
    changes: `${schema}."changes"`,
    ddl: `${schema}."ddl"`,
    head: `${schema}."head"`,
    marks: `${schema}."marks"`,
    schema,
    sequence: `${schema}."changes_seq"`,
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

/** The arguments a trigger holds, as `pg_trigger` keeps them: each ended by a NUL, in hex. */
function triggerArguments(keys: readonly string[]): string {
  return Buffer.from(keys.map((key) => `${key}\0`).join(''), 'utf8').toString('hex');
}

/** A trigger of a followed table's: its event, what it runs, and what it names to that. */
interface Trigger {
  readonly event: keyof typeof TRIGGER_TYPES;
  readonly run: string;
  /** The table's key columns, as the function's arguments. */
  readonly keys: readonly string[];
  /** The transition tables it names, of the rows before the statement and after it. */
  readonly before?: string;
  readonly after?: string;
}

/**
 * The statement of `trigger` on `relation`, named `<namespace>_<event>`, so that the triggers of
 * another namespace's log stay as they are. It is made only where it stands not as it should — of
 * no other name, function, arguments, event, condition or transition tables, and turned on: making
 * one locks the table against writers, and waits for every open transaction that wrote it, which a
 * host's start must not do of a table its triggers stand on.
 */
function triggerOf(relation: Relation, namespace: string, trigger: Trigger): string {
  const { after, before, event, keys, run } = trigger;
  const on = qualified(relation);
  const name = `${namespace}_${event.toLowerCase()}`;
  const signature = `${logOf(namespace).schema}.${quoted(run)}`;
  const identity = `${signature}()`;
  const transition = (table: string | undefined): string =>
    table === undefined ? 'NULL' : literal(table);
  const stands = `EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = ${literal(on)}::pg_catalog.regclass AND t.tgname = ${literal(name)} AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = ${String(TRIGGER_TYPES[event])} AND t.tgqual IS NULL AND t.tgoldtable::pg_catalog.text IS NOT DISTINCT FROM ${transition(before)} AND t.tgnewtable::pg_catalog.text IS NOT DISTINCT FROM ${transition(after)} AND t.tgfoid = ${literal(identity)}::pg_catalog.regprocedure AND t.tgargs = pg_catalog.decode(${literal(triggerArguments(keys))}, 'hex'))`;
  const images = [
    before === undefined ? '' : `OLD TABLE AS ${before} `,
    after === undefined ? '' : `NEW TABLE AS ${after} `,
  ].join('');
  const referencing = images === '' ? '' : `REFERENCING ${images}`;
  const named = keys.map((key) => literal(key)).join(', ');
  const statement = `CREATE OR REPLACE TRIGGER ${quoted(name)} AFTER ${event} ON ${on} ${referencing}FOR EACH STATEMENT EXECUTE FUNCTION ${signature}(${named})`;
  const block = `BEGIN IF NOT ${stands} THEN EXECUTE ${literal(statement)}; END IF; END`;
  return `DO ${literal(block)}`;
}

/** The statements of each trigger a followed table holds: one each of the events it logs. */
function triggersOf(relation: FollowedRelation, namespace: string): readonly string[] {
  const { keys } = relation;
  const { after, before } = TRANSITION;
  const triggers: readonly Trigger[] = [
    { after, event: 'INSERT', keys, run: 'capture_inserted' },
    { after, before, event: 'UPDATE', keys, run: 'capture_updated' },
    { before, event: 'DELETE', keys, run: 'capture_deleted' },
    { event: 'TRUNCATE', keys: [], run: 'capture_all' },
  ];
  return triggers.map((trigger) => triggerOf(relation, namespace, trigger));
}

/** A statement's value of the setting a transaction holds its entries in, of the log of `namespace`. */
function heldOf(namespace: string): string {
  return `coalesce(current_setting(${literal(namespace + HELD)}, true), '')`;
}

/** What the setting opens with where it holds entries of this transaction. */
const OWN_HOLD = `pg_current_xact_id()::pg_catalog.text || ':'`;

/**
 * The statement of a trigger's function that reads the entries of `side`, as the text of a list's
 * items: of each row, `[schema, table, side, image]`.
 */
function entriesRead(side: 'after' | 'before'): string {
  return `EXECUTE format('SELECT string_agg(json_build_array($1, $2, $3, %s)::pg_catalog.text, '','') FROM ${TRANSITION[side]} AS r', "image") INTO "${side}_entries" USING TG_TABLE_SCHEMA, TG_TABLE_NAME, '${side}'::pg_catalog.text`;
}

/**
 * The functions the triggers run: each counts the rows its statement changed and, of at most
 * `ROWS.logged` of them, holds an entry of each row's key values — of an update, the row before
 * and after; past them, for a table of no keys, or past what a transaction holds, one entry naming
 * the table alone. A row's keys are read alone, each as its text (`::text`), by a statement the
 * function writes of the keys its trigger names: a long column the row holds is never read. The
 * statement takes the function's values as parameters, and the function's own variables come
 * before a column of a row of their names.
 */
function rowFunctionsOf(namespace: string): readonly string[] {
  const { schema } = logOf(namespace);
  const held = heldOf(namespace);
  // The rows of each side are counted of their own: an update may take out rows it puts nowhere — a
  // move across partitions a trigger of the partition it goes to skips.
  const made = (name: string, sides: readonly ('after' | 'before')[]): string => {
    const counted = sides
      .map((side) => `SELECT count(*) INTO "${side}_rows" FROM ${TRANSITION[side]}`)
      .join('; ');
    const read = sides.map((side) => entriesRead(side)).join('; ');
    return `CREATE OR REPLACE FUNCTION ${schema}.${quoted(name)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ #variable_conflict use_variable\nDECLARE "before_rows" bigint := 0; "after_rows" bigint := 0; "changed" bigint; "image" text; "before_entries" text; "after_entries" text; "entries" text; BEGIN ${counted}; "changed" := greatest("before_rows", "after_rows"); IF "changed" = 0 THEN RETURN NULL; END IF; IF TG_NARGS = 0 OR "changed" > ${String(ROWS.logged)} THEN PERFORM ${schema}."note"(TG_TABLE_SCHEMA, TG_TABLE_NAME); RETURN NULL; END IF; "image" := ${schema}."image_sql"(TG_RELID, TG_ARGV); ${read}; "entries" := concat_ws(',', "before_entries", "after_entries"); IF octet_length(${held}) + octet_length("entries") > ${String(HOLD.bytes)} THEN PERFORM ${schema}."note"(TG_TABLE_SCHEMA, TG_TABLE_NAME); ELSE PERFORM ${schema}."hold"("entries"); END IF; RETURN NULL; END $$`;
  };
  return [
    // The expression of a row's image, `r`: an object of the text of each key the table still
    // has, of 50 keys a call — as its type's output writes it, by no cast the application may
    // define (an enum's to `text`); a boolean's as `true` or `false` — as its SHA-256, in hex: the
    // log keeps no key's value (a token, an e-mail) a role that may read the log could not read
    // of the table, and a read's condition is of the same digest (`reads.ts`). One dropped since its trigger
    // was made is left out of it, and the store reads the entry as of the table alone
    // (`store.ts`): the write goes on.
    `CREATE OR REPLACE FUNCTION ${schema}."image_sql"("relid" pg_catalog.oid, "keys" pg_catalog.text[]) RETURNS pg_catalog.text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT coalesce(string_agg(format('jsonb_build_object(%s)', c.pairs), ' || ' ORDER BY c.chunk), '''{}''::pg_catalog.jsonb') FROM (SELECT n.chunk, string_agg(format(CASE WHEN n.boolean THEN '%L, CASE WHEN r.%I IS NULL THEN NULL ELSE encode(sha256(convert_to(r.%I::pg_catalog.text, getdatabaseencoding())), ''hex'') END' ELSE '%L, CASE WHEN r.%I IS NULL THEN NULL ELSE encode(sha256(convert_to(format(''%%s'', r.%I), getdatabaseencoding())), ''hex'') END' END, n.name, n.name, n.name), ', ' ORDER BY n.at) AS pairs FROM (SELECT u.name, u.at, (u.at - 1) / ${String(KEYS_A_CALL)} AS chunk, a.atttypid = 'boolean'::regtype AS boolean FROM unnest("keys") WITH ORDINALITY AS u(name, at) JOIN pg_attribute AS a ON a.attrelid = "relid" AND a.attname = u.name AND a.attnum > 0 AND NOT a.attisdropped) AS n GROUP BY n.chunk) AS c $$`,
    made('capture_inserted', ['after']),
    made('capture_deleted', ['before']),
    made('capture_updated', ['before', 'after']),
  ];
}

/**
 * The statement that takes from every role but its owner the execution of each function of
 * `OWNERS_ALONE`, once the statements before it made them. Executable by another role one would be
 * by `PUBLIC`, which a function is made executable by, and `CREATE OR REPLACE` keeps what a function
 * of an installation made before was given; by a role named in the installer's default privileges
 * (`ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO app`), which a function is made with;
 * or by one granted it since, which `CREATE OR REPLACE` keeps as well. So `PUBLIC`'s execution is
 * revoked, and each named role's that is not the owner, each with `CASCADE`, which also takes away
 * what a role with the grant option granted on (an owner's `REVOKE` takes away its own grants
 * alone). What is left is no entry of a function's ACL: a superuser, and a role that is a member of
 * the owner, which has the owner's rights. It is one of the statements of the log, which run as one
 * (`locked`), in one transaction: no committed state has a function made and not yet taken from the
 * others, and a run that fails anywhere leaves none it made.
 */
function ownersAloneSql(namespace: string): string {
  const { schema } = logOf(namespace);
  const signatures = Object.entries(OWNERS_ALONE).map(
    ([name, takes]) => `${schema}.${quoted(name)}(${takes})`,
  );
  const listed = signatures.map((signature) => `(${literal(signature)})`).join(', ');
  return `DO $$ DECLARE "granted" record; BEGIN REVOKE EXECUTE ON FUNCTION ${signatures.join(', ')} FROM PUBLIC CASCADE; FOR "granted" IN SELECT DISTINCT f."signature", x.grantee::pg_catalog.regrole::pg_catalog.text AS "grantee" FROM (VALUES ${listed}) AS f("signature") JOIN pg_catalog.pg_proc AS p ON p.oid = f."signature"::pg_catalog.regprocedure CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS x WHERE x.grantee NOT IN (0, p.proowner) LOOP EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM %s CASCADE', "granted"."signature", "granted"."grantee"); END LOOP; END $$`;
}

/**
 * The functions that hold a transaction's entries and write them as it commits. A statement holds
 * its entries in a setting local to the transaction: a savepoint rolled back takes back what it
 * held, as it takes back the rows it wrote, and no statement reads the log. The setting opens with
 * the transaction's id, as any session may set it: what another left holds nothing of this one.
 *
 * A transaction's first entry inserts a mark, whose deferred trigger runs as it commits. That
 * inserts a second mark, queued after the application's deferred triggers, so that their checks run
 * before the lock and what they write is held too. The second takes the lock its commit lets go of,
 * writes the entries as numbered and empties the setting, so that a statement after `SET CONSTRAINTS
 * ALL IMMEDIATE` holds its own. The list is parsed before the lock, and each mark is deleted by its
 * row: a mark is of no other transaction's. A mark that finds nothing held lost it to a `RESET ALL`,
 * which no entry can tell of: a new epoch renders again whatever read the log. The trigger fires
 * always, as a transaction may turn `session_replication_role` to `replica` before it commits.
 *
 * As the role that made the log, as the triggers' functions are: a writer needs no right of the log,
 * no other role may hold an entry or attach one of those functions to a table (`ownersAloneSql`), and
 * before PostgreSQL 18 a deferred trigger runs as whichever role the transaction commits under.
 */
function logFunctionsOf(namespace: string, channel: string): readonly string[] {
  const { changes, head, marks, schema, sequence } = logOf(namespace);
  const setting = literal(namespace + HELD);
  const held = heldOf(namespace);
  const numbers = `${literal(sequence)}::pg_catalog.regclass`;
  const settling = `${schema}."settle"()`;
  return [
    // The setting before the mark: after `SET CONSTRAINTS ALL IMMEDIATE`, the mark numbers at once.
    `CREATE OR REPLACE FUNCTION ${schema}."hold"("entries" pg_catalog.text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ DECLARE "held" pg_catalog.text := ${held}; "own" pg_catalog.text := ${OWN_HOLD}; BEGIN IF starts_with("held", "own") THEN PERFORM set_config(${setting}, "held" || ',' || "entries", true); ELSE PERFORM set_config(${setting}, "own" || "entries", true); INSERT INTO ${marks} ("stage") VALUES (1); END IF; END $$`,
    // Of the table alone, once a transaction: past what it holds, a long transaction's statements
    // would each add one.
    `CREATE OR REPLACE FUNCTION ${schema}."note"("schema_name" pg_catalog.text, "table_name" pg_catalog.text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ DECLARE "entry" pg_catalog.text := json_build_array("schema_name", "table_name")::pg_catalog.text; "held" pg_catalog.text := ${held}; BEGIN IF NOT starts_with("held", ${OWN_HOLD}) OR strpos("held", "entry") = 0 THEN PERFORM ${schema}."hold"("entry"); END IF; END $$`,
    `CREATE OR REPLACE FUNCTION ${schema}."capture_all"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN PERFORM ${schema}."note"(TG_TABLE_SCHEMA, TG_TABLE_NAME); RETURN NULL; END $$`,
    `CREATE OR REPLACE FUNCTION ${schema}."settle"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE "held" pg_catalog.text; "own" pg_catalog.text := ${OWN_HOLD}; "entries" pg_catalog.jsonb; BEGIN DELETE FROM ${marks} WHERE ctid = NEW.ctid; IF NEW."stage" = 1 THEN INSERT INTO ${marks} ("stage") VALUES (2); RETURN NULL; END IF; "held" := ${held}; IF NOT starts_with("held", "own") THEN UPDATE ${head} SET "epoch" = gen_random_uuid()::pg_catalog.text; RETURN NULL; END IF; "entries" := ('[' || substr("held", length("own") + 1) || ']')::pg_catalog.jsonb; PERFORM pg_advisory_xact_lock(${String(NUMBERING_LOCK)}); INSERT INTO ${changes} ("seq", "schema_name", "table_name", "side", "image") SELECT nextval(${numbers}), e.entry ->> 0, e.entry ->> 1, e.entry ->> 2, e.entry -> 3 FROM jsonb_array_elements("entries") WITH ORDINALITY AS e(entry, at) ORDER BY e.at; PERFORM set_config(${setting}, '', true); PERFORM pg_notify(${channel}, currval(${numbers})::pg_catalog.text); RETURN NULL; END $$`,
    // Of the role that made the log alone, the last of them made: the triggers' functions, which run
    // as that role, and what they call.
    ownersAloneSql(namespace),
    // Made again only where it stands otherwise, as `CREATE OR REPLACE` takes no constraint trigger.
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = ${literal(marks)}::pg_catalog.regclass AND t.tgname = 'settle' AND t.tgenabled = 'A' AND t.tgfoid = ${literal(settling)}::pg_catalog.regprocedure) THEN DROP TRIGGER IF EXISTS "settle" ON ${marks}; CREATE CONSTRAINT TRIGGER "settle" AFTER INSERT ON ${marks} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${settling}; ALTER TABLE ${marks} ENABLE ALWAYS TRIGGER "settle"; END IF; END $$`,
    // Every entry written before `before`, a time in milliseconds, and the head past them, in one
    // commit: of no number but one it deleted, so no writer's commit is ever read as behind it.
    `CREATE OR REPLACE FUNCTION ${schema}."prune"("before" double precision) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ WITH "gone" AS (DELETE FROM ${changes} WHERE "seq" <= (SELECT max("seq") FROM ${changes} WHERE "at" < to_timestamp("before" / 1000)) RETURNING "seq") UPDATE ${head} SET "pruned" = greatest("pruned", (SELECT max(g."seq") FROM "gone" AS g)) WHERE EXISTS (SELECT 1 FROM "gone") $$`,
    // What the next entry is numbered, and a sequence left behind the log moved past it: where a
    // subscription, which copies no sequence, brought entries without their numbers, or a log of a
    // counter row came as it was. In a new epoch, as an entry may have taken a number a follower
    // had read past. Numbers ahead of the log stay as they are, and none moves back under a
    // transaction numbering.
    `CREATE OR REPLACE FUNCTION ${schema}."next_number"() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT CASE WHEN s."is_called" THEN s."last_value" + 1 ELSE s."last_value" END FROM ${sequence} AS s $$`,
    `CREATE OR REPLACE FUNCTION ${schema}."catch_up"() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE "last" bigint; BEGIN SELECT greatest(h."pruned", (SELECT max(c."seq") FROM ${changes} AS c)) INTO "last" FROM ${head} AS h; IF "last" < ${schema}."next_number"() THEN RETURN; END IF; PERFORM pg_advisory_xact_lock(${String(NUMBERING_LOCK)}); PERFORM setval(${numbers}, greatest("last", (SELECT s."last_value" FROM ${sequence} AS s))); UPDATE ${head} SET "epoch" = gen_random_uuid()::pg_catalog.text; END $$`,
    `GRANT EXECUTE ON FUNCTION ${schema}."prune"(double precision), ${schema}."next_number"(), ${schema}."catch_up"() TO PUBLIC`,
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
  const owned = `(SELECT n.nspowner FROM pg_namespace AS n WHERE n.nspname = ${own}) = ${me} AND (SELECT c.relowner FROM pg_class AS c WHERE c.oid = ${literal(ddl)}::pg_catalog.regclass) = ${me}`;
  // Fired in each session, a replica's too (`session_replication_role`), as `ENABLE ALWAYS` says.
  const made = (event: string, name: string, run: string): string => {
    const trigger = quoted(namespace + name);
    return `DO $$ BEGIN IF ${owned} THEN BEGIN CREATE EVENT TRIGGER ${trigger} ON ${event} EXECUTE FUNCTION ${schema}.${quoted(run)}(); EXCEPTION WHEN duplicate_object THEN NULL; END; ALTER EVENT TRIGGER ${trigger} ENABLE ALWAYS; END IF; EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN NULL; END $$`;
  };
  // As the role that made it, of no search path the caller set: a role of no right to the log
  // changes the schema as it may, and is counted; no fault of the count's fails a command. A lock
  // the count may not have does, as any lock would: past the session's `lock_timeout`, which bounds
  // how long a command holds its own, or in a deadlock; and so does a cancel (`statement_timeout`),
  // which `OTHERS` catches not. A command that went on would go uncounted, and one that fails
  // leaves nothing to count, but what a command of several transactions committed before it
  // (`DETACH PARTITION … CONCURRENTLY`, which the digest tells of, and `FINALIZE` ends).
  const counted = (name: string, body: string): string =>
    `CREATE OR REPLACE FUNCTION ${schema}.${quoted(name)}() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN ${body} EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RAISE; WHEN OTHERS THEN NULL; END $$`;
  const note = `INSERT INTO ${ddl} DEFAULT VALUES;`;
  const application = `(an.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', ${own}) AND an.nspname !~ '^pg_(toast_)?temp_')`;
  // A relation or a type of the application's of the name `name`, which a temporary one of it
  // stands before.
  const shadowed = (name: string): string =>
    `EXISTS (SELECT 1 FROM pg_class AS a JOIN pg_namespace AS an ON an.oid = a.relnamespace WHERE a.relname = ${name} AND a.relkind IN (${READ_KINDS}) AND ${application})`;
  const typeShadowed = (name: string): string =>
    `EXISTS (SELECT 1 FROM pg_type AS a JOIN pg_namespace AS an ON an.oid = a.typnamespace WHERE a.typname = ${name} AND (an.nspname = 'pg_catalog' OR ${application}))`;
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
  const relation = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::pg_catalog.regclass WHERE t.relpersistence = 't' AND t.relkind IN (${TEMPORARY_KINDS}) AND (${flagged} OR t.relkind = 'v' OR ${shadowed('t.relname')} OR ${typeShadowed('t.relname')} OR EXISTS (SELECT 1 FROM pg_inherits AS i JOIN pg_class AS p ON p.oid = i.inhparent WHERE i.inhrelid = t.oid AND p.relpersistence <> 't')))`;
  const composite = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::pg_catalog.regclass WHERE t.relkind = 'c' AND t.relnamespace = pg_my_temp_schema())`;
  const named = NAMED_CLASSES.map((name) => `${literal(name)}::pg_catalog.regclass`).join(', ');
  const routine = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c WHERE c.schema_name ~ ${TEMPORARY_SCHEMA} AND c.classid IN (${named}))`;
  // A temporary relation whose row type, or its array, an object a statement names is of — a domain
  // over it, a function's argument or result, a composite type's attribute — of a dependency of its
  // own, which no staging table of `LIKE … INCLUDING ALL` has but its array's; or of a relation that
  // inherits from it, whose columns a change of it changes.
  // A relation that never had children has no descendants. The catalog flag may stay true after
  // its last child goes, which only leaves the walk in place; false safely skips its scans.
  const kin = `WITH RECURSIVE "kin" ("oid") AS (SELECT t.oid UNION SELECT i.inhrelid FROM pg_inherits AS i JOIN "kin" AS k ON i.inhparent = k.oid WHERE t.relhassubclass)`;
  const dependedOn = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c JOIN pg_class AS t ON t.oid = c.objid AND c.classid = 'pg_class'::pg_catalog.regclass WHERE t.relpersistence = 't' AND EXISTS (${kin} SELECT 1 FROM "kin" AS k JOIN pg_class AS r ON r.oid = k.oid JOIN pg_type AS y ON y.oid = r.reltype JOIN pg_depend AS p ON p.refclassid = 'pg_type'::pg_catalog.regclass AND p.refobjid IN (y.oid, y.typarray) AND p.deptype = 'n'))`;
  // An object a statement names, or a relation one is of: counted, but no other relation's change
  // after it, which changes what no name of `pg_temp`'s means — the session's flag is a relation's
  // a statement may read in place of the application's alone.
  const namedTemporary = `(${composite} OR ${routine} OR ${dependedOn})`;
  // Of the log's own schema, each object of the application's put in it — a view, a table, a type,
  // a function — but none of the log's own, which `captureSql()` makes anew as each host starts: its
  // tables, their primary keys and row types, its functions, each by its kind and its identity. Nor
  // the functions of another namespace's log, which its host makes anew as it starts: of a schema
  // whose `note_ddl` an event trigger of the schema's name runs, as none but a superuser makes, and
  // no application's tables of the log's names. All else of that schema is counted, and a log that
  // made no event trigger is counted whole. An identity is read of no quotes, as a drop's is written
  // as the session that dropped it quotes (`quote_all_identifiers`); a name that holds a quote of
  // its own, which PostgreSQL writes doubled, is no log's.
  const anotherLog = (row: 'c' | 'd'): string =>
    `EXISTS (SELECT 1 FROM pg_event_trigger AS e JOIN pg_proc AS p ON p.oid = e.evtfoid JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = ${row}.schema_name AND p.proname = 'note_ddl' AND e.evtname = n.nspname || ${literal(DDL_TRIGGER)})`;
  const of = (name: string): string => `${literal(name)}::pg_catalog.regclass`;
  const theLog = (row: 'c' | 'd'): string => {
    const ofKind = (kind: string, names: readonly string[]): string =>
      `(${row}.classid = ${of(kind)} AND pg_catalog.replace(${row}.object_identity, '"', '') IN (SELECT ${row}.schema_name || '.' || o.name FROM unnest(ARRAY[${names.map((name) => literal(name)).join(', ')}]) AS o(name)))`;
    const inOwn = `${row}.schema_name = ${own}`;
    return `${row}.object_identity !~ '""' AND ((${inOwn} AND (${ofKind('pg_class', [...LOG_TABLES, ...LOG_INDEXES, ...LOG_SEQUENCES])} OR ${ofKind('pg_type', LOG_TABLES)})) OR (${ofKind('pg_proc', LOG_FUNCTIONS)} AND (${inOwn} OR ${anotherLog(row)})))`;
  };
  const commands = `EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() AS c WHERE c.schema_name IS NULL OR (c.schema_name !~ ${TEMPORARY_SCHEMA} AND coalesce(NOT (${theLog('c')}), true)))`;
  // The dropped relations' own row types and their arrays, of the drop's objects read once: a
  // temporary table's drop drops no type a statement names — a domain over it, dropped of
  // `CASCADE`, is none of them. A type is looked up in them by a hash, not a scan of the drop.
  const relations = `r.object_type IN ('table', 'view', 'materialized view', 'sequence', 'foreign table')`;
  const ownRowTypes = `"own" ("identity") AS (SELECT r.object_identity FROM "dropped" AS r WHERE ${relations} UNION ALL SELECT r.object_identity || '[]' FROM "dropped" AS r WHERE ${relations})`;
  const ownRowType = `coalesce(d.object_identity IN (SELECT o."identity" FROM "own" AS o WHERE o."identity" IS NOT NULL), false)`;
  const drops = `EXISTS (SELECT 1 FROM pg_event_trigger_dropped_objects() AS d WHERE d.schema_name IS NULL OR (NOT d.is_temporary AND d.schema_name !~ ${TEMPORARY_SCHEMA} AND coalesce(NOT (${theLog('d')}), true)))`;
  const temporaryDrops = `EXISTS (WITH "dropped" AS MATERIALIZED (SELECT * FROM pg_event_trigger_dropped_objects()), ${ownRowTypes} SELECT 1 FROM "dropped" AS d WHERE d.is_temporary AND ((d.object_type IN ('table', 'view', 'sequence', 'foreign table') AND (${flagged} OR ${shadowed('d.object_name')})) OR (d.object_type IN ('type', 'domain', 'composite type') AND (d.original OR ${flagged} OR ${typeShadowed('d.object_name')} OR NOT ${ownRowType})) OR d.object_type IN ('function', 'procedure', 'aggregate', 'operator', 'operator class', 'operator family', 'collation', 'conversion', 'text search configuration', 'text search dictionary', 'text search parser', 'text search template', 'composite type column')))`;
  return [
    `CREATE TABLE IF NOT EXISTS ${ddl} ("at" timestamptz NOT NULL DEFAULT clock_timestamp(), "n" bigint NOT NULL DEFAULT 1)`,
    // A count of rows a prune folded into one (`pruneSqlChanges`): a log made before it counts each
    // row as one.
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ${literal(ddl)}::pg_catalog.regclass AND attname = 'n' AND NOT attisdropped) THEN ALTER TABLE ${ddl} ADD COLUMN IF NOT EXISTS "n" bigint NOT NULL DEFAULT 1; END IF; END $$`,
    // Its rows deleted as a prune folds them where a publication of all tables publishes deletes,
    // which a table of no replica identity refuses.
    `DO $$ BEGIN IF (SELECT c.relreplident FROM pg_class AS c WHERE c.oid = ${literal(ddl)}::pg_catalog.regclass) <> 'f' THEN ALTER TABLE ${ddl} REPLICA IDENTITY FULL; END IF; END $$`,
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

/** `statements` as one, of the transaction it runs in, under the lock of `captureSql()`. */
function locked(statements: readonly string[]): string {
  const run = statements.map((statement) => `EXECUTE ${literal(statement)};`).join(' ');
  const block = `BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(${String(CAPTURE_LOCK)}); ${run} END`;
  return `DO ${literal(block)}`;
}

/**
 * The statements that make the log in `namespace` and the triggers of each of `relations`, each to
 * be run by itself, in order, as the role that made the log, which may create triggers on the
 * followed tables: one of the log, then one of each table, as a statement that made two tables'
 * triggers would hold the first's lock while it waits on the second's writers. Each runs under a
 * lock two hosts that start at once wait on, and may be run again: a host may run them each time it
 * starts, after the application's migrations, which may have made a followed table again without
 * its triggers. The log's tables keep their rows and gain what an installation made before lacks
 * (the head's `pruned`, which a counter row's `seq` is renamed to; the columns `side` and `image`
 * of `changes`; the sequence that numbers entries, moved past the log in a new epoch where it is
 * behind it; the table `marks`; the column `n` of `ddl`; the `FULL` replica identity of `marks` and
 * of `ddl`); its functions are made anew, which brings an installation made before up to date; and
 * a trigger is made only where it stands not as it should. Another role's run of the log's
 * statement fails whole, as it is one transaction: at the first right it lacks, and of every right
 * short of owning the log's functions at the first function it would replace (`must be owner of
 * function`), by PostgreSQL's rule for `CREATE OR REPLACE FUNCTION`. Its run of a table's statement
 * makes nothing where the table's triggers stand, by the right to use the log's schema alone, and
 * fails where one is to be made: the functions the triggers run are the log's role's alone to
 * execute (`ownersAloneSql`). A role that only writes followed tables needs nothing of the log's
 * schema, and a host that only reads the log needs `USAGE` on the schema and `SELECT` on `head` and
 * `changes`. A table no longer followed keeps its triggers until the application drops them.
 */
export function changeCaptureSql(
  relations: readonly FollowedRelation[],
  namespace: string = DEFAULT_NAMESPACE,
): readonly string[] {
  const { changes, head, marks, schema, sequence } = logOf(checkedNamespace(namespace));
  const channel = literal(channelOf(namespace));
  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    // A log of a counter row: what it counted to is where its entries' numbers go on from.
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${literal(head)}) AND attname = 'seq' AND NOT attisdropped) THEN ALTER TABLE ${head} RENAME COLUMN "seq" TO "pruned"; END IF; END $$`,
    `CREATE TABLE IF NOT EXISTS ${head} ("one" boolean PRIMARY KEY DEFAULT true CHECK ("one"), "epoch" text NOT NULL, "pruned" bigint NOT NULL DEFAULT 0)`,
    // Not `ON CONFLICT DO NOTHING`, which waits on the row a writer's transaction holds to its commit.
    `INSERT INTO ${head} ("epoch") SELECT gen_random_uuid()::pg_catalog.text WHERE NOT EXISTS (SELECT 1 FROM ${head})`,
    `CREATE TABLE IF NOT EXISTS ${changes} ("seq" bigint PRIMARY KEY, "schema_name" text NOT NULL, "table_name" text NOT NULL, "at" timestamptz NOT NULL DEFAULT clock_timestamp())`,
    // A log made before entries kept rows: its entries of none name their tables alone. Altered
    // only where it lacks them, so that a start locks the log for no writer.
    `DO $$ BEGIN IF (SELECT count(*) FROM pg_attribute WHERE attrelid = ${literal(changes)}::pg_catalog.regclass AND attname IN ('side', 'image') AND NOT attisdropped) < 2 THEN ALTER TABLE ${changes} ADD COLUMN IF NOT EXISTS "side" text, ADD COLUMN IF NOT EXISTS "image" jsonb; END IF; END $$`,
    `CREATE SEQUENCE IF NOT EXISTS ${sequence}`,
    `CREATE TABLE IF NOT EXISTS ${marks} ("stage" smallint NOT NULL)`,
    // Its rows deleted as a transaction commits where a publication of all tables publishes deletes,
    // which a table of no replica identity refuses.
    `DO $$ BEGIN IF (SELECT c.relreplident FROM pg_class AS c WHERE c.oid = ${literal(marks)}::pg_catalog.regclass) <> 'f' THEN ALTER TABLE ${marks} REPLICA IDENTITY FULL; END IF; END $$`,
    ...rowFunctionsOf(namespace),
    ...logFunctionsOf(namespace, channel),
    ...ddlCounterOf(namespace),
    // Last, as it may wait on a commit.
    `SELECT ${schema}."catch_up"()`,
  ];
  return [
    locked(statements),
    ...relations.map((relation) => locked(triggersOf(relation, namespace))),
  ];
}
