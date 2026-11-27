import type { ChildProcess } from 'node:child_process';

/**
 * How long the authority's process takes to stop at most, of itself: a close's own limit (`CLOSE_MS`),
 * and more.
 */
export const STOP_MS = 7000;

/**
 * How long a process is given to end, past which it is killed: one that hangs would hold every
 * restart behind it. Longer than `STOP_MS`, so that this is of a process past hearing a signal.
 */
export const ENDS_WITHIN_MS = 10_000;

/** The authority's process of `reactive dev`: one at a time, and none once `reactive dev` stops. */
export class Supervisor {
  readonly #spawn: () => ChildProcess;
  #child: ChildProcess | undefined;
  #stopped = false;

  constructor(spawn: () => ChildProcess) {
    this.#spawn = spawn;
  }

  /** Has the process end, where one runs. */
  async #end(): Promise<void> {
    const child = this.#child;
    if (child === undefined || !this.running) return;
    const exited = new Promise((resolve) => {
      child.once('exit', resolve);
    });
    const killing = setTimeout(() => {
      child.kill('SIGKILL');
    }, ENDS_WITHIN_MS);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(killing);
  }

  /** Whether `stop` was called: no restart may start anything after it. */
  stopped(): boolean {
    return this.#stopped;
  }

  /** Whether the process runs. One a signal ended has no exit code, and says nothing more. */
  get running(): boolean {
    return this.#child?.exitCode === null && this.#child.signalCode === null;
  }

  /** Starts the process, once the one before it ended; none, of a supervisor stopped meanwhile. */
  async start(): Promise<void> {
    await this.#end();
    if (!this.#stopped) this.#child = this.#spawn();
  }

  /** Stops the process running, and any that was to start, and answers once it ended. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#end();
  }
}
