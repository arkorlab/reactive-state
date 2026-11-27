import { changeSession, forbidden, refuse } from '../../../../src/server/index.ts';

/**
 * The test application's `actions/session`: server operations that ask the application's session
 * to change, and ways of not succeeding after they asked. Those of the old application's that ask
 * inside `db.transaction`, or outside one while it runs, are not here: D1 holds no transaction an
 * operation's code runs in, and `db.transaction` goes with the tables the authority keeps.
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

/** What `switchLater`'s timer found when it asked after the run settled. */
export const late: { error?: unknown } = {};

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

/** Asks after the run's time ran out: refused, the error left in `late`. */
export async function switchAfterTimeout(): Promise<void> {
  late.error = undefined;
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  try {
    changeSession({ activeTeam: 'too-late' });
  } catch (error) {
    late.error = error;
  }
}
