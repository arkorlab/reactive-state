/** The table of the authority's own entries — its revision, its schema — which is made first. */
export const META = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

/** The records the declaration seeds that the database was seeded with, by table and id. */
const SEEDED =
  'CREATE TABLE IF NOT EXISTS seeded (tbl TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tbl, id))';

/**
 * Each record a commit wrote that the database no longer holds, noted as seeded: `versions` names
 * every record a commit wrote — by `table:id`, which neither holds a colon of its own — and lets go
 * of none.
 */
const DELETED_AS_SEEDED = `INSERT OR IGNORE INTO seeded SELECT tbl, id FROM (SELECT substr(resource, 1, instr(resource, ':') - 1) AS tbl, substr(resource, instr(resource, ':') + 1) AS id FROM versions) AS written WHERE NOT EXISTS (SELECT 1 FROM records WHERE records.tbl = written.tbl AND records.id = written.id)`;

/**
 * The authority's tables, one statement each, as a Durable Object's storage takes them. Every record
 * of the application's declared tables is a row of `records`, its fields one JSON object: the
 * declaration says what each field holds, and the engine checks every value against it before it is
 * written; each record the declaration seeded is named in `seeded`, which the seed is made once by.
 * An operation is kept by its session and the id the session gave it, which a resend names
 * again; every frame reads the session's newest writes to fields, so those are indexed by session,
 * kind and revision, with their ids: the read takes the newest few from the index alone, however
 * long the history grows. A shared view — a route's document every visitor is answered with — is
 * kept with what it read, its generation and its access epoch (`views`), and the artifacts of each
 * generation beside it (`artifacts`), each with the deployment of the site that made it: a restarted
 * authority knows what it published, of which deployment, and what a commit made dirty before it
 * stopped. A key the application's server asserted sessions under and then ended is kept as long
 * as one of its sessions could still be presented (`ended`): nothing else of an asserted session is
 * kept, but for the receipts of its operations.
 */
export const SCHEMA: readonly string[] = [
  META,
  'CREATE TABLE IF NOT EXISTS records (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, id))',
  SEEDED,
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS versions (resource TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS operations (session_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY (session_id, id))',
  'CREATE INDEX IF NOT EXISTS operations_by_kind ON operations (session_id, kind, revision, id)',
  'CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, changed TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS materializations (key TEXT PRIMARY KEY, declaration TEXT NOT NULL, dependencies TEXT NOT NULL, result TEXT NOT NULL, html TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS deliveries (consumer TEXT PRIMARY KEY, revision INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS views (key TEXT PRIMARY KEY, route TEXT NOT NULL, params TEXT NOT NULL, build TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, digest TEXT NOT NULL, dependencies TEXT NOT NULL, revision INTEGER NOT NULL, observed INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS artifacts (view TEXT NOT NULL, generation INTEGER NOT NULL, profile TEXT NOT NULL, deployment TEXT NOT NULL, etag TEXT NOT NULL, headers TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (view, generation, profile))',
  'CREATE TABLE IF NOT EXISTS ended (key TEXT PRIMARY KEY, until INTEGER NOT NULL)',
  "INSERT OR IGNORE INTO meta VALUES ('revision', '0')",
];

/**
 * The version of the tables above, which `meta` keeps as `schema`: a database of another — an
 * earlier authority's, whose operations were kept otherwise — is refused rather than misread,
 * unless it is of one `MIGRATIONS` brings up to this.
 */
export const SCHEMA_VERSION = 5;

/**
 * What brings a database of an earlier schema up to this one, by the schema it is of: run in one
 * transaction, with the new version kept, before the tables above are made where they are not.
 * Schema 3's tables hold what they hold here, each row read as it was written; it lacks only those
 * schema 4 added — `seeded`, `views` and `artifacts` — and every record, session, operation and
 * change it kept is kept. It made each seed it lacked at every open, and noted none: a seed the
 * application deleted since is noted as seeded, with every record a commit deleted, and stays
 * deleted, while one the declaration gained since — which no commit wrote — is made.
 * Schema 4's artifacts are let go of whole: they name no deployment of the site, so none answers a
 * question that names one, and a gate asks for each view's anew, as for a view that has none.
 * `ended` came after schema 5 and is schema 5's still: made as a database opens, empty, which an
 * authority that knows nothing of it leaves alone.
 */
export const MIGRATIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['3', [SEEDED, DELETED_AS_SEEDED]],
  ['4', ['DROP TABLE IF EXISTS artifacts']],
]);

/**
 * The demo's users: no password, chosen on a page that is never served beyond this machine. The
 * fixtures give Carol nothing: what a session sees of what it may not.
 */
export const DEMO_USERS: readonly string[] = ['alice', 'bob', 'carol'];
