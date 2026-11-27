import { changeSession, forbidden, refuse } from '../../../../src/server/index.ts';
import { db } from '../db.ts';

/**
 * The test application's `actions/session`: server operations that ask the application's session
 * to change, and ways of not succeeding after they asked.
 */

/** Asks for the team `teamId` to be the session's active one. */
export function switchTeam(teamId: string): string {
  changeSession({ activeTeam: teamId });
  return teamId;
}

/** Asks twice: the second call is a fault of the code. */
export function switchTwice(): void {
  changeSession({ activeTeam: 'a' });
  changeSession({ activeTeam: 'b' });
}

/** Asks, then refuses as the application. */
export function switchThenRefuse(): never {
  changeSession({ activeTeam: 'refused' });
  return refuse('TEAM_FULL');
}

/** Asks, then is forbidden. */
export function switchThenForbid(): never {
  changeSession({ activeTeam: 'forbidden' });
  return forbidden();
}

/** Asks, then throws. */
export function switchThenThrow(): never {
  changeSession({ activeTeam: 'thrown' });
  throw new Error('The team could not be switched.');
}

/** Asks for a change of the size given, in characters of ASCII. */
export function switchOfSize(size: number): void {
  changeSession({ note: 'x'.repeat(size) });
}

/** Asks for nothing. */
export function stayPut(): string {
  return 'stayed';
}

/** Asks inside a transaction that commits. */
export async function switchInTransaction(): Promise<void> {
  await db.transaction(async () => {
    changeSession({ activeTeam: 'inside' });
    await Promise.resolve();
  });
}

/** Asks inside a transaction that throws, and is caught: the transaction's ask is let go of. */
export async function switchInRolledBack(): Promise<void> {
  try {
    await db.transaction(async () => {
      changeSession({ activeTeam: 'rolled-back' });
      await Promise.resolve();
      throw new Error('Rolled back.');
    });
  } catch {
    // The operation goes on, having changed nothing.
  }
}

/** Asks inside a transaction that rolls back, then again outside it: the second is the run's. */
export async function switchAfterRolledBack(): Promise<void> {
  await switchInRolledBack();
  changeSession({ activeTeam: 'after' });
}

/** Asks inside a transaction that commits, then again outside it: a second call. */
export async function switchInAndOut(): Promise<void> {
  await switchInTransaction();
  changeSession({ activeTeam: 'out' });
}

/** What `switchLater`'s timer found when it asked after the run settled. */
export const late: { error?: unknown; left?: Promise<void> } = {};

/** Returns, and asks from a timer once it has settled: refused, the error left in `late`. */
export function switchLater(): void {
  late.error = undefined;
  setTimeout(() => {
    try {
      changeSession({ activeTeam: 'late' });
    } catch (error) {
      late.error = error;
    }
  }, 0);
}

/** Returns, having queued a call before it settled: accepted. */
export function switchQueued(): void {
  queueMicrotask(() => {
    changeSession({ activeTeam: 'queued' });
  });
}

/** Waits `ms` on a timer. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Asks inside a transaction the operation does not await, and returns after `ticks` ticks. */
export async function switchVoidedTransaction(awaits: number, ticks: number): Promise<void> {
  late.error = undefined;
  late.left = (async () => {
    try {
      await db.transaction(async () => {
        changeSession({ activeTeam: 'voided' });
        for (let each = 0; each < awaits; each += 1) await Promise.resolve();
      });
    } catch (error) {
      late.error = error;
    }
  })();
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

/** Asks after the run's time ran out: refused, the error left in `late`. */
export async function switchAfterTimeout(): Promise<void> {
  late.error = undefined;
  await wait(60);
  try {
    changeSession({ activeTeam: 'too-late' });
  } catch (error) {
    late.error = error;
  }
}

/** Returns with a transaction left running, which asks after the receipt: refused. */
export function switchFromLeftTransaction(): void {
  late.error = undefined;
  late.left = (async () => {
    try {
      await db.transaction(async () => {
        await wait(30);
        try {
          changeSession({ activeTeam: 'left' });
        } catch (error) {
          late.error = error;
        }
      });
    } catch {
      // The run settled before the transaction did: nothing answers it.
    }
  })();
}

/** Asks from a chain of `ticks` ticks started in a transaction, which the run awaits. */
export async function switchFromChain(ticks: number): Promise<void> {
  late.error = undefined;
  await db.transaction(async () => {
    late.left = (async () => {
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      try {
        changeSession({ activeTeam: 'chain' });
      } catch (error) {
        late.error = error;
      }
    })();
    await Promise.resolve();
  });
  await wait(20);
}

/** Asks outside its transaction's body while the transaction runs, which then rolls back. */
export async function switchOutsideBody(): Promise<void> {
  const running = (async () => {
    try {
      await db.transaction(async () => {
        await Promise.resolve();
        throw new Error('Rolled back.');
      });
    } catch {
      // The operation goes on.
    }
  })();
  changeSession({ activeTeam: 'outside' });
  await running;
}

/** Starts a chain in a transaction that then throws; the chain asks once the transaction is over. */
export async function switchFromRolledBackChain(): Promise<void> {
  late.error = undefined;
  try {
    await db.transaction(async () => {
      late.left = (async () => {
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        try {
          changeSession({ activeTeam: 'chain' });
        } catch (error) {
          late.error = error;
        }
      })();
      await Promise.resolve();
      throw new Error('Rolled back.');
    });
  } catch {
    // The operation goes on.
  }
  await wait(20);
}

/** Asks from its own code once its transaction rolled back. */
export async function switchOwnAfterRollback(): Promise<void> {
  try {
    await db.transaction(async () => {
      await Promise.resolve();
      throw new Error('Rolled back.');
    });
  } catch {
    // The operation goes on.
  }
  changeSession({ activeTeam: 'own' });
}
