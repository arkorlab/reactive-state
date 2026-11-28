import { describeThrown } from './errors.ts';
import { type ExternalTailOptions, ExternalTail } from './external-tail.ts';
import type { Memo } from './memo.ts';
import type { ExternalHost } from './model.ts';
import type { SharedViews } from './shared-views.ts';

/** The external tail and the renderings whose retained reads keep it running. */
interface ExternalEngineOptions extends ExternalTailOptions {
  readonly memo: Memo;
  readonly shared: SharedViews;
  readonly host: ExternalHost | undefined;
}

/** How long an operation's answer waits for the stores' logs, which its writes may be in. */
const AFTER_OPERATION = { readMs: 1000 } as const;

/**
 * Reads the stores' logs once an operation has run, whether it succeeded or not — the
 * application's own SQL may have written a followed table either way — for the page its answer
 * renders again to show those writes: within `AFTER_OPERATION.readMs`, after which the answer goes
 * and the read goes on. A read that fails is logged, and the next interval reads again.
 */
export async function readAfterOperation(tail: ExternalTail): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    try {
      await tail.read();
    } catch (error) {
      tail.fault(
        error,
        `An external store's change log could not be read after an operation: ${describeThrown(error)}`,
        true,
      );
    }
  })();
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, AFTER_OPERATION.readMs);
  });
  try {
    await Promise.race([read, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What ends an operation's call: the stores' logs read where it may have written them, and then
 * `flush`, which tells the application of its faults — after the wait, whatever came of it.
 */
export async function afterOperation(
  tail: ExternalTail,
  read: boolean,
  flush?: () => void,
): Promise<void> {
  try {
    if (read) await readAfterOperation(tail);
  } finally {
    flush?.();
  }
}

/**
 * Following for an engine: memoized renders expire, and shared routes retain their own lifetime.
 * Once nothing refers to them, nothing of theirs keeps a store's log followed.
 */
export function externalTailOf(options: ExternalEngineOptions): ExternalTail {
  const tables = new Set(options.stores.keys());
  return new ExternalTail({
    ...options,
    keep: options.host?.keep,
    retained: () => options.memo.retains(tables) || options.shared.retains(tables),
    schedule: options.host?.schedule,
  });
}
