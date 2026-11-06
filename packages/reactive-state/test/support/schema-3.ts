/** Alice’s session in the database of schema 3 below (`SCHEMA_3_DATABASE`). */
// eslint-disable-next-line no-secrets/no-secrets -- the id the authority gave a session in a database of the test's own.
export const SCHEMA_3_SESSION = '4Rut5zgAPna5-kIUQJfHecN_ULeMrHRtqHi_7XETrQg';

/**
 * A database of schema 3, as the authority of `feat/reactive-state-v3` (3971eeadc) left it — its
 * tables and their rows, read back statement by statement — after it opened the test application
 * at midnight UTC on 2026-10-17 by its clock, signed Alice in, and committed three changes a
 * second apart: `createTodo` in p1 (`op-create`), `deleteTodo` of the seed t2 (`op-delete`), and a
 * write of the seed t1’s title (`op-title`).
 */
export const SCHEMA_3_DATABASE: readonly string[] = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE records (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, id))',
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL)',
  'CREATE TABLE versions (resource TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  'CREATE TABLE operations (session_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY (session_id, id))',
  'CREATE INDEX operations_by_kind ON operations (session_id, kind, revision, id)',
  'CREATE TABLE changes (revision INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, changed TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE materializations (key TEXT PRIMARY KEY, declaration TEXT NOT NULL, dependencies TEXT NOT NULL, result TEXT NOT NULL, html TEXT NOT NULL)',
  'CREATE TABLE deliveries (consumer TEXT PRIMARY KEY, revision INTEGER NOT NULL)',
  "INSERT INTO meta VALUES ('revision', '3')",
  "INSERT INTO meta VALUES ('schema', '3')",
  "INSERT INTO meta VALUES ('binding_secret', 'd2d1fe09f477b0ca325385741dbd6aa66ff76b5108000d46931bd2846ef0bf3c')",
  'INSERT INTO records VALUES (\'projects\', \'p1\', \'{"ownerId":"alice","title":"開発"}\')',
  'INSERT INTO records VALUES (\'projects\', \'p2\', \'{"ownerId":"alice","title":"運用"}\')',
  'INSERT INTO records VALUES (\'projects\', \'p3\', \'{"ownerId":"bob","title":"Bob の作業"}\')',
  'INSERT INTO records VALUES (\'memberships\', \'p1-bob\', \'{"projectId":"p1","userId":"bob","canEdit":true}\')',
  'INSERT INTO records VALUES (\'memberships\', \'p2-bob\', \'{"projectId":"p2","userId":"bob","canEdit":true}\')',
  'INSERT INTO records VALUES (\'todos\', \'t1\', \'{"projectId":"p1","title":"一覧を直す","completed":false,"estimate":2}\')',
  'INSERT INTO records VALUES (\'todos\', \'t3\', \'{"projectId":"p2","title":"監視を見直す","completed":false,"estimate":1}\')',
  'INSERT INTO records VALUES (\'counters\', \'main\', \'{"ownerId":"alice","title":"Shared counter","count":0}\')',
  'INSERT INTO records VALUES (\'counters\', \'other\', \'{"ownerId":"alice","title":"Unrelated counter","count":100}\')',
  'INSERT INTO records VALUES (\'todos\', \'uSc8TugldMpKsEqo\', \'{"projectId":"p1","title":"あとで","completed":false,"estimate":0}\')',
  `INSERT INTO sessions VALUES ('${SCHEMA_3_SESSION}', 'alice', 1792281600000, 1)`,
  "INSERT INTO versions VALUES ('todos:uSc8TugldMpKsEqo', 1)",
  "INSERT INTO versions VALUES ('todos:t2', 2)",
  "INSERT INTO versions VALUES ('todos:t1', 3)",
  `INSERT INTO operations VALUES ('${SCHEMA_3_SESSION}', 'op-create', 'operation', 'f40c38ba95584429ddae86b8edec88c4c4f6e4c390a777349bcb655226875b65', 1, 1792195201000, '{"receipt":{"committedRevision":1,"result":null}}')`,
  `INSERT INTO operations VALUES ('${SCHEMA_3_SESSION}', 'op-delete', 'operation', 'f490ea0ad55991586b852f4580a7e1f022110003eef545526746b811b89b7f2e', 2, 1792195202000, '{"receipt":{"committedRevision":2,"result":null}}')`,
  `INSERT INTO operations VALUES ('${SCHEMA_3_SESSION}', 'op-title', 'field', '30a078acd6ae57547b876b7c9cf60f2d6e518fb0062dc88d7845ec6dc1e7557b', 3, 1792195203000, '{"committedRevision":3}')`,
  "INSERT INTO changes VALUES (1, 'event:1', '[\"todos:uSc8TugldMpKsEqo\"]', 'state', 1792195201000)",
  "INSERT INTO changes VALUES (2, 'event:2', '[\"todos:t2\"]', 'state', 1792195202000)",
  "INSERT INTO changes VALUES (3, 'event:3', '[\"todos:t1\"]', 'state', 1792195203000)",
];

/** When the authority that made it opened it: Alice’s session lasts a day from then. */
export const SCHEMA_3_OPENED = Date.UTC(2026, 9, 17);

/** The to-do `op-create` made in it. */
export const SCHEMA_3_CREATED = 'uSc8TugldMpKsEqo';
