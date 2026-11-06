/** One server-sent event: its name, and its data parsed as JSON. */
export interface ServerEvent {
  readonly event: string;
  readonly data: unknown;
}

/** Reads server-sent events off a response's body, one at a time. */
export interface EventReader {
  /** The next event; a comment such as the heartbeat is read past. Rejects when the stream ends. */
  readonly next: () => Promise<ServerEvent>;
  /** Reads events until one `matches`, and answers it. */
  readonly until: (matches: (event: ServerEvent) => boolean) => Promise<ServerEvent>;
  /** Stops reading, which closes the stream from the client's side. */
  readonly cancel: () => Promise<void>;
}

const BLOCK_END = '\n\n';

export function readEvents(response: Response): EventReader {
  const { body } = response;
  if (body === null) {
    throw new Error('The response has no body to read events from.');
  }
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  const next = async (): Promise<ServerEvent> => {
    for (;;) {
      const end = buffered.indexOf(BLOCK_END);
      if (end !== -1) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + BLOCK_END.length);
        const event = eventOf(block);
        if (event !== undefined) {
          return event;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error('The event stream ended.');
      }
      buffered += chunk.value;
    }
  };
  return {
    cancel: async () => reader.cancel(),
    next,
    until: async (matches) => {
      for (;;) {
        const event = await next();
        if (matches(event)) {
          return event;
        }
      }
    },
  };
}

/** One block of the stream as an event; `undefined` for a block that carries no data. */
function eventOf(block: string): ServerEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length);
    } else if (line.startsWith('data: ')) {
      data.push(line.slice('data: '.length));
    }
  }
  return data.length === 0 ? undefined : { data: JSON.parse(data.join('\n')) as unknown, event };
}
