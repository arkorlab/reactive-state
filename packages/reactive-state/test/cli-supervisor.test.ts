import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ENDS_WITHIN_MS, Supervisor } from '../src/cli/supervisor.ts';

/** What `reactive dev` does of the authority's process, of a process that only says it ended. */

/** A child process, as the supervisor reads one. */
class Child {
  readonly #listeners: (() => void)[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn();

  once(_event: string, listener: () => void): void {
    this.#listeners.push(listener);
  }

  /** Ends, as Node says a process ended. */
  exit(exitCode: number | null, signalCode: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    for (const listener of this.#listeners) listener();
  }
}

/** A supervisor of children the test holds, in the order they were spawned. */
function supervised() {
  const children: Child[] = [];
  const supervisor = new Supervisor(() => {
    const child = new Child();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { children, supervisor };
}

describe('the authority of `reactive dev`', () => {
  it('starts one, and another only once the one before it ended', async () => {
    const { children, supervisor } = supervised();

    await supervisor.start();
    const restarting = supervisor.start();

    expect(children).toHaveLength(1);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');

    children[0]?.exit(0);
    await restarting;

    expect(children).toHaveLength(2);
  });

  it('starts another at once of one that ended by itself', async () => {
    const { children, supervisor } = supervised();
    await supervisor.start();
    children[0]?.exit(1);

    await supervisor.start();

    expect(children).toHaveLength(2);
  });

  it('starts another at once of one a signal ended, which has no exit code', async () => {
    const { children, supervisor } = supervised();
    await supervisor.start();
    children[0]?.exit(null, 'SIGKILL');

    await supervisor.start();

    expect(children).toHaveLength(2);
  });

  it('starts none once it was stopped, though a restart was waiting', async () => {
    const { children, supervisor } = supervised();
    await supervisor.start();
    const restarting = supervisor.start();

    const stopping = supervisor.stop();
    children[0]?.exit(0);
    await Promise.all([restarting, stopping]);

    expect(children).toHaveLength(1);
    expect(supervisor.stopped()).toBe(true);
  });

  it('stops the one running, and answers once it ended', async () => {
    const { children, supervisor } = supervised();
    await supervisor.start();
    const told = vi.fn();

    const stopping = (async () => {
      await supervisor.stop();
      told();
    })();
    await Promise.resolve();

    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(told).not.toHaveBeenCalled();

    children[0]?.exit(0);
    await stopping;

    expect(told).toHaveBeenCalledTimes(1);
  });

  it('says whether one runs, whatever ended it', async () => {
    const { children, supervisor } = supervised();

    expect(supervisor.running).toBe(false);

    await supervisor.start();

    expect(supervisor.running).toBe(true);

    children[0]?.exit(null, 'SIGKILL');

    expect(supervisor.running).toBe(false);
  });

  it('kills one that does not end, which would hold every restart behind it', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { children, supervisor } = supervised();
    await supervisor.start();
    const restarting = supervisor.start();

    await vi.advanceTimersByTimeAsync(ENDS_WITHIN_MS);

    expect(children[0]?.kill).toHaveBeenCalledWith('SIGKILL');

    children[0]?.exit(null, 'SIGKILL');
    await restarting;

    expect(children).toHaveLength(2);
  });

  it('kills none that ended in the time it was given', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { children, supervisor } = supervised();
    await supervisor.start();
    const restarting = supervisor.start();
    children[0]?.exit(0);
    await restarting;

    await vi.advanceTimersByTimeAsync(ENDS_WITHIN_MS);

    expect(children[0]?.kill).not.toHaveBeenCalledWith('SIGKILL');
  });
});
