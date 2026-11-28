import { eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { streamedRender } from '../src/server/context.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text);
  INSERT INTO tasks VALUES ('t1', 'First');
`;

/** A page that notes, each time it renders, whether an event stream renders it. */
async function noting() {
  const setup = await openedWith(schema, DDL);
  const seen: boolean[] = [];
  const rendering = await engineOf(setup, async (_props, $) => {
    seen.push(streamedRender());
    const rows = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
    return $.h('p', null, rows[0]?.title ?? '');
  });
  return { ...rendering, seen, setup };
}

describe('which render is an event stream’s', { timeout: 20_000 }, () => {
  it('is no page’s: a page’s first answer waits for nothing more', async () => {
    const { rendered, seen } = await noting();

    await rendered();

    expect(seen).toStrictEqual([false]);
  });

  it('is what a stream renders once a change sent its render out of the memo', async () => {
    const { engine, rendered, seen, session, setup } = await noting();
    const shown = await rendered();
    await setup.orm.update(tasks).set({ title: 'Changed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await engine.watch(session, shown.frame.subscription);

    expect(seen).toStrictEqual([false, true]);
  });

  it('follows from the memo what a page rendered, of no render of its own', async () => {
    const { engine, rendered, seen, session } = await noting();
    const shown = await rendered();

    await engine.watch(session, shown.frame.subscription);

    expect(seen).toStrictEqual([false]);
  });

  it('answers no render outside one', () => {
    expect(streamedRender()).toBe(false);
  });
});
