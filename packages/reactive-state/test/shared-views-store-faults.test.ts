import { describe, expect, it, type MockInstance, onTestFinished, vi } from 'vitest';

import { AuthorityEngine } from '../src/authority/engine.ts';
import { nodeSql } from '../src/authority/node-sql.ts';
import type { SqlDriver } from '../src/authority/sql.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import type { GateAnswer, RouteRegistration } from '../src/routing.ts';
import { boolean, database, forbidden, table } from '../src/server/index.ts';

/**
 * A shared view whose evaluation the store fails to keep — the view's row (`SharedStore.put`), or
 * the access epoch its revocation takes (`nextEpoch`) — has faulted, as one whose root threw has:
 * the requests the gate holds for it answer 503 at once, never left to wait out their deadline for a
 * view that moves no more.
 */

const BUILD = 'b_store_faults';
const NOTE = '/notes/[id]';
/** How long the gate holds a request: far past how long a test waits for its answer. */
const GATE_WAIT_MS = 60_000;
/** How long a gate's answer is waited for: far short of `GATE_WAIT_MS`, and of the test's time. */
const WAIT_MS = 2000;

const db = database(
  { notes: table({ shown: boolean() }) },
  { seed: { notes: { a: { shown: true } } } },
);

/** A note that is shown; the generic refusal of one that is not. */
async function note(props: Readonly<Record<string, unknown>>, $: RenderScope): Promise<unknown> {
  const found = await db.notes.get(String(props['id']));
  if (found?.shown !== true) {
    forbidden();
  }
  return $.h('p', null, 'shown');
}

const program: ComponentProgram = {
  buildId: BUILD,
  component: 'components/note',
  evaluate: note,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The note's page, which every visitor is shown alike. */
const route: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'notes/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: program.component,
  route: NOTE,
  shared: true,
};

/** Hides a note: its page is refused from then on, to every visitor. */
const notes = {
  async hide(id: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.notes.update(String(id), { shown: false });
    });
  },
};

/** Node's SQLite in memory, whose statements that begin with `failing`'s text fail once it is set. */
function faultySql(): { readonly sql: SqlDriver; failing: string | undefined } {
  const sql = nodeSql(':memory:');
  const faulty: { readonly sql: SqlDriver; failing: string | undefined } = {
    failing: undefined,
    sql: {
      ...sql,
      run: (query, ...parameters) => {
        if (faulty.failing !== undefined && query.startsWith(faulty.failing)) {
          throw new Error('database or disk is full');
        }
        sql.run(query, ...parameters);
      },
    },
  };
  return faulty;
}

/** The authority of the note's page over `sql`, which no site renders the page for. */
function engineOf(sql: SqlDriver): AuthorityEngine {
  const engine = new AuthorityEngine({
    buildId: BUILD,
    database: db,
    gateWaitMs: GATE_WAIT_MS,
    operations: { 'actions/notes': notes },
    programs: [program],
    routes: [route],
    sql,
  });
  onTestFinished(async () => {
    await engine.close();
  });
  return engine;
}

/** The gate's answer to a visitor's request for note `a`'s page; `pending` while it holds it still. */
async function gated(engine: AuthorityEngine): Promise<GateAnswer | 'pending'> {
  const timer = new Promise<'pending'>((resolve) => {
    setTimeout(() => {
      resolve('pending');
    }, WAIT_MS);
  });
  return Promise.race([
    engine.gate({ headers: {}, method: 'GET', route: NOTE, url: '/notes/a' }),
    timer,
  ]);
}

/** What the authority logs of a view it could not keep, kept out of the output: the test reads it. */
function silenced(): MockInstance<(...data: unknown[]) => void> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // The test asserts what is logged.
  });
  onTestFinished(() => {
    logged.mockRestore();
  });
  return logged;
}

describe('a shared view’s evaluation the store fails to keep', () => {
  it('answers the requests the gate holds 503 at once where its row is not kept', async () => {
    const logged = silenced();
    const faulty = faultySql();
    const engine = engineOf(faulty.sql);
    faulty.failing = 'INSERT OR REPLACE INTO views';

    const answer = await gated(engine);

    expect(answer).toMatchObject({ kind: 'respond', status: 503 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('database or disk is full'));
  });

  it('answers them 503 at once where the epoch of its revocation is not kept', async () => {
    const logged = silenced();
    const faulty = faultySql();
    const engine = engineOf(faulty.sql);
    const { sessionId } = await engine.login('alice');
    // A page shows the view, and the note is hidden after: the view is to be revoked, with an epoch
    // of its own, once it is evaluated again.
    const shown = await engine.renderShared(null, {
      build: BUILD,
      props: { id: 'a' },
      route: NOTE,
    });
    await engine.operate(sessionId, {
      args: [{ json: 'a' }],
      build: BUILD,
      module: 'actions/notes',
      name: 'hide',
      operationId: 'op-1',
    });
    faulty.failing = 'UPDATE meta SET value = CAST(value AS INTEGER) + 1';

    const answer = await gated(engine);

    expect(shown.kind).toBe('shared');
    expect(answer).toMatchObject({ kind: 'respond', status: 503 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('database or disk is full'));
  });
});
