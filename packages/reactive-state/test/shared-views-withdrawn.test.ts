import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import {
  type GateAnswer,
  GENERATION_HEADER,
  type MiddlewareProgram,
  type RouteRegistration,
} from '../src/routing.ts';
import { currentUser, database, forbidden, table, text } from '../src/server/index.ts';
import { nextPageParam } from './support/next-page.ts';

/**
 * A published view withdrawn — refused, answered by its guard in its place, found to be the
 * request's, or revoked after a commit and an evaluation that faulted — keeps none of its
 * artifacts: the store lets go of them in the transaction that keeps the view so, rather than
 * holding the withdrawn page until the view publishes again or is let go of. Against an
 * application of its own, whose note's mode says how its view is decided, over a file.
 */

const BUILD = 'b_withdrawn';
const ROUTE = '/notes/[id]';

const db = database(
  { notes: table({ body: text({ maxLength: 200 }), mode: text({ maxLength: 16 }) }) },
  { seed: { notes: { n1: { body: 'hello', mode: 'shown' } } } },
);

/** The note, for every visitor: refused while hidden, the request's while secret, faulting while broken. */
const note: ComponentProgram = {
  buildId: BUILD,
  component: 'components/note',
  evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
    const found = await db.notes.get(String(props['id']));
    if (found?.mode === 'hidden') {
      forbidden();
    }
    if (found?.mode === 'secret') {
      await currentUser();
    }
    if (found?.mode === 'broken') {
      throw new Error('The note is broken.');
    }
    return $.h('p', null, found?.body ?? 'none');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** A moved note's guard answers a redirect in the view's place. */
const moved: MiddlewareProgram = {
  buildId: BUILD,
  guard: async ({ params }) => {
    const found = await db.notes.get(params['id'] ?? '');
    return found?.mode === 'moved'
      ? { body: '', headers: [['location', '/notes']], status: 307 }
      : undefined;
  },
  id: 'moved',
  protocolVersion: PROTOCOL_VERSION,
};

const route: RouteRegistration = {
  blocking: true,
  guarded: true,
  middleware: ['moved'],
  page: 'notes/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: note.component,
  route: ROUTE,
  shared: true,
};

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-withdrawn-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

/** The artifacts the store at `filename` keeps, of every view. */
function artifactsIn(filename: string): number {
  using sqlite = new DatabaseSync(filename, { readOnly: true });
  return Number(sqlite.prepare('SELECT COUNT(*) AS kept FROM artifacts').get()?.['kept']);
}

/**
 * The application over `filename`, its site rendering the note's page as its root entry does; what
 * asks its gate for the note `n1`, and what sets the note's mode, as Alice.
 */
async function notes(filename: string): Promise<{
  readonly ask: () => Promise<GateAnswer>;
  readonly setMode: (mode: string) => Promise<void>;
}> {
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    filename,
    middleware: { moved },
    operations: {
      'actions/notes': {
        async setMode(id: unknown, mode: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.notes.update(String(id), { mode: String(mode) });
          });
        },
      },
    },
    programs: [note],
    routes: [route],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  engine.site(async (page, headers) => {
    const answer = await engine.renderShared(null, {
      build: BUILD,
      ...(headers[GENERATION_HEADER] !== undefined && { generation: headers[GENERATION_HEADER] }),
      props: { id: nextPageParam(page.split('/').at(-1) ?? '') },
      route: ROUTE,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  const { sessionId } = await engine.login('alice');
  let made = 0;
  return {
    ask: async () => engine.gate({ headers: {}, method: 'GET', route: ROUTE, url: '/notes/n1' }),
    setMode: async (mode) => {
      made += 1;
      await engine.operate(sessionId, {
        args: [{ json: 'n1' }, { json: mode }],
        build: BUILD,
        module: 'actions/notes',
        name: 'setMode',
        operationId: `mode-${String(made)}`,
      });
    },
  };
}

describe('a published view withdrawn', () => {
  it.each([
    ['refused', 'hidden', 403],
    ['answered by its guard in its place', 'moved', 307],
    ['found to be the request’s', 'secret', undefined],
    ['revoked after a commit and an evaluation that faulted', 'broken', 503],
  ])(
    'keeps none of its artifacts once %s',
    async (_withdrawal, mode, status: number | undefined) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {
        // What the authority logs of the evaluation that faulted, kept out of the output.
      });
      onTestFinished(() => {
        logged.mockRestore();
      });
      const filename = await databaseFile();
      const { ask, setMode } = await notes(filename);

      await expect(ask()).resolves.toMatchObject({ kind: 'respond', status: 200 });

      // The document and the payload of its generation, kept.
      expect(artifactsIn(filename)).toBe(2);

      await setMode(mode);
      const answer = await ask();

      expect(answer).toMatchObject(
        status === undefined ? { kind: 'pass' } : { kind: 'respond', status },
      );
      expect(artifactsIn(filename)).toBe(0);
    },
  );

  it('keeps the artifacts of the generation it shows once a commit changed nothing it shows', async () => {
    const filename = await databaseFile();
    const { ask, setMode } = await notes(filename);
    await ask();

    await setMode('shown');

    await expect(ask()).resolves.toMatchObject({ kind: 'respond', status: 200 });
    expect(artifactsIn(filename)).toBe(2);
  });
});
