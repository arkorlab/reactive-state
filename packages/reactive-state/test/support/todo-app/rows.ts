import { and, eq } from 'drizzle-orm';

import { db } from './db.ts';
import { counters, memberships, todos } from './schema.ts';

/**
 * The rows the test application's states bind, as its components name them: a to-do and a
 * membership by their id and their project's, a counter by its id. A frame names a bound field by
 * a digest of the condition (`todos:<digest>:title`) where it named the record's id before: a test
 * finds the key of a field by the same row (`fieldKey(todoRow('p1', 't1').title)`).
 */

/** The columns a state binds of a row of a table of the application's. */
type Row<K extends keyof typeof db> = (typeof db)[K] extends {
  readonly where: (condition: never) => infer R;
}
  ? R
  : never;

export function todoRow(projectId: string, id: string): Row<'todos'> {
  return db.todos.where(and(eq(todos.id, id), eq(todos.projectId, projectId)));
}

export function membershipRow(projectId: string, id: string): Row<'memberships'> {
  return db.memberships.where(and(eq(memberships.id, id), eq(memberships.projectId, projectId)));
}

export function counterRow(id: string): Row<'counters'> {
  return db.counters.where(eq(counters.id, id));
}
