import { eq } from 'drizzle-orm';
import { pgTable, text as column } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import {
  type ComponentProgram,
  componentRef,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import { database, forbidden, table, text } from '../src/server/index.ts';
import { openedWith } from './support/drizzle.ts';
import { followInternals, logStore, readingThrough } from './support/follow-store.ts';
import { clientOf } from './support/frames.ts';

/**
 * A write to a field the authority keeps, by a component that reads a store's table: what the memo
 * holds of such a read is as fresh as the store's log's last read, so the write runs that component
 * again. A component that read none of a store's tables takes the memo as it would.
 */

const BUILD = 'b_external_writes';
const EDITOR = 'components/editor';
const PARENT = 'components/parent';
const SET_TITLE = 'u_title';
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;

/** The application's members, of a Drizzle schema, which its own database holds. */
const members = pgTable('members', { id: column().primaryKey(), role: column().notNull() });
const DDL = `
  CREATE TABLE members (id text PRIMARY KEY, role text NOT NULL);
  INSERT INTO members VALUES ('alice', 'editor');
`;

/**
 * A database of one member, followed, and of the note the authority keeps, which no public form
 * mixes: declared of the follow's tables, and given a store of its log (`opened`).
 */
async function membersHeld() {
  const setup = await openedWith({ members }, DDL);
  const tables = { ...followInternals(setup.follow).tables, notes: table({ title: text() }) };
  const db = database(tables, { seed: { notes: { n1: { title: 'Kept' } } } });
  return { ...setup, db };
}

type Members = Awaited<ReturnType<typeof membersHeld>>;

/** Whether alice is a member, by her record. */
async function hasRecord({ orm }: Members): Promise<boolean> {
  return (await orm.select().from(members).where(eq(members.id, 'alice'))).length > 0;
}

/** Whether alice is a member, by a query. */
async function isListed({ orm }: Members): Promise<boolean> {
  return (await orm.select().from(members).where(eq(members.role, 'editor'))).length > 0;
}

/** A stand-in for the members' store, of no change its log tells of. */
function membersStore() {
  return logStore(() => Promise.resolve({ changes: [], epoch: 'one', floor: 0, head: 0 }));
}

/** A component as a test writes one, of `evaluate`. */
function program(
  component: string,
  evaluate: ComponentProgram['evaluate'],
  writable: readonly string[] = [],
): ComponentProgram {
  const updaters = writable.length === 0 ? {} : { [SET_TITLE]: { keys: ['title'], kind: 'set' } };
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters: updaters as ComponentProgram['updaters'],
    writable,
  };
}

/** The editor's part: its state bound to the note the authority keeps. */
function editorPart({ db }: Members, $: RenderScope) {
  return $.client({ props: {}, slots: {}, states: { title: db.notes.ref('n1').title } });
}

/**
 * An engine of `programs` of `setup`'s database, rendering `root` for alice, and what writes the
 * note through it.
 */
async function opened(setup: Members, programs: readonly ComponentProgram[], root: string) {
  const store = membersStore();
  const engine = new Engine({
    buildId: BUILD,
    database: readingThrough(setup.db, { [followInternals(setup.follow).storeName]: () => store }),
    externalPollMs: IDLE_POLL_MS,
    programs,
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  const { sessionId } = await engine.login('alice');
  const page = { build: BUILD, component: root, props: {} };
  const rendered = async () => engine.render(sessionId, page);
  const { title } = clientOf((await rendered()).tree, EDITOR).part.states;
  const binding = title !== undefined && 'binding' in title ? title.binding : undefined;
  return {
    rendered,
    write: async (value: string) => {
      const operationId = crypto.randomUUID();
      return engine.update(sessionId, { binding, operationId, updaterId: SET_TITLE, value });
    },
  };
}

/** What the note holds, as a render shows it. */
async function noteOf(rendered: () => ReturnType<Engine['render']>) {
  return (await rendered()).frame.fields['notes:n1:title'];
}

describe('a write to a field the authority keeps', () => {
  it.each([
    ['a record', hasRecord],
    ['a query', isListed],
  ])(
    'refuses what a component refuses now, of %s of a store no log told of',
    async (_, isMember) => {
      const setup = await membersHeld();
      const editor = program(
        EDITOR,
        async (_props, $) => {
          if (!(await isMember(setup))) forbidden();
          return editorPart(setup, $);
        },
        ['title'],
      );
      const { rendered, write } = await opened(setup, [editor], EDITOR);

      await setup.pg.query("DELETE FROM members WHERE id = 'alice'");

      await expect(write('Not mine')).rejects.toMatchObject({ status: 403 });

      await setup.pg.query("INSERT INTO members VALUES ('alice', 'editor')");

      await expect(noteOf(rendered)).resolves.toBe('Kept');
    },
  );

  it('refuses what a component below the root refuses now', async () => {
    const setup = await membersHeld();
    const editor = program(
      EDITOR,
      async (_props, $) => {
        if (!(await hasRecord(setup))) forbidden();
        return editorPart(setup, $);
      },
      ['title'],
    );
    const parent = program(PARENT, (_props, $) => $.h('main', null, $.h(componentRef(EDITOR), {})));
    const { write } = await opened(setup, [editor, parent], PARENT);

    await setup.pg.query("DELETE FROM members WHERE id = 'alice'");

    await expect(write('Not mine')).rejects.toMatchObject({ status: 403 });
  });

  it('takes the memo of a component that read no table of a store', async () => {
    const setup = await membersHeld();
    const evaluate = vi.fn((_props: Readonly<Record<string, Json>>, $: RenderScope) =>
      editorPart(setup, $),
    );
    const editor = program(EDITOR, evaluate, ['title']);
    const { rendered, write } = await opened(setup, [editor], EDITOR);
    const before = evaluate.mock.calls.length;

    await write('Rewritten');

    expect(evaluate).toHaveBeenCalledTimes(before);
    await expect(noteOf(rendered)).resolves.toBe('Rewritten');
  });
});
