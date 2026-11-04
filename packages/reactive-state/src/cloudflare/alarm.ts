import { nextTurn } from '../authority/turns.ts';

/**
 * The Durable Object's single alarm, shared by delivery and external stores. Every arming reads
 * after the one before it finished, so a later deadline cannot replace an earlier one's alarm.
 */
interface AlarmStorage {
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (at: number) => Promise<void>;
}

/** An external poll's alarm write after the answer has passed the storage output gate. */
export async function scheduleExternalAlarm(
  storage: { readonly sync: () => Promise<void> },
  alarm: ObjectAlarm,
  at: number,
): Promise<void> {
  await storage.sync();
  await nextTurn();
  await alarm.arm(at);
}

export class ObjectAlarm {
  readonly #storage: AlarmStorage;
  #arming: Promise<void> = Promise.resolve();

  constructor(storage: AlarmStorage) {
    this.#storage = storage;
  }

  /** The alarm at `at`, unless one is already armed earlier. */
  async arm(at: number): Promise<void> {
    const previous = this.#arming;
    const arming = (async () => {
      await previous;
      const armed = await this.#storage.getAlarm();
      if (armed === null || armed > at) await this.#storage.setAlarm(at);
    })();
    // A failed write does not prevent later attempts; the caller still receives its failure.
    this.#arming = (async () => {
      try {
        await arming;
      } catch {
        /* The next arming retries storage. */
      }
    })();
    await arming;
  }
}
