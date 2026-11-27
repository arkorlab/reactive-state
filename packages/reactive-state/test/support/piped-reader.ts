/**
 * A reader of an event stream as a Function's response is one: it takes each chunk as it comes,
 * through a pipe, until its browser leaves without anything seeing it go (`leave`). From then on
 * the next chunk's write fails — `lateMs` after the chunk comes, the time a Function takes to find
 * its browser gone — and the pipe cancels the stream only then, as a Function's failed write to a
 * browser that left does, its `request.signal` never aborting.
 */
export interface PipedReader {
  /** Each chunk the reader took, as text. */
  readonly taken: readonly string[];
  /** Settles once the reader took its first chunk: the comment the stream opens with. */
  readonly opened: Promise<void>;
  /** Settles once the pipe is over: the stream closed, or cancelled by the pipe. */
  readonly piped: Promise<void>;
  /** Whether the pipe ended by a write that failed, once it is over. */
  readonly failed: () => boolean;
  /** The browser leaves, unseen: the next chunk's write fails. */
  readonly leave: () => void;
  /** Aborts the pipe, which cancels the stream on the reader's side. */
  readonly stop: () => Promise<void>;
}

/** The pipe of `body` into a reader that takes each chunk until it leaves (`PipedReader`). */
export function pipedReader(body: ReadableStream<Uint8Array>, lateMs = 0): PipedReader {
  const taken: string[] = [];
  const decoder = new TextDecoder();
  const opened = Promise.withResolvers<undefined>();
  const stopping = new AbortController();
  const state = { failed: false, gone: false };
  const sink = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      if (state.gone) {
        if (lateMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, lateMs);
          });
        }
        state.failed = true;
        throw new Error('The reader left.');
      }
      taken.push(decoder.decode(chunk));
      opened.resolve(undefined);
    },
  });
  const piped = (async (): Promise<void> => {
    try {
      await body.pipeTo(sink, { signal: stopping.signal });
    } catch {
      // The pipe ends with the write that failed, or with its stop: `failed` tells which.
    }
  })();
  return {
    failed: () => state.failed,
    leave: () => {
      state.gone = true;
    },
    opened: opened.promise,
    piped,
    stop: async () => {
      stopping.abort();
      await piped;
    },
    taken,
  };
}
