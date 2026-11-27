/**
 * The light entry of a D1 binding whose answers count each statement's own changes, not the rows
 * the change log's triggers write beside them (`./own-changes`): `ownChanges` of
 * `sql/sqlite/own-changes.ts` alone, a module that imports none but the reading of SQL's text
 * (`where.ts`) and a set of no imports (`tracked.ts`), so a Worker of the application's own that
 * writes followed tables holds no authority, no Drizzle and no React.
 */
export { ownChanges } from './sql/sqlite/own-changes.ts';
