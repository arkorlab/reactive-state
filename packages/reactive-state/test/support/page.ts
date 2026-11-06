import type {
  FieldReceipt,
  Frame,
  Rendered,
  RenderedClient,
  Result,
  Value,
} from '../../src/program.ts';

/**
 * What the browser's suites share: frames as the authority renders them, the event source jsdom
 * does not have, and promises a test settles when it chooses.
 */

/** The build the suites' frames are of, and their components were compiled in. */
export const BUILD = 'b_project_todo_test';

export interface FrameOptions {
  /** The root, its props and the session, as one key: the first root's unless another is given. */
  readonly rootKey?: string;
  /** The operations of the session the frame reflects. */
  readonly operations?: readonly string[];
  readonly subscription?: string;
  /** The view it was rendered for: no site shown unless said. */
  readonly view?: Frame['view'];
}

/** A frame of a root at `revision`, holding `fields`. */
export function frameAt(
  revision: number,
  fields: Readonly<Record<string, Value>>,
  options: FrameOptions = {},
): Frame {
  const { operations = [], rootKey = 'root:p1' } = options;
  return {
    buildId: BUILD,
    digest: `digest:${rootKey}:${String(revision)}`,
    fields,
    operations,
    revision,
    rootKey,
    subscription: options.subscription ?? `subscription:${rootKey}:${String(revision)}`,
    view: options.view ?? {},
  };
}

/** A promise and the functions that settle it, for a test to settle when it chooses. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  return { promise, reject, resolve };
}

/** What a write's answer is when the authority committed `operationId` at `revision`. */
export function receipt(operationId: string, revision: number): Result<FieldReceipt> {
  return {
    ok: true,
    value: { committedRevision: revision, deduplicated: false, operationId },
  };
}

/** What an answer is when the authority refused what it was asked: a write, a view. */
export function refusal(
  status: number,
  code: string,
  message: string,
): Extract<Result<never>, { readonly ok: false }> {
  return { code, message, ok: false, status };
}

/** The event sources opened since the last `forgetSources`, oldest first. */
export const opened: FakeEventSource[] = [];

export function forgetSources(): void {
  opened.length = 0;
}

/** The browser's `EventSource`, which jsdom does not have: the test sends each event itself. */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  closed = false;
  readyState: number = FakeEventSource.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    opened.push(this);
  }

  /** The subscription the stream was opened with. */
  get subscription(): string | null {
    return new URL(this.url).searchParams.get('subscription');
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** The stream failing: the browser would reconnect, or give up. */
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }

  /** One server-sent event, as the authority's stream writes it. */
  emit(event: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

/** A row of the project's list as the authority renders its client part: a title and a state. */
export function rowOf(id: string): RenderedClient {
  return {
    component: 'components/todo-row',
    key: id,
    kind: 'client',
    part: {
      props: { filter: 'all', id, projectId: 'p1' },
      slots: {},
      states: {
        completed: { field: `todos:${id}:completed` },
        title: { field: `todos:${id}:title` },
      },
    },
  };
}

/** The details' editor of one item, whose title and estimate are written through its bindings. */
function editorOf(id: string): RenderedClient {
  return {
    component: 'components/todo-editor',
    key: id,
    kind: 'client',
    part: {
      props: { id, projectId: 'p1' },
      slots: {
        s0: {
          children: [
            {
              children: [`commands of ${id}`],
              key: null,
              kind: 'element',
              props: { 'data-testid': 'commands' },
              type: 'p',
            },
          ],
          key: null,
          kind: 'fragment',
        },
      },
      states: {
        title: { binding: `binding:title:${id}`, field: `todos:${id}:title`, set: 'u_set_title' },
        'useEstimate#0.estimate': {
          binding: `binding:estimate:${id}`,
          field: `todos:${id}:estimate`,
        },
      },
    },
  };
}

/** The project's page as the authority renders it: its rows in `order`, and `selected`'s editor. */
export function projectTree(order: readonly string[], selected: string | null): Rendered {
  return {
    children: [
      {
        children: [order.map((id) => rowOf(id))],
        key: null,
        kind: 'element',
        props: {},
        type: 'ul',
      },
      selected === null ? null : editorOf(selected),
    ],
    key: null,
    kind: 'element',
    props: {},
    type: 'main',
  };
}
