import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import type { OperationArgument, OperationReceipt } from '../src/program.ts';
import { changeSession } from '../src/server/index.ts';
import { late } from './support/app/actions/session.ts';
import { application, BUILD } from './support/program.ts';

/**
 * `changeSession(change)`: a server operation asks for a change of the application's own session,
 * which the authority keeps with the operation's answer — for a resend, and after a restart — and
 * only if the operation succeeds.
 */

const MODULE = 'actions/session';

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** An authority of the test application, at `filename` where given, and a session of Alice's. */
async function opened(filename?: string, closedByTest = false) {
  const engine = new Engine({ ...application, ...(filename !== undefined && { filename }) });
  if (!closedByTest) {
    onTestFinished(async () => {
      await engine.close();
    });
  }
  const { sessionId } = await engine.login('alice');
  const operate = async (
    name: string,
    args: readonly OperationArgument[] = [],
    operationId: string = crypto.randomUUID(),
  ): Promise<OperationReceipt> =>
    engine.operate(sessionId, { args, build: BUILD, module: MODULE, name, operationId });
  return { engine, operate, sessionId };
}

/** A function, which JSON does not carry. */
function aFunction(): unknown {
  return aFunction;
}

/** Waits for what the code left running. */
async function settleTimers(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
}

/** An object that holds itself. */
function cycle(): unknown {
  const self: Record<string, unknown> = {};
  self['self'] = self;
  return self;
}

/** A call of `changeSession` where no operation runs. */
function askOutside(): void {
  changeSession({ a: 1 });
}

describe('the server function', () => {
  it('is refused outside a server operation, where no evaluation is under way', () => {
    expect(askOutside).toThrow(TypeError);
    expect(askOutside).toThrow('server operation alone');
  });

  it('is refused a second time in one run, the first change standing for no answer', async () => {
    const { operate } = await opened();

    const error = await rejection(operate('switchTwice', [], 'op-twice'));

    expect(error).toMatchObject({ status: 422 });
    expect((error as Error).message).toContain('changes the session once');
  });

  it('takes a change of 4 KiB and refuses one past it, counted in UTF-8 bytes', async () => {
    const { operate } = await opened();
    // `{"note":"…"}` is 11 bytes around the text.
    const fits = (await operate('switchOfSize', [{ json: 4096 - 11 }])).sessionChange;
    const over = await rejection(operate('switchOfSize', [{ json: 4096 - 10 }]));

    expect(JSON.stringify(fits)).toHaveLength(4096);
    expect(over).toMatchObject({ status: 422 });
    expect((over as Error).message).toContain('4096 at most');
  });

  it.each([
    ['a function', aFunction],
    ['NaN', () => NaN],
    ['a date', () => new Date(0)],
    ['a cycle', cycle],
  ])('refuses a change that is no JSON: %s', async (_name, make) => {
    const engine = new Engine({
      ...application,
      operations: {
        ...application.operations,
        bad: {
          run: () => {
            changeSession(make());
          },
        },
      },
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const error = await rejection(
      engine.operate(sessionId, {
        args: [],
        build: BUILD,
        module: 'bad',
        name: 'run',
        operationId: crypto.randomUUID(),
      }),
    );

    expect(error).toMatchObject({ status: 422 });
    expect((error as Error).message).toContain('JSON');
  });
});

describe('the engine', () => {
  it('answers the change of an operation that succeeded, beside its result', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchTeam', [{ json: 'team-2' }]);

    expect(receipt).toMatchObject({
      deduplicated: false,
      result: 'team-2',
      sessionChange: { activeTeam: 'team-2' },
    });
  });

  it('answers none for an operation that asked for none', async () => {
    const { operate } = await opened();

    const receipt = await operate('stayPut');

    expect(receipt).toMatchObject({ result: 'stayed' });
    expect(receipt).not.toHaveProperty('sessionChange');
  });

  it.each(['switchThenRefuse', 'switchThenForbid', 'switchThenThrow'])(
    'answers no change for %s, a resend either',
    async (name) => {
      const { operate } = await opened();

      const first = await rejection(operate(name, [], 'op-fails'));
      const again = await rejection(operate(name, [], 'op-fails'));

      expect(first).toBeInstanceOf(Error);
      expect(again).toBeInstanceOf(Error);
      expect(first).not.toHaveProperty('sessionChange');
      expect(again).not.toHaveProperty('sessionChange');
    },
  );

  it('answers the same change to a resend of the same id, without running it again', async () => {
    const { engine, operate } = await opened();

    const first = await operate('switchTeam', [{ json: 'team-3' }], 'op-switch');
    const again = await operate('switchTeam', [{ json: 'team-3' }], 'op-switch');

    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect(again.sessionChange).toStrictEqual({ activeTeam: 'team-3' });
    await expect(engine.stats()).resolves.toMatchObject({ deduplicated: 1, operationRuns: 1 });
  });

  it('keeps the change across a restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-session-change-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    const first = await opened(filename, true);
    const sent = await first.operate('switchTeam', [{ json: 'team-4' }], 'op-restart');
    await first.engine.close();

    const second = new Engine({ ...application, filename });
    onTestFinished(async () => {
      await second.close();
    });
    const again = await second.operate(first.sessionId, {
      args: [{ json: 'team-4' }],
      build: BUILD,
      module: MODULE,
      name: 'switchTeam',
      operationId: 'op-restart',
    });

    expect(again).toStrictEqual({ ...sent, deduplicated: true });
  });
});

