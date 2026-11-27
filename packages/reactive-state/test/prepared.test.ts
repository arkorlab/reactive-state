import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { AuthorityErrorEvent } from '../src/authority/error-hook.ts';
import { Engine } from '../src/authority/node-engine.ts';
import {
  type ComponentProgram,
  type Json,
  type OperationArgument,
  type OperationReceipt,
  PROTOCOL_VERSION,
} from '../src/program.ts';
import { prepared } from '../src/server/index.ts';
import { application, BUILD } from './support/program.ts';

/**
 * `prepared()`: what the application's own server prepared for a server operation is read by the
 * operation, in its transaction too, and by nothing else; the authority keeps none of it.
 */

const MODULE = 'actions/prepared';
/** Text no other part of a test holds: what a search of the stored bytes looks for. */
const MARKER = 'marker-of-the-preparation-7f3a';

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** A render that reads the preparation, as a component's code might, and what it caught. */
const probe = { caught: undefined as unknown };
const probeProgram: ComponentProgram = {
  buildId: BUILD,
  component: 'components/prepared-probe',
  evaluate: async (_props, $) => {
    await Promise.resolve();
    try {
      prepared();
    } catch (error) {
      probe.caught = error;
    }
    return $.h('p', null, 'probe');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** An authority of the test application, at `filename` where given, and a session of Alice's. */
async function opened(
  filename?: string,
  options: Partial<ConstructorParameters<typeof Engine>[0]> = {},
) {
  const engine = new Engine({
    ...application,
    programs: [...application.programs, probeProgram],
    ...(filename !== undefined && { filename }),
    ...options,
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const { sessionId } = await engine.login('alice');
  const operate = async (
    name: string,
    send: {
      readonly prepared?: Json;
      readonly operationId?: string;
      readonly args?: readonly OperationArgument[];
    } = {},
  ): Promise<OperationReceipt> => {
    return engine.operate(sessionId, {
      args: send.args ?? [],
      build: BUILD,
      module: MODULE,
      name,
      operationId: send.operationId ?? crypto.randomUUID(),
      ...(send.prepared !== undefined && { prepared: send.prepared }),
    });
  };
  return { engine, operate, sessionId };
}

/** A call of `prepared()` where no operation runs. */
function readOutside(): void {
  prepared();
}

describe('prepared()', () => {
  it('is a TypeError outside any evaluation', () => {
    expect(readOutside).toThrow(TypeError);
    expect(readOutside).toThrow('server operation alone');
  });

  it('is a TypeError in a render', async () => {
    const { engine, sessionId } = await opened();
    probe.caught = undefined;

    await engine.render(sessionId, {
      build: BUILD,
      component: 'components/prepared-probe',
      props: {},
    });

    expect(probe.caught).toBeInstanceOf(TypeError);
    expect((probe.caught as Error).message).toContain('server operation alone');
  });
});

describe('an operation that reads its preparation', () => {
  it('reads the value that was sent', async () => {
    const { operate } = await opened();

    const receipt = await operate('echo', { prepared: { account: 'octocat', ids: [1, 2] } });

    expect(receipt.result).toStrictEqual({ account: 'octocat', ids: [1, 2] });
  });

  it('reads null as sent', async () => {
    const { operate } = await opened();

    expect((await operate('wasPrepared', { prepared: null })).result).toBe(true);
  });

  it('reads undefined where none was sent', async () => {
    const { operate } = await opened();

    expect((await operate('wasPrepared')).result).toBe(false);
  });

  it('reads it inside its transaction too', async () => {
    const { operate } = await opened();

    const receipt = await operate('readInTransaction', { prepared: { inside: true } });

    expect(receipt.result).toStrictEqual({ inside: true });
  });

  it('answers the first receipt to a resend of the id with another preparation, and runs once', async () => {
    const { engine, operate } = await opened();

    const first = await operate('echo', { operationId: 'op-same', prepared: { n: 1 } });
    const again = await operate('echo', { operationId: 'op-same', prepared: { n: 2 } });

    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect(again.result).toStrictEqual({ n: 1 });
    await expect(engine.stats()).resolves.toMatchObject({ deduplicated: 1, operationRuns: 1 });
  });
});

describe('what the authority keeps', () => {
  it('holds no marker of the preparation, in the operations rows or in the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-prepared-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    const { engine, operate } = await opened(filename);

    await operate('wasPrepared', { operationId: 'op-kept', prepared: { secret: MARKER } });
    await operate('readInTransaction', { operationId: 'op-tx', prepared: null });
    const failed = await rejection(
      operate('readThenThrow', { operationId: 'op-failed', prepared: { secret: MARKER } }),
    );
    await engine.close();

    expect(failed).toBeInstanceOf(Error);

    using database = new DatabaseSync(filename, { readOnly: true });
    const rows = database.prepare('SELECT * FROM operations').all();

    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(MARKER);

    const names = await readdir(dir);

    expect(names).toContain('authority.sqlite');

    for (const name of names) {
      const bytes = await readFile(path.join(dir, name));

      expect(bytes.toString('latin1')).not.toContain(MARKER);
      expect(bytes.toString('latin1')).not.toContain('"secret"');
    }
  });

  it('tells onError of module, name and operation id alone', async () => {
    const told: AuthorityErrorEvent[] = [];
    const { operate } = await opened(undefined, {
      onError: (_error, event) => {
        told.push(event);
      },
    });

    await rejection(
      operate('readThenThrow', { operationId: 'op-told', prepared: { secret: MARKER } }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(told).toStrictEqual([
      { kind: 'operation', module: MODULE, name: 'readThenThrow', operationId: 'op-told' },
    ]);
    expect(JSON.stringify(told)).not.toContain(MARKER);
  });
});