describe('the change asked inside a transaction', () => {
  it('is the run’s once the transaction commits', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchInTransaction');

    expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'inside' });
  });

  it('is let go of where the transaction rolls back, though the operation returns', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchInRolledBack');

    expect(receipt).not.toHaveProperty('sessionChange');
  });

  it('frees the slot for a call after the rolled-back one', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchAfterRolledBack');

    expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after' });
  });

  it('counts as asked once committed: a call after it is a second one', async () => {
    const { operate } = await opened();

    const error = await rejection(operate('switchInAndOut'));

    expect((error as Error).message).toContain('changes the session once');
  });
});

describe('a call from code the operation left running', () => {
  it('is refused once the run settled, as a read of the evaluation is', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchLater');
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(receipt).not.toHaveProperty('sessionChange');
    expect(late.error).toBeInstanceOf(TypeError);
    expect((late.error as Error).message).toContain('had settled');
  });

  it('is accepted where it was queued before the run settled', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchQueued');

    expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'queued' });
  });
});

describe('a change of shared references', () => {
  it.each([17, 30])('is refused while it is copied, %i levels deep, quickly', async (levels) => {
    const started = performance.now();
    let shared: unknown[] = [];
    for (let level = 0; level < levels; level += 1) shared = [shared, shared];
    const engine = new Engine({
      ...application,
      operations: {
        ...application.operations,
        graph: {
          run: () => {
            changeSession(shared);
          },
        },
      },
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const error = await rejection(
      engine.operate(sessionId, {
        args: [],
        build: BUILD,
        module: 'graph',
        name: 'run',
        operationId: crypto.randomUUID(),
      }),
    );

    expect(error).toMatchObject({ status: 422 });
    expect((error as Error).message).toContain('more than 4096 values');
    expect(performance.now() - started).toBeLessThan(100);
  });
});

/** The largest number of ticks a sweep goes to. */
const SWEEP = 12;
/** The grid of the voided transaction's awaits and the run's ticks. */
const GRID = 10;

describe('the run’s own state', () => {
  it('answers the change exactly when the voided transaction’s commit landed', async () => {
    const { operate } = await opened();
    const broken: string[] = [];
    const seen = new Set<boolean>();

    for (let awaits = 0; awaits <= GRID; awaits += 1) {
      for (let ticks = 0; ticks <= GRID; ticks += 1) {
        const receipt = await operate('switchVoidedTransaction', [
          { json: awaits },
          { json: ticks },
        ]);
        await late.left;
        const kept = receipt.sessionChange !== undefined;
        seen.add(kept);
        if ((late.error === undefined) !== kept) broken.push(`${String(awaits)}/${String(ticks)}`);
      }
    }

    expect(broken).toStrictEqual([]);
    expect([...seen].toSorted((a, b) => Number(a) - Number(b))).toStrictEqual([false, true]);
  });

  it('refuses a call after the run timed out', async () => {
    const engine = new Engine({ ...application, timeoutMs: 20 });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const error = await rejection(
      engine.operate(sessionId, {
        args: [],
        build: BUILD,
        module: MODULE,
        name: 'switchAfterTimeout',
        operationId: crypto.randomUUID(),
      }),
    );
    await settleTimers();

    expect(error).toBeInstanceOf(Error);
    expect(late.error).toBeInstanceOf(TypeError);
    expect((late.error as Error).message).toContain('settled or timed out');
  });

  it('refuses a call from a transaction the run left running, after its receipt', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchFromLeftTransaction');
    await settleTimers();

    expect(receipt).not.toHaveProperty('sessionChange');
    expect(late.error).toBeInstanceOf(TypeError);
    expect((late.error as Error).message).toContain('settled or timed out');
  });

  it('takes a call of a chain a transaction started, once it committed and while the run goes on', async () => {
    const { operate } = await opened();
    const outcomes: { ticks: number; error: unknown; change: unknown }[] = [];

    for (let ticks = 0; ticks <= SWEEP; ticks += 1) {
      const receipt = await operate('switchFromChain', [{ json: ticks }]);
      outcomes.push({ change: receipt.sessionChange, error: late.error, ticks });
    }

    expect(
      outcomes.filter((each) => each.error !== undefined || each.change === undefined),
    ).toStrictEqual([]);
  });
});

describe('the owner of a change', () => {
  it('is the operation’s own code when it asks outside the transaction’s body, though one runs', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchOutsideBody');

    expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'outside' });
  });
});

describe('a late call from the code of a transaction that rolled back', () => {
  it('is refused: what it asked for went with the transaction', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchFromRolledBackChain');

    expect(late.error).toBeInstanceOf(TypeError);
    expect((late.error as Error).message).toContain('rolled back');
    expect(receipt).not.toHaveProperty('sessionChange');
  });

  it('pin: leaves the operation’s own call after the rollback taken', async () => {
    const { operate } = await opened();

    const receipt = await operate('switchOwnAfterRollback');

    expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'own' });
  });
});
