// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Activity,
  Component,
  type ReactNode,
  startTransition,
  StrictMode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, onTestFinished, vi } from 'vitest';

import { TextInput } from '../../../fixtures/next-project-todo/src/ui.tsx';
import { type Elements, renderTree } from '../src/next/render.ts';
import type {
  FieldOperation,
  FieldReceipt,
  Frame,
  Json,
  Rendered,
  RenderedClient,
  RenderedSite,
  Result,
  View,
} from '../src/program.ts';
import {
  type ClientPartProps,
  LiveRoot,
  localOf,
  type LocalStateInput,
  type ReactiveSetter,
  slotOf,
  stateOf,
  useReactiveState,
  useReactiveStatus,
  useSites,
} from '../src/react/index.tsx';
import * as reactive from '../src/react/index.tsx';
import { page as pageRuntime, resetPage } from '../src/runtime/page.ts';
import type { Send, StoreStatus } from '../src/runtime/store.ts';
import type { ViewAnswer } from '../src/runtime/view.ts';
import {
  BUILD,
  type Deferred,
  deferred,
  FakeEventSource,
  forgetSources,
  frameAt,
  opened,
  projectTree,
  receipt,
  refusal,
} from './support/page.ts';

/**
 * The browser's half as a page runs it: a root the authority rendered, as `renderRoot` hands it to
 * `LiveRoot`, with Client Components written as the compiler writes them — a row of the project's
 * list, which reads an item's title, and the editor of its details, which writes it, and adds to its
 * estimate through a registered update of the step it captured; and a workspace whose local states
 * pick what the authority renders at its dynamic sites, which the root asks for through its `view`
 * Server Function.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

type Update = (input: unknown) => Promise<Result<FieldReceipt>>;
type ViewFunction = (input: unknown) => Promise<Result<ViewAnswer<ReactNode>>>;

const EVENTS = '/api/reactive-state/events';
const ALICE = 'session:alice';

function TodoRow({ part }: ClientPartProps): ReactNode {
  const { id } = part.props as { readonly id: string };
  const [title] = useReactiveState(stateOf<string>(part, 'title'));
  const [completed] = useReactiveState(stateOf<boolean>(part, 'completed'));
  const [marked, setMarked] = useReactiveState(false);
  return (
    <li data-testid={`row-${id}`}>
      <span data-testid={`row-title-${id}`}>{title === '' ? '無題' : title}</span>
      {completed ? ' 完了' : ' 未完了'}
      <button
        type="button"
        onClick={() => {
          setMarked((value) => !value);
        }}
      >
        {marked ? `marked ${id}` : `mark ${id}`}
      </button>
    </li>
  );
}

function TodoEditor({ part }: ClientPartProps): ReactNode {
  const [title, setTitle] = useReactiveState(stateOf<string>(part, 'title'));
  const [estimate, setEstimate] = useReactiveState(stateOf<number>(part, 'useEstimate#0.estimate'));
  const [step, setStep] = useReactiveState(1);
  const [draft, setDraft] = useReactiveState('');
  return (
    <section data-testid="editor">
      <TextInput aria-label="タイトル" value={title} onChange={setTitle} />
      <button
        type="button"
        onClick={() => {
          setEstimate.compiled('u_add_estimate', { step }, (current) => current + step);
        }}
      >
        {`見積もり ${String(estimate)} に ${String(step)} 加算`}
      </button>
      <button
        type="button"
        onClick={() => {
          setStep(5);
        }}
      >
        step 5
      </button>
      <textarea
        aria-label="メモ"
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
      />
      {slotOf(part, 's0')}
    </section>
  );
}

/** What the page says of its operations, beside the root. */
function Status(): ReactNode {
  const { pending } = useReactiveStatus();
  return <output data-testid="pending">{`${String(pending)} pending`}</output>;
}

const ELEMENTS: Elements = {
  actions: {},
  build: BUILD,
  clients: { 'components/todo-editor': TodoEditor, 'components/todo-row': TodoRow },
  modules: {},
};

const FIELDS = {
  'todos:t1:completed': false,
  'todos:t1:estimate': 2,
  'todos:t1:title': 'Plan',
  'todos:t2:completed': false,
  'todos:t2:estimate': 3,
  'todos:t2:title': 'Sync',
} as const;

const FIRST = frameAt(1, FIELDS);

interface Shown {
  readonly frame: Frame;
  readonly tree?: Rendered;
  readonly session?: string;
}

/** The root as `renderRoot` renders it: the tree inside `LiveRoot`, with the frame it came with. */
function page(shown: Shown, update: Update, view: ViewFunction = unviewed()): ReactNode {
  const { frame, session = ALICE, tree = projectTree(['t1', 't2'], 't1') } = shown;
  return (
    <LiveRoot events={EVENTS} frame={frame} session={session} update={update} view={view}>
      {projectOf(tree)}
    </LiveRoot>
  );
}

/** The tree as the page renders it, the page's status beside it: in a page and an answer alike. */
function projectOf(tree: Rendered): ReactNode {
  return (
    <>
      {renderTree(tree, ELEMENTS)}
      <Status />
    </>
  );
}

/** A transport whose writes are never answered. */
function unanswered(): ReturnType<typeof vi.fn<Update>> {
  return vi.fn<Update>(never);
}

/** An answer that never comes. */
function never<T>(): Promise<T> {
  return new Promise(() => {
    // Never settled: the call stays on its way.
  });
}

/** A `view` Server Function whose answers never come. */
function unviewed(): Mock<ViewFunction> {
  return vi.fn<ViewFunction>(never);
}

/** The answers each `view` function `answering` made waits to give, by request. */
const viewAnswers = new WeakMap<Mock<ViewFunction>, Deferred<Result<ViewAnswer<ReactNode>>>[]>();

/** A `view` Server Function whose answers a test gives (`answerWith`), request by request. */
function answering(): Mock<ViewFunction> {
  const answers: Deferred<Result<ViewAnswer<ReactNode>>>[] = [];
  const view = vi.fn<ViewFunction>(async () => {
    const answer = deferred<Result<ViewAnswer<ReactNode>>>();
    answers.push(answer);
    return answer.promise;
  });
  viewAnswers.set(view, answers);
  return view;
}

/** What `view` answers: the root at `frame`, its tree rendered as `children`. */
function rendered(frame: Frame, children: ReactNode): Result<ViewAnswer<ReactNode>> {
  return { ok: true, value: { children, frame, status: 'rendered' } };
}

/** What `view` answers with the project's page at `frame`, as the page first renders it. */
function projectAnswer(frame: Frame): Result<ViewAnswer<ReactNode>> {
  const tree = projectTree(['t1', 't2'], 't1');
  return rendered(frame, projectOf(tree));
}

/** Answers the `call`th request of `view` with `result`, and lets the page take it in. */
async function answerWith(
  view: Mock<ViewFunction>,
  call: number,
  result: Result<ViewAnswer<ReactNode>>,
): Promise<void> {
  const waiting = viewAnswers.get(view)?.[call];
  if (waiting === undefined) {
    throw new Error(`The view function was asked no request ${String(call)}.`);
  }
  await act(async () => {
    waiting.resolve(result);
    await Promise.resolve();
  });
}

function titleInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'タイトル' });
}

function increase(): void {
  fireEvent.click(screen.getByRole('button', { name: /^見積もり/u }));
}

/** The operations the page sent, in order. */
function sent(update: ReturnType<typeof vi.fn<Update>>): readonly FieldOperation[] {
  return update.mock.calls.map(([input]) => input as FieldOperation);
}

/** Lets the page's microtasks run: answers taken in, refreshes asked for. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The text the browser's editing leaves in the input, past what React tracks of it. */
function leave(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
}

function compose(field: HTMLInputElement, value: string, isComposing: boolean): void {
  leave(field, value);
  fireEvent.input(field, { isComposing });
}

/** The setters a probe was handed, render by render. */
const handed: ReactiveSetter<string>[] = [];

function Probe({ part }: ClientPartProps): ReactNode {
  const [value, setValue] = useReactiveState(stateOf<string>(part, 'title'));
  useLayoutEffect(() => {
    handed.push(setValue);
  });
  return <output data-testid="probe">{value}</output>;
}

function probeOf(id: string, binding: string | undefined): RenderedClient {
  return {
    component: 'probe',
    key: null,
    kind: 'client',
    part: {
      props: {},
      slots: {},
      states: {
        title: {
          field: `todos:${id}:title`,
          ...(binding !== undefined && { binding, set: 'u_set_title' }),
        },
      },
    },
  };
}

function probed(frame: Frame, part: RenderedClient, update: Update): ReactNode {
  return (
    <LiveRoot events={EVENTS} frame={frame} session={ALICE} update={update} view={unviewed()}>
      {renderTree(part, { ...ELEMENTS, clients: { probe: Probe } })}
    </LiveRoot>
  );
}

function Greeting({ part }: ClientPartProps): ReactNode {
  const [greeting, setGreeting] = useReactiveState(stateOf<string>(part, 'greeting'));
  return (
    <button
      type="button"
      onClick={() => {
        setGreeting.compiled('u_exclaim', {}, (current) => `${current}!`);
      }}
    >
      {greeting}
    </button>
  );
}

/**
 * A list the page holds, of a local state the authority started, which a handler grows by a
 * function of its current value, as React's setter takes one: what it adds is made before the call.
 */
function Appender({ part }: ClientPartProps): ReactNode {
  const [items, setItems] = useReactiveState(localOf<readonly string[]>(part, 'items'));
  return (
    <button
      type="button"
      onClick={() => {
        const next = `i${String(items.length)}`;
        setItems((current) => [...current, next]);
      }}
    >
      {items.join(',')}
    </button>
  );
}

/**
 * A count and options of local states the authority started, which a handler sets to `-0`, by a
 * function of the current value, and to options of an entry that holds `undefined`, their keys out
 * of order: what the page holds of each is what it sends the authority of it, which a site is
 * computed of on either side.
 */
function Signed({ part }: ClientPartProps): ReactNode {
  const [count, setCount] = useReactiveState(localOf<number>(part, 'count'));
  const [options, setOptions] = useReactiveState(
    localOf<Readonly<Record<string, string | undefined>>>(part, 'options'),
  );
  return (
    <button
      type="button"
      onClick={() => {
        setCount(() => -0);
        setOptions({ zone: 'z', hint: undefined, area: 'a' });
      }}
    >
      {`${String(1 / count)} ${'hint' in options ? 'hinted' : Object.keys(options).join('') || 'plain'}`}
    </button>
  );
}

/** What `Steady` showed, commit by commit. */
const steadied: string[] = [];

/** The options `Steady` writes each time they change: one object, its keys out of order. */
const ZONED: Readonly<Record<string, string>> = { zone: 'z', area: 'a' };

/**
 * Local states the authority started, which effects write again — the array as it is, of a
 * function of it, once mounted, and the options, each time they change, of the one object `ZONED`:
 * React keeps a state written what it holds, or the object it holds a copy of, and commits the part
 * no more; written a copy of the array, of a click, it holds a new value, as React does.
 */
function Steady({ part }: ClientPartProps): ReactNode {
  const [items, setItems] = useReactiveState(localOf<readonly string[]>(part, 'items'));
  const [options, setOptions] = useReactiveState(
    localOf<Readonly<Record<string, string>>>(part, 'options'),
  );
  useLayoutEffect(() => {
    steadied.push(`${items.join(',')} ${Object.keys(options).join('')}`);
  });
  useEffect(() => {
    setItems((current) => current);
  }, [setItems]);
  useLayoutEffect(() => {
    setOptions(ZONED);
  }, [options, setOptions]);
  return (
    <button
      type="button"
      onClick={() => {
        setItems((current) => [...current]);
      }}
    >
      {items.join(',')}
    </button>
  );
}

/** `Steady`, its states started by the authority. */
function renderSteady(): void {
  const part: RenderedClient = {
    component: 'steady',
    key: null,
    kind: 'client',
    part: {
      props: {},
      slots: {},
      states: { items: { value: ['a', 'b'] }, options: { value: { area: 'a', zone: 'z' } } },
    },
  };
  render(
    <LiveRoot events={EVENTS} frame={FIRST} session={ALICE} update={unanswered()} view={unviewed()}>
      {renderTree(part, { ...ELEMENTS, clients: { steady: Steady } })}
    </LiveRoot>,
  );
}

/**
 * A workspace, as the compiler writes its client part: its filter and the item it shows the
 * details of are local states the authority started, which pick what it renders at the sites `d0`
 * (the list) and `d1` (the details); its note is a state no site reads.
 */
function Workspace({ part }: ClientPartProps): ReactNode {
  const [filter, setFilter] = useReactiveState(stateOf<string>(part, 'filter'));
  const [selectedId, setSelectedId] = useReactiveState(stateOf<string>(part, 'selectedId'));
  const [note, setNote] = useReactiveState('');
  const sites = useSites(part);
  return (
    <section>
      <select
        aria-label="絞り込み"
        value={filter}
        onChange={(event) => {
          setFilter(event.currentTarget.value);
        }}
      >
        <option value="all">すべて</option>
        <option value="active">未完了</option>
        <option value="completed">完了</option>
      </select>
      <button
        type="button"
        onClick={() => {
          startTransition(() => {
            setFilter('active');
          });
        }}
      >
        未完了を待って表示
      </button>
      <button
        type="button"
        onClick={() => {
          setSelectedId(selectedId === '' ? 't1' : '');
        }}
      >
        {selectedId === '' ? '詳細を開く' : '詳細を閉じる'}
      </button>
      <textarea
        aria-label="ノート"
        value={note}
        onChange={(event) => {
          setNote(event.currentTarget.value);
        }}
      />
      <Suspense fallback={<p role="status">読み込み中</p>}>
        {sites.of('d0', { filter })}
        <section aria-label="詳細">
          {selectedId === '' ? (
            <p data-testid="detail-closed">閉じています</p>
          ) : (
            sites.of('d1', { selectedId })
          )}
        </section>
      </Suspense>
    </section>
  );
}

/** What an error boundary of the application shows. */
class Boundary extends Component<
  { readonly children?: ReactNode },
  { readonly error: Error | null }
> {
  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override state = { error: null as Error | null };

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : <p data-testid="boundary">{error.message}</p>;
  }
}

/**
 * Two sites at one place in a part's JSX, of the same inputs, the part's own state choosing which:
 * React renders either in the other's place.
 */
function Swapper({ part }: ClientPartProps): ReactNode {
  const [which, setWhich] = useReactiveState('first');
  const sites = useSites(part);
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setWhich(which === 'first' ? 'second' : 'first');
        }}
      >
        入れ替える
      </button>
      <Suspense fallback={<p role="status">読み込み中</p>}>
        {sites.of(which === 'first' ? 'd0' : 'd1', { id: 't1' })}
      </Suspense>
    </section>
  );
}

/**
 * A part whose site stands under a condition of a state the site is not rendered of — `count > 0`
 * — which the compile sends beside the site's inputs, for the authority to check the condition with.
 */
function Tally({ part }: ClientPartProps): ReactNode {
  const [count, setCount] = useReactiveState(stateOf<number>(part, 'count'));
  const sites = useSites(part);
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setCount(count + 1);
        }}
      >
        増やす
      </button>
      <Suspense fallback={<p role="status">読み込み中</p>}>
        {count > 0 && sites.of('d0', {}, { count })}
      </Suspense>
    </section>
  );
}

/** A panel the page holds open: its own id, and the to-do it shows. */
interface Panel {
  readonly panelId: string;
  readonly todoId: string;
}

/** A panel's card, of a note of its own, which React keeps by the panel's key. */
function Card({
  children,
  panelId,
}: {
  readonly children: ReactNode;
  readonly panelId: string;
}): ReactNode {
  const [note, setNote] = useState('');
  return (
    <article data-panel-id={panelId}>
      <textarea
        aria-label={`${panelId} のメモ`}
        value={note}
        onChange={(event) => {
          setNote(event.currentTarget.value);
        }}
      />
      {children}
    </article>
  );
}

/** What a button of the panels does to the panels open. */
type PanelAction = (panels: readonly Panel[]) => readonly Panel[];

/** Switches the panel A to the to-do `todoId`. */
function switchA(todoId: string): PanelAction {
  return (panels) => panels.map((panel) => (panel.panelId === 'A' ? { ...panel, todoId } : panel));
}

/** The panels open, and two more opened at once beside them: C of t2, and D of t3. */
function openTwo(panels: readonly Panel[]): readonly Panel[] {
  return [...panels, { panelId: 'C', todoId: 't2' }, { panelId: 'D', todoId: 't3' }];
}

/** Each button of the panels, by its name, and what it does to the panels open. */
const PANEL_ACTIONS: readonly (readonly [string, PanelAction])[] = [
  ['A を閉じる', (panels) => panels.filter(({ panelId }) => panelId !== 'A')],
  ['A を t1 へ', switchA('t1')],
  ['A を t2 へ', switchA('t2')],
  ['すべて閉じる', () => []],
  ['並べ替える', (panels) => panels.toReversed()],
  ['二つ開く', openTwo],
];

/**
 * The panels of a workspace, as the compiler writes its client part (v3): a local state of the
 * panels the page holds open, the authority's to start, and the detail of each — a list site, the
 * item of each panel inside its card, keyed by the panel.
 */
function Panels({ part }: ClientPartProps): ReactNode {
  const [panels, setPanels] = useReactiveState(localOf<readonly Panel[]>(part, 'panels'));
  const sites = useSites(part);
  const buttons = PANEL_ACTIONS.map(([name, action]) => {
    return (
      <button
        key={name}
        type="button"
        onClick={() => {
          setPanels((current) => action(current));
        }}
      >
        {name}
      </button>
    );
  });
  const cards = panels.map((panel) => {
    return (
      <Card key={panel.panelId} panelId={panel.panelId}>
        {sites.item('d0', { panels }, { item: panel, key: panel.panelId })}
      </Card>
    );
  });
  return (
    <section>
      {buttons}
      <Suspense fallback={<p role="status">読み込み中</p>}>{cards}</Suspense>
    </section>
  );
}

/** Two lists of one array, an item of each in each panel's card: the panel's detail, and its note. */
function Twins({ part }: ClientPartProps): ReactNode {
  const [panels] = useReactiveState(localOf<readonly Panel[]>(part, 'panels'));
  const sites = useSites(part);
  const cards = panels.map((panel) => {
    return (
      <Card key={panel.panelId} panelId={panel.panelId}>
        {sites.item('d0', { panels }, { item: panel, key: panel.panelId })}
        {sites.item('d1', { panels }, { item: panel, key: panel.panelId })}
      </Card>
    );
  });
  return <Suspense fallback={<p role="status">読み込み中</p>}>{cards}</Suspense>;
}

/** A count of the panels and the list of them, each under an error boundary of its own. */
function Split({ part }: ClientPartProps): ReactNode {
  const [panels] = useReactiveState(localOf<readonly Panel[]>(part, 'panels'));
  const sites = useSites(part);
  const items = panels.map((panel) =>
    sites.item('d1', { panels }, { item: panel, key: panel.panelId }),
  );
  return (
    <section>
      <Boundary>{sites.of('d0', { panels })}</Boundary>
      <Boundary>
        <Suspense fallback={<p role="status">読み込み中</p>}>{items}</Suspense>
      </Boundary>
    </section>
  );
}

/**
 * A count of the panels, and a list of each panel's to-do as a number — `NaN` of an id of letters,
 * which JSON does not carry — each under an error boundary of its own.
 */
function Numbered({ part }: ClientPartProps): ReactNode {
  const [panels] = useReactiveState(localOf<readonly Panel[]>(part, 'panels'));
  const sites = useSites(part);
  const items = panels.map((panel) =>
    sites.item('d1', { panels }, { item: Number(panel.todoId), key: panel.panelId }),
  );
  return (
    <section>
      <Boundary>{sites.of('d0', { panels })}</Boundary>
      <Boundary>
        <Suspense fallback={<p role="status">読み込み中</p>}>{items}</Suspense>
      </Boundary>
    </section>
  );
}

/**
 * A count of a local state the authority started, rendered at `d0` in an error boundary of its own,
 * which a handler sets to what JSON does not carry: `NaN`.
 */
function NotANumber({ part }: ClientPartProps): ReactNode {
  const [count, setCount] = useReactiveState(localOf<number>(part, 'count'));
  const sites = useSites(part);
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setCount(NaN);
        }}
      >
        NaN
      </button>
      <Boundary>
        <Suspense fallback={<p role="status">読み込み中</p>}>{sites.of('d0', { count })}</Suspense>
      </Boundary>
    </section>
  );
}

/**
 * A count of a local state the authority started, rendered at `d0` under a condition of `gate` — a
 * state its conditions alone read, which it is not rendered of, and which a handler opens — in an
 * error boundary that starts over once the gate changes.
 */
function Gated({ part }: ClientPartProps): ReactNode {
  const [count] = useReactiveState(localOf<number>(part, 'count'));
  const [gate, setGate] = useReactiveState(localOf<string>(part, 'gate'));
  const sites = useSites(part);
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setGate('open');
        }}
      >
        open
      </button>
      <Boundary key={gate}>
        <Suspense fallback={<p role="status">読み込み中</p>}>
          {sites.of('d0', { count }, { gate })}
        </Suspense>
      </Boundary>
    </section>
  );
}

const WORKSPACE = 'instance:workspace';
const GATED = 'instance:gated';
const SPLIT = 'instance:split';
const TALLY = 'instance:tally';
const PANELS = 'instance:panels';
const TWINS = 'instance:twins';
const NUMBERED = 'instance:numbered';
const NOT_A_NUMBER = 'instance:not-a-number';
const WORKSPACE_ELEMENTS: Elements = {
  ...ELEMENTS,
  clients: {
    ...ELEMENTS.clients,
    'components/gated': Gated,
    'components/not-a-number': NotANumber,
    'components/numbered': Numbered,
    'components/panels': Panels,
    'components/split': Split,
    'components/swapper': Swapper,
    'components/tally': Tally,
    'components/twins': Twins,
    'components/workspace': Workspace,
  },
};

/** The panels of `pairs`: each its panel's id, and the to-do it shows. */
function panelsOf(...pairs: readonly (readonly [string, string])[]): readonly Panel[] {
  return pairs.map(([panelId, todoId]) => ({ panelId, todoId }));
}

/** The panels as JSON, as a tree and a frame carry them. */
function jsonOf(panels: readonly Panel[]): Json[] {
  return panels.map(({ panelId, todoId }) => ({ panelId, todoId }));
}

/**
 * The panels as the authority renders them at `revision` for `panels`: each item's detail names its
 * to-do and the revision — and `missing` panels it renders no item of.
 */
function panelsAt(
  revision: number,
  panels: readonly Panel[],
  missing: readonly string[] = [],
): Rendered {
  const items = panels
    .filter(({ panelId }) => !missing.includes(panelId))
    .map(({ panelId, todoId }) => {
      return {
        content: textAt(`detail-${panelId}`, `${todoId}@${String(revision)}`),
        item: { panelId, todoId },
        key: panelId,
      };
    });
  const listed = jsonOf(panels);
  return {
    component: 'components/panels',
    key: null,
    kind: 'client',
    part: {
      instance: PANELS,
      props: {},
      reads: ['panels'],
      sites: panels.length === 0 ? {} : { d0: { inputs: { panels: listed }, items } },
      slots: {},
      states: { panels: { value: listed } },
    },
  };
}

/** The two lists of `panels` as the authority renders them at `revision`, each item named by its list. */
function twinsAt(revision: number, panels: readonly Panel[]): Rendered {
  const listed = jsonOf(panels);
  const listOf = (site: string): RenderedSite => {
    const items = panels.map(({ panelId, todoId }) => {
      return {
        content: textAt(`${site}-${panelId}`, `${todoId}@${String(revision)}`),
        item: { panelId, todoId },
        key: panelId,
      };
    });
    return { inputs: { panels: listed }, items };
  };
  return {
    component: 'components/twins',
    key: null,
    kind: 'client',
    part: {
      instance: TWINS,
      props: {},
      sites: { d0: listOf('d0'), d1: listOf('d1') },
      slots: {},
      states: { panels: { value: listed } },
    },
  };
}

/** The count and the list of `panels` at `revision`: the count rendered, the list refused. */
function splitAt(revision: number, panels: readonly Panel[], message: string): Rendered {
  const listed = jsonOf(panels);
  return {
    component: 'components/split',
    key: null,
    kind: 'client',
    part: {
      instance: SPLIT,
      props: {},
      sites: {
        d0: {
          content: textAt('count', `${String(panels.length)}@${String(revision)}`),
          inputs: { panels: listed },
        },
        d1: { inputs: { panels: listed }, refused: { code: 'INVALID_VIEW', message } },
      },
      slots: {},
      states: { panels: { value: listed } },
    },
  };
}

/**
 * The count and the numbered list of `panels` at `revision`: the count rendered, and the list, of
 * items no JSON holds, shown nothing of at first, as the authority starts it.
 */
function numberedAt(revision: number, panels: readonly Panel[]): Rendered {
  const listed = jsonOf(panels);
  return {
    component: 'components/numbered',
    key: null,
    kind: 'client',
    part: {
      instance: NUMBERED,
      props: {},
      sites: {
        d0: {
          content: textAt('count', `${String(panels.length)}@${String(revision)}`),
          inputs: { panels: listed },
        },
      },
      slots: {},
      states: { panels: { value: listed } },
    },
  };
}

/** The count of `count` at `revision`, its site shown. */
function notANumberAt(revision: number, count: number): Rendered {
  return {
    component: 'components/not-a-number',
    key: null,
    kind: 'client',
    part: {
      instance: NOT_A_NUMBER,
      props: {},
      reads: ['count'],
      sites: {
        d0: { content: textAt('count', `${String(count)}@${String(revision)}`), inputs: { count } },
      },
      slots: {},
      states: { count: { value: count } },
    },
  };
}

/**
 * The gated count at `revision`, its gate `shut`, whose site the authority refused for the gate the
 * page sends, `shut`, with `message`.
 */
function gatedAt(revision: number, message: string): Rendered {
  return {
    component: 'components/gated',
    key: null,
    kind: 'client',
    part: {
      instance: GATED,
      props: {},
      sites: {
        d0: {
          inputs: { count: revision, gate: 'shut' },
          refused: { code: 'INVALID_VIEW', message },
        },
      },
      slots: {},
      states: { count: { value: revision }, gate: { value: 'shut' } },
    },
  };
}

/** The panels' view: the list, shown for `panels`, or nothing for none. */
function panelsView(panels: readonly Panel[]): View {
  return { [PANELS]: panels.length === 0 ? {} : { d0: { panels: jsonOf(panels) } } };
}

/**
 * What a request names of the panels' part the page set to `panels`: the view of them, and the
 * value it set, which `$set` holds where no site it names carries it.
 */
function panelsSent(panels: readonly Panel[]): View {
  return {
    [PANELS]:
      panels.length === 0
        ? { $set: { panels: jsonOf(panels) } }
        : { $set: {}, d0: { panels: jsonOf(panels) } },
  };
}

/** A frame of the panels' root at `revision`, rendered for `panels`. */
function panelsFrame(revision: number, panels: readonly Panel[]): Frame {
  return frameAt(revision, FIELDS, { rootKey: 'root:p1', view: panelsView(panels) });
}

/** What the `view` Server Function answers: the panels at the next revision, 2, rendered for `panels`. */
function panelsAnswer(panels: readonly Panel[]): Result<ViewAnswer<ReactNode>> {
  return rendered(panelsFrame(2, panels), workspaceOf(panelsAt(2, panels)));
}

/** The panels A and B, both of `t1`, as the page is first rendered. */
const OPEN = panelsOf(['A', 't1'], ['B', 't1']);

function openPanels(view: ViewFunction): ReturnType<typeof render> {
  return render(workspacePage(panelsFrame(1, OPEN), panelsAt(1, OPEN), view));
}

async function noteIn(panelId: string, note: string): Promise<void> {
  await interact(() => {
    fireEvent.change(screen.getByRole('textbox', { name: `${panelId} のメモ` }), {
      target: { value: note },
    });
  });
}

function noteOf(panelId: string): string {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: `${panelId} のメモ` }).value;
}

/** The panels' cards, by their panels' ids, in the order the page shows them. */
function cardOrder(): readonly (string | undefined)[] {
  const cards = document.querySelectorAll<HTMLElement>('[data-panel-id]');
  return [...cards].map((card) => card.dataset['panelId']);
}

/** What each panel's detail shows, of `panelIds`, while it is shown. */
function detailsOf(...panelIds: readonly string[]): readonly (string | undefined)[] {
  return panelIds.map((panelId) => shownText(`detail-${panelId}`));
}

/** The tally as the authority renders it at `revision`, of `count`: its site shown. */
function tallyAt(revision: number, count: number): Rendered {
  return {
    component: 'components/tally',
    key: null,
    kind: 'client',
    part: {
      instance: TALLY,
      props: {},
      reads: ['count'],
      sites: { d0: { content: textAt('badge', `badge@${String(revision)}`), inputs: { count } } },
      slots: {},
      states: { count: { value: count } },
    },
  };
}

/** The tally's view: its site, shown for `count`. */
function tallyView(count: number): View {
  return { [TALLY]: { d0: { count } } };
}

/** A frame of the tally's root at `revision`, rendered for `count`. */
function tallyFrame(revision: number, count: number): Frame {
  return frameAt(revision, FIELDS, { rootKey: 'root:p1', view: tallyView(count) });
}

/** The inputs the workspace shows: its filter, and the item it shows the details of, if any. */
interface Shows {
  readonly filter: string;
  readonly selectedId?: string;
}

function textAt(testId: string, text: string): Rendered {
  return {
    children: [text],
    key: null,
    kind: 'element',
    props: { 'data-testid': testId },
    type: 'p',
  };
}

/** The workspace's view: the inputs of each site it shows. */
function viewOf(shows: Shows): View {
  const { filter, selectedId } = shows;
  return {
    [WORKSPACE]: {
      d0: { filter },
      ...(selectedId !== undefined && { d1: { selectedId } }),
    },
  };
}

/**
 * What a request names of the workspace's view of `shows`: of each site's inputs, those of the
 * states the page set (`set`); the rest it still follows, and leaves out for the authority to render
 * of its own values.
 */
function sentOf(shows: Shows, set: readonly string[]): View {
  const named: Record<string, Record<string, View[string][string]>> = {};
  const values = Object.fromEntries(
    Object.entries(shows).filter(([name]) => set.includes(name)),
  ) as View[string][string];
  const view = viewOf(shows);
  for (const [instance, sites] of Object.entries(view)) {
    const part: Record<string, View[string][string]> = {};
    for (const [site, inputs] of Object.entries(sites)) {
      part[site] = Object.fromEntries(
        Object.entries(inputs).filter(([name]) => set.includes(name)),
      );
    }
    // Of the values the page set, `$set` holds those no site it names carries.
    const carried = new Set(Object.values(part).flatMap((inputs) => Object.keys(inputs)));
    part['$set'] = Object.fromEntries(
      Object.entries(values).filter(([name]) => !carried.has(name)),
    );
    named[instance] = part;
  }
  return named;
}

/**
 * The workspace as the authority renders it at `revision` for the view `shows`, its states starting
 * from the inputs shown: each site's content names its inputs and the revision.
 */
function workspaceAt(revision: number, shows: Shows): Rendered {
  const { filter, selectedId } = shows;
  const at = `@${String(revision)}`;
  return {
    component: 'components/workspace',
    key: null,
    kind: 'client',
    part: {
      instance: WORKSPACE,
      props: {},
      reads: ['filter', 'selectedId'],
      sites: {
        d0: { content: textAt('list', `${filter}${at}`), inputs: { filter } },
        ...(selectedId !== undefined && {
          d1: { content: textAt('detail', `${selectedId}${at}`), inputs: { selectedId } },
        }),
      },
      slots: {},
      states: { filter: { value: filter }, selectedId: { value: selectedId ?? '' } },
    },
  };
}

/** A frame of the workspace's root at `revision`, rendered for `shows`. */
function workspaceFrame(revision: number, shows: Shows, rootKey = 'root:p1'): Frame {
  return frameAt(revision, FIELDS, { rootKey, view: viewOf(shows) });
}

/** The workspace's root, as `renderRoot` renders it. */
function workspacePage(
  frame: Frame,
  tree: Rendered,
  view: ViewFunction,
  session = ALICE,
): ReactNode {
  return (
    <LiveRoot events={EVENTS} frame={frame} session={session} update={unanswered()} view={view}>
      {workspaceOf(tree)}
    </LiveRoot>
  );
}

/** The workspace's root as an entry a link's prefetch carries renders it (`prefetchable`). */
function prefetchedPage(frame: Frame, tree: Rendered, view: ViewFunction): ReactNode {
  return (
    <LiveRoot
      events={EVENTS}
      frame={frame}
      prefetchable
      session={ALICE}
      update={unanswered()}
      view={view}
    >
      {workspaceOf(tree)}
    </LiveRoot>
  );
}

/** The workspace's tree as the page renders it, inside the application's error boundary. */
function workspaceOf(tree: Rendered): ReactNode {
  return <Boundary>{renderTree(tree, WORKSPACE_ELEMENTS)}</Boundary>;
}

/** What the `view` Server Function answers: the workspace at `revision`, rendered for `shows`. */
function workspaceAnswer(revision: number, shows: Shows): Result<ViewAnswer<ReactNode>> {
  const tree = workspaceOf(workspaceAt(revision, shows));
  return rendered(workspaceFrame(revision, shows), tree);
}

/**
 * Runs what the user does inside an awaited `act`: a render it makes may suspend, which React's
 * `act` keeps until it has unwound, as it does nothing a `fireEvent` alone waits for.
 */
async function interact(event: () => void): Promise<void> {
  await act(async () => {
    event();
    await Promise.resolve();
  });
}

async function filterBy(filter: string): Promise<void> {
  await interact(() => {
    fireEvent.change(screen.getByRole('combobox', { name: '絞り込み' }), {
      target: { value: filter },
    });
  });
}

async function press(name: string): Promise<void> {
  await interact(() => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

/**
 * The text of the element `testId`, while it is shown: React hides what a boundary shows while it
 * shows its fallback.
 */
function shownText(testId: string): string | undefined {
  const element = screen.queryByTestId(testId);
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.style.display === 'none') {
      return undefined;
    }
  }
  return element?.textContent ?? undefined;
}

function fallsBack(): boolean {
  return screen.queryByRole('status') !== null;
}

/** A root of no dynamic site and no field: a tree the page may show again as it showed it. */
const PLAIN = 'root:plain';

/** A plain root as a page renders it. */
interface Plain {
  readonly frame: Frame;
  /** What its paragraph says: `text@<revision>` unless said. */
  readonly text?: string;
  /** Whether a link's prefetch may carry it, as a host's `prefetch` has its entry say: so unless said. */
  readonly prefetchable?: boolean;
  readonly session?: string;
}

/** A frame of the plain root `rootKey` at `revision`. */
function plainAt(revision: number, rootKey = PLAIN): Frame {
  return frameAt(revision, {}, { rootKey });
}

/** A plain root as `renderRoot` renders it: a paragraph, which its root key names. */
function plainPage(plain: Plain, view: ViewFunction): ReactNode {
  const { frame, prefetchable = true, session = ALICE } = plain;
  return (
    <LiveRoot
      events={EVENTS}
      frame={frame}
      prefetchable={prefetchable}
      session={session}
      update={unanswered()}
      view={view}
    >
      <p data-testid={frame.rootKey}>{plain.text ?? `text@${String(frame.revision)}`}</p>
    </LiveRoot>
  );
}

/** A plain root of a route gone back to, inside the boundary a navigation waits in. */
function goneBackTo(plain: Plain, view: ViewFunction): ReactNode {
  return <Suspense fallback={<p role="status">戻っています</p>}>{plainPage(plain, view)}</Suspense>;
}

/** Shows a plain root, then lets it go, as a navigation away from its route does. */
async function shownAndLeft(plain: Plain, view: ViewFunction): Promise<void> {
  const shown = render(plainPage(plain, view));
  await settle();
  shown.unmount();
}

/** The event streams opened so far, oldest first: their subscriptions, and whether each was closed. */
function streams(): readonly { readonly subscription: string | null; readonly closed: boolean }[] {
  return opened.map(({ closed, subscription }) => ({ closed, subscription }));
}

/** A write of the page's own whose answer is `answer`, sent as the page makes it. */
function writeAnswered(answer: (operation: FieldOperation) => Result<FieldReceipt>): void {
  pageRuntime().store.set({
    binding: 'binding:title:t1',
    field: 'todos:t1:title',
    send: vi.fn<Send>((operation) => Promise.resolve(answer(operation))),
    session: ALICE,
    updaterId: 'u_set_title',
    value: 'Plan B',
  });
}

/** Waits for the page's store to say what `holds` asks of its status. */
async function storeSays(holds: (status: StoreStatus) => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!holds(pageRuntime().store.getStatus())) {
      throw new Error('The store does not say so yet.');
    }
  });
}

describe('the browser’s half', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    router.refresh.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetPage();
    forgetSources();
    vi.unstubAllGlobals();
  });

  it('exports localOf for the local state input the authority rendered', () => {
    expect(reactive.localOf).toBeTypeOf('function');

    const part: ClientPartProps['part'] = {
      instance: 'contract',
      props: {},
      sites: {},
      slots: {},
      states: { title: { value: 'Draft' } },
    };
    const initial: LocalStateInput<string> = localOf<string>(part, 'title');

    expect(Object.isFrozen(initial)).toBe(true);
  });

  it('refuses a field binding where localOf is asked for a local state', () => {
    const part: ClientPartProps['part'] = {
      instance: 'contract',
      props: {},
      sites: {},
      slots: {},
      states: { title: { field: 'todos:t1:title' } },
    };

    expect(() => localOf<string>(part, 'title')).toThrow('no local state "title"');
  });

  describe('a root the authority rendered, in the browser', () => {
    it('shows a title typed in the details on the row of the same todo at once (T03)', () => {
      const update = unanswered();
      render(page({ frame: FIRST }, update));

      fireEvent.change(titleInput(), { target: { value: 'Plan B' } });

      expect(titleInput().value).toBe('Plan B');
      expect(screen.getByTestId('row-title-t1').textContent).toBe('Plan B');
      expect(screen.getByTestId('row-title-t2').textContent).toBe('Sync');
      expect(sent(update)).toStrictEqual([
        {
          binding: 'binding:title:t1',
          operationId: expect.any(String) as unknown,
          updaterId: 'u_set_title',
          value: 'Plan B',
        },
      ]);
    });

    it('confirms an operation with the frame that reflects it, never showing it twice (T12)', async () => {
      const receipted = deferred<Result<FieldReceipt>>();
      const update = vi.fn<Update>(async () => receipted.promise);
      const view = answering();
      render(page({ frame: FIRST }, update, view));

      increase();
      const [operation] = sent(update);

      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();

      receipted.resolve(receipt(operation?.operationId ?? '', 2));
      await settle();

      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();
      // The root renders itself again, for the view it shows: no site, here.
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: FIRST.subscription, view: {} });

      const reflecting = frameAt(
        2,
        { ...FIELDS, 'todos:t1:estimate': 3 },
        { operations: [operation?.operationId ?? ''] },
      );
      await answerWith(view, 0, projectAnswer(reflecting));
      await settle();

      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();
      expect(screen.getByTestId('pending').textContent).toBe('0 pending');
      expect(view).toHaveBeenCalledTimes(1);
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('shows an operation once when its frame arrives before its answer (T12)', async () => {
      const answer = deferred<Result<FieldReceipt>>();
      const update = vi.fn<Update>(async () => answer.promise);
      const { rerender } = render(page({ frame: FIRST }, update));
      increase();
      const id = sent(update)[0]?.operationId ?? '';

      rerender(
        page(
          { frame: frameAt(2, { ...FIELDS, 'todos:t1:estimate': 3 }, { operations: [id] }) },
          update,
        ),
      );

      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();

      answer.resolve(receipt(id, 2));
      await settle();

      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();
      expect(screen.getByTestId('pending').textContent).toBe('0 pending');
    });

    it('sends two additions with the step each was made with, one after the other (T11)', async () => {
      const first = deferred<Result<FieldReceipt>>();
      const update = vi
        .fn<Update>()
        .mockImplementationOnce(async () => first.promise)
        .mockImplementation(never);
      render(page({ frame: FIRST }, update));

      increase();
      fireEvent.click(screen.getByRole('button', { name: 'step 5' }));
      increase();

      expect(screen.getByRole('button', { name: /^見積もり 8 に 5/u })).toBeDefined();
      expect(update).toHaveBeenCalledTimes(1);

      first.resolve(receipt(sent(update)[0]?.operationId ?? '', 2));
      await settle();

      expect(
        sent(update).map(({ captures, updaterId }) => ({ captures, updaterId })),
      ).toStrictEqual([
        { captures: { step: 1 }, updaterId: 'u_add_estimate' },
        { captures: { step: 5 }, updaterId: 'u_add_estimate' },
      ]);
    });

    it('keeps a newer frame, and the tree it came with, when an older one arrives (T13)', () => {
      const update = unanswered();
      const newer = frameAt(3, { ...FIELDS, 'todos:t1:title': 'Plan C' });
      const { rerender } = render(
        page({ frame: newer, tree: projectTree(['t1', 't2'], 't1') }, update),
      );

      rerender(page({ frame: FIRST, tree: projectTree(['t2', 't1'], 't2') }, update));

      expect(screen.getAllByRole('listitem').map((row) => row.dataset['testid'])).toStrictEqual([
        'row-t1',
        'row-t2',
      ]);
      expect(titleInput().value).toBe('Plan C');

      rerender(
        page(
          {
            frame: frameAt(4, { ...FIELDS, 'todos:t1:title': 'Zed' }),
            tree: projectTree(['t2', 't1'], 't1'),
          },
          update,
        ),
      );

      expect(screen.getAllByRole('listitem').map((row) => row.dataset['testid'])).toStrictEqual([
        'row-t2',
        'row-t1',
      ]);
      expect(titleInput().value).toBe('Zed');
    });

    it('keeps each row’s own state by its key when the order changes, and the editor’s note (T14)', () => {
      const update = unanswered();
      const { rerender } = render(page({ frame: FIRST }, update));
      fireEvent.click(screen.getByRole('button', { name: 'mark t2' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'メモ' }), {
        target: { value: 'memo' },
      });

      rerender(
        page(
          {
            frame: frameAt(2, { ...FIELDS, 'todos:t1:title': 'Zed' }),
            tree: projectTree(['t2', 't1'], 't1'),
          },
          update,
        ),
      );

      expect(screen.getAllByRole('listitem').map((row) => row.dataset['testid'])).toStrictEqual([
        'row-t2',
        'row-t1',
      ]);
      expect(screen.getByRole('button', { name: 'marked t2' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'mark t1' })).toBeDefined();
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'メモ' }).value).toBe('memo');
    });

    it('renders the root anew for another session, and keeps what the page held for another root of its own', () => {
      const update = unanswered();
      const { rerender } = render(page({ frame: FIRST }, update));
      fireEvent.change(screen.getByRole('textbox', { name: 'メモ' }), {
        target: { value: 'memo' },
      });

      rerender(page({ frame: frameAt(2, FIELDS, { rootKey: 'root:p1:active' }) }, update));
      const kept = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'メモ' }).value;
      rerender(
        page(
          { frame: frameAt(3, FIELDS, { rootKey: 'root:p1:bob' }), session: 'session:bob' },
          update,
        ),
      );

      expect(kept).toBe('memo');
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'メモ' }).value).toBe('');
    });

    it('drops the operations of a binding the authority refused, and keeps writing the others (T10)', async () => {
      const estimate = deferred<Result<FieldReceipt>>();
      const update = vi.fn<Update>(async (input) => {
        return (input as FieldOperation).binding === 'binding:title:t1'
          ? refusal(403, 'FORBIDDEN', 'You may no longer edit this todo.')
          : estimate.promise;
      });
      const view = unviewed();
      render(page({ frame: FIRST }, update, view));

      fireEvent.change(titleInput(), { target: { value: 'Plan B' } });
      increase();
      await settle();

      expect(titleInput().value).toBe('Plan');
      expect(screen.getByTestId('row-title-t1').textContent).toBe('Plan');
      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();
      expect(sent(update).map(({ binding }) => binding)).toStrictEqual([
        'binding:title:t1',
        'binding:estimate:t1',
      ]);
      expect(screen.getByRole('alert').textContent).toBe('You may no longer edit this todo.');
      // The root renders itself again, whatever revision it shows: what the refusal took back.
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: FIRST.subscription, view: {} });

      estimate.resolve(receipt(sent(update)[1]?.operationId ?? '', 2));
      await settle();

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: /^見積もり 3/u })).toBeDefined();
    });

    it('renders the root again for each newer revision its stream announces, one request at a time', async () => {
      const view = answering();
      render(page({ frame: FIRST }, unanswered(), view));
      const [source] = opened;

      expect(source?.subscription).toBe(FIRST.subscription);

      source?.emit('frame', { frame: { revision: 2 } });
      await settle();
      source?.emit('frame', { frame: { revision: 3 } });
      await settle();

      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: FIRST.subscription, view: {} });

      const second = frameAt(2, { ...FIELDS, 'todos:t1:title': 'Plan 2' });
      await answerWith(view, 0, projectAnswer(second));
      await settle();

      expect(titleInput().value).toBe('Plan 2');
      expect(view).toHaveBeenLastCalledWith({ subscription: second.subscription, view: {} });

      await answerWith(view, 1, projectAnswer(frameAt(3, FIELDS)));
      source?.emit('frame', { frame: { revision: 3 } });
      await settle();

      expect(titleInput().value).toBe('Plan');
      expect(view).toHaveBeenCalledTimes(2);
      expect(router.refresh).not.toHaveBeenCalled();
      // A view of no site is followed as it was: the stream is kept.
      expect(opened).toHaveLength(1);
    });

    it('follows the root anew once it is rendered with another key', async () => {
      const update = unanswered();
      const { rerender } = render(page({ frame: FIRST }, update));

      const done = frameAt(2, FIELDS, { rootKey: 'root:p1:done' });
      rerender(page({ frame: done }, update));
      await settle();

      expect(opened.map(({ closed, subscription }) => ({ closed, subscription }))).toStrictEqual([
        { closed: true, subscription: FIRST.subscription },
        { closed: false, subscription: done.subscription },
      ]);
    });

    it('sends nothing more, and renders again, once the stream says the session ended', async () => {
      const update = unanswered();
      render(page({ frame: FIRST }, update));

      act(() => {
        opened[0]?.emit('revoked', { code: 'UNAUTHENTICATED', error: 'The session ended.' });
      });
      await settle();
      fireEvent.change(titleInput(), { target: { value: 'Plan B' } });

      expect(screen.getByRole('alert').textContent).toBe('The session ended.');
      expect(update).not.toHaveBeenCalled();
      expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
      expect(opened[0]?.closed).toBe(true);
    });

    it('drops the operations of the session before once the root is rendered for another', async () => {
      const update = unanswered();
      const { rerender } = render(page({ frame: FIRST }, update));
      fireEvent.change(titleInput(), { target: { value: 'Plan B' } });

      rerender(
        page(
          { frame: frameAt(2, FIELDS, { rootKey: 'root:p1:bob' }), session: 'session:bob' },
          update,
        ),
      );

      expect(titleInput().value).toBe('Plan');

      await settle();

      expect(screen.getByTestId('pending').textContent).toBe('0 pending');
    });

    it('asks for a reload once a write is refused for another build', async () => {
      const update = vi.fn<Update>(() =>
        Promise.resolve(refusal(409, 'BUILD_MISMATCH', 'The application was updated.')),
      );
      render(page({ frame: FIRST }, update));

      increase();
      await settle();

      expect(screen.getByRole('alert').textContent).toContain('Reload the page.');
      expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
    });

    it('says nothing on the page while everything is saved', () => {
      const { container } = render(page({ frame: FIRST }, unanswered()));

      expect(container.querySelector('[data-reactive-state="notice"]')).toBeNull();
    });

    it('keeps what an input method is composing when a newer frame changes the title (T16)', () => {
      const update = unanswered();
      const { rerender } = render(page({ frame: FIRST }, update));
      const field = titleInput();
      fireEvent.compositionStart(field);
      compose(field, 'Planか', true);

      rerender(page({ frame: frameAt(2, { ...FIELDS, 'todos:t1:title': 'Remote' }) }, update));

      expect(titleInput().value).toBe('Planか');
      expect(update).not.toHaveBeenCalled();

      leave(field, 'Planかな');
      fireEvent.compositionEnd(field);

      expect(titleInput().value).toBe('Planかな');
      expect(sent(update).map(({ value }) => value)).toStrictEqual(['Planかな']);
    });
  });

  describe('a persistent setter', () => {
    afterEach(() => {
      handed.length = 0;
    });

    it('is the same function across frames, and writes with the newest binding of its field', () => {
      const update = unanswered();
      const { rerender } = render(probed(FIRST, probeOf('t1', 'binding:t1@1'), update));

      rerender(probed(frameAt(2, FIELDS), probeOf('t1', 'binding:t1@2'), update));
      act(() => {
        handed.at(-1)?.('Plan B');
      });

      expect(new Set(handed).size).toBe(1);
      expect(sent(update).map(({ binding }) => binding)).toStrictEqual(['binding:t1@2']);
      expect(screen.getByTestId('probe').textContent).toBe('Plan B');
    });

    it('is another for another field, and the one before keeps writing where it did', () => {
      const update = unanswered();
      const { rerender } = render(probed(FIRST, probeOf('t1', 'binding:t1'), update));
      const before = handed.at(-1);

      rerender(probed(frameAt(2, FIELDS), probeOf('t2', 'binding:t2'), update));
      const after = handed.at(-1);
      act(() => {
        before?.('Plan B');
      });

      expect(after).not.toBe(before);
      expect(sent(update).map(({ binding }) => binding)).toStrictEqual(['binding:t1']);
      expect(screen.getByTestId('probe').textContent).toBe('Sync');
    });

    it('refuses a function of the current value, and a write to a state it may only read', () => {
      const update = unanswered();
      const { rerender } = render(probed(FIRST, probeOf('t1', 'binding:t1'), update));

      // A setter that may bind a field takes no function of the current value, by its type — a
      // control typed to call React's setter with one is not given it — and by what it does.
      // @ts-expect-error The setter takes the value alone.
      expect(() => handed.at(-1)?.((value: string) => value)).toThrow(TypeError);

      rerender(probed(FIRST, probeOf('t2', undefined), update));

      expect(() => handed.at(-1)?.('Sync B')).toThrow(/without a setter/u);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('a local state the authority started', () => {
    it('starts from the value the authority computed, and keeps its updates in the page', () => {
      const update = unanswered();
      const part: RenderedClient = {
        component: 'greeting',
        key: null,
        kind: 'client',
        part: { props: {}, slots: {}, states: { greeting: { value: 'Hello' } } },
      };
      render(
        <LiveRoot events={EVENTS} frame={FIRST} session={ALICE} update={update} view={unviewed()}>
          {renderTree(part, { ...ELEMENTS, clients: { greeting: Greeting } })}
        </LiveRoot>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Hello' }));

      expect(screen.getByRole('button', { name: 'Hello!' })).toBeDefined();
      expect(update).not.toHaveBeenCalled();
    });

    it('takes a function of its current value, applied in the page as React applies one', () => {
      const update = unanswered();
      const part: RenderedClient = {
        component: 'appender',
        key: null,
        kind: 'client',
        part: { props: {}, slots: {}, states: { items: { value: ['a'] } } },
      };
      render(
        <LiveRoot events={EVENTS} frame={FIRST} session={ALICE} update={update} view={unviewed()}>
          {renderTree(part, { ...ELEMENTS, clients: { appender: Appender } })}
        </LiveRoot>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'a' }));
      fireEvent.click(screen.getByRole('button', { name: 'a,i1' }));

      expect(screen.getByRole('button', { name: 'a,i1,i2' })).toBeDefined();
      expect(update).not.toHaveBeenCalled();
    });

    it('keeps what it holds where it is written what it holds, or the object it holds a copy of, as React keeps its own states', () => {
      steadied.length = 0;
      renderSteady();

      expect(screen.getByRole('button', { name: 'a,b' })).toBeDefined();
      // Written `ZONED` once, the options hold a copy of it: a new value, as React holds another
      // object, though the page sends it alike; written `ZONED` again, they keep it.
      expect(steadied).toStrictEqual(['a,b areazone', 'a,b areazone']);
    });

    it('holds a new value where it is written another object, though the page sends it alike, as React does', () => {
      renderSteady();
      steadied.length = 0;

      fireEvent.click(screen.getByRole('button', { name: 'a,b' }));

      expect(steadied).toStrictEqual(['a,b areazone']);
    });

    it('holds what it is set to as the page sends it: `-0` as `0`, an entry of `undefined` left out, keys in order of their names', () => {
      const part: RenderedClient = {
        component: 'signed',
        key: null,
        kind: 'client',
        part: { props: {}, slots: {}, states: { count: { value: 1 }, options: { value: {} } } },
      };
      render(
        <LiveRoot
          events={EVENTS}
          frame={FIRST}
          session={ALICE}
          update={unanswered()}
          view={unviewed()}
        >
          {renderTree(part, { ...ELEMENTS, clients: { signed: Signed } })}
        </LiveRoot>,
      );

      fireEvent.click(screen.getByRole('button', { name: '1 plain' }));

      expect(screen.getByRole('button', { name: 'Infinity areazone' })).toBeDefined();
    });
  });

  describe('a part’s dynamic sites', () => {
    const FIRST_SHOWS = { filter: 'all', selectedId: 't1' } as const;

    /** The workspace with its list and its details open, as the page is first rendered. */
    function openWorkspace(view: ViewFunction): ReturnType<typeof render> {
      return render(
        workspacePage(workspaceFrame(1, FIRST_SHOWS), workspaceAt(1, FIRST_SHOWS), view),
      );
    }

    it('shows what the authority rendered at each site for the page’s first values, and asks for nothing', async () => {
      const view = answering();
      openWorkspace(view);
      await settle();

      expect(shownText('list')).toBe('all@1');
      expect(shownText('detail')).toBe('t1@1');
      expect(fallsBack()).toBe(false);
      expect(view).not.toHaveBeenCalled();
    });

    it('waits for a site shown with other inputs, renders the root again for them once, and keeps the part’s own state', async () => {
      const view = answering();
      openWorkspace(view);
      fireEvent.change(screen.getByRole('textbox', { name: 'ノート' }), {
        target: { value: 'メモ' },
      });

      await filterBy('active');
      await settle();

      expect(fallsBack()).toBe(true);
      expect(shownText('list')).toBeUndefined();
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: workspaceFrame(1, FIRST_SHOWS).subscription,
        view: sentOf({ filter: 'active', selectedId: 't1' }, ['filter']),
      });

      await answerWith(view, 0, workspaceAnswer(2, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(fallsBack()).toBe(false);
      expect(shownText('list')).toBe('active@2');
      expect(shownText('detail')).toBe('t1@2');
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'ノート' }).value).toBe(
        'メモ',
      );
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('asks for a site the part opens, and lets go of one it closes without waiting', async () => {
      const view = answering();
      render(
        workspacePage(
          workspaceFrame(1, { filter: 'all' }),
          workspaceAt(1, { filter: 'all' }),
          view,
        ),
      );

      await press('詳細を開く');
      await settle();

      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          view: sentOf({ filter: 'all', selectedId: 't1' }, ['selectedId']),
        }),
      );

      await answerWith(view, 0, workspaceAnswer(2, { filter: 'all', selectedId: 't1' }));
      await settle();
      await press('詳細を閉じる');
      await settle();

      // Closed at once, with nothing to wait for; the root is rendered again without the detail,
      // which its stream follows no more.
      expect([shownText('detail-closed'), shownText('list'), fallsBack()]).toStrictEqual([
        '閉じています',
        'all@2',
        false,
      ]);
      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith(
        expect.objectContaining({ view: { [WORKSPACE]: { $set: { selectedId: '' }, d0: {} } } }),
      );

      await answerWith(view, 1, workspaceAnswer(3, { filter: 'all' }));
      await settle();

      expect(shownText('list')).toBe('all@3');
      expect(view).toHaveBeenCalledTimes(2);
    });

    it('shows nothing one site rendered at another the part renders in its place, of the same inputs', async () => {
      const view = answering();
      const swapper: Rendered = {
        component: 'components/swapper',
        key: null,
        kind: 'client',
        part: {
          instance: 'instance:swapper',
          props: {},
          sites: { d0: { content: textAt('first', 'first@1'), inputs: { id: 't1' } } },
          slots: {},
          states: {},
        },
      };
      const shown = { 'instance:swapper': { d0: { id: 't1' } } };
      render(workspacePage(frameAt(1, FIELDS, { rootKey: 'root:p1', view: shown }), swapper, view));
      await settle();

      expect(shownText('first')).toBe('first@1');

      await press('入れ替える');
      await settle();

      expect(shownText('first')).toBeUndefined();
      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ view: { 'instance:swapper': { $set: {}, d1: {} } } }),
      );
    });

    it('keeps what a site shows as a state its condition alone reads changes, and renders the root again for it meanwhile', async () => {
      const view = answering();
      render(workspacePage(tallyFrame(1, 1), tallyAt(1, 1), view));
      await settle();

      expect(shownText('badge')).toBe('badge@1');

      await press('増やす');
      await settle();

      // The site is not rendered of the count: what it shows stands, while the authority checks the
      // condition it stands under with the count the page holds now.
      expect([shownText('badge'), fallsBack()]).toStrictEqual(['badge@1', false]);
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ view: { [TALLY]: { $set: {}, d0: { count: 2 } } } }),
      );

      const tree = workspaceOf(tallyAt(2, 2));
      await answerWith(view, 0, rendered(tallyFrame(2, 2), tree));
      await settle();

      expect(shownText('badge')).toBe('badge@2');
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing as a state no site reads changes', async () => {
      const view = answering();
      openWorkspace(view);

      fireEvent.change(screen.getByRole('textbox', { name: 'ノート' }), {
        target: { value: 'メモ' },
      });
      await settle();

      expect(view).not.toHaveBeenCalled();
    });

    it('lets go of an answer for inputs the page moved past, though they are shown again, and asks for them anew (A, B, A)', async () => {
      const view = answering();
      openWorkspace(view);

      await filterBy('active');
      await settle();
      await filterBy('completed');
      await settle();
      await filterBy('active');
      await settle();

      expect(view).toHaveBeenCalledTimes(1);

      // The first answer, newer than the one asked for after it, is of a generation moved past.
      await answerWith(view, 0, workspaceAnswer(9, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith(
        expect.objectContaining({
          view: sentOf({ filter: 'active', selectedId: 't1' }, ['filter']),
        }),
      );

      await answerWith(view, 1, workspaceAnswer(3, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(shownText('list')).toBe('active@3');
      expect(view).toHaveBeenCalledTimes(2);
    });

    it('lets go of an answer for inputs the page no longer shows, and shows what it has', async () => {
      const view = answering();
      openWorkspace(view);

      await filterBy('active');
      await settle();
      await filterBy('all');
      await settle();
      await answerWith(view, 0, workspaceAnswer(2, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(shownText('list')).toBe('all@1');
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('renders the root again for a newer revision its stream announces, with the inputs it shows now', async () => {
      const view = answering();
      openWorkspace(view);
      await filterBy('active');
      await settle();
      const shows = { filter: 'active', selectedId: 't1' };
      await answerWith(view, 0, workspaceAnswer(2, shows));
      await settle();
      const { subscription } = workspaceFrame(2, shows);

      // The view shown changed: the stream follows it with the subscription its frame brought.
      expect(opened.at(-1)?.subscription).toBe(subscription);

      opened.at(-1)?.emit('frame', { frame: { revision: 3 } });
      await settle();

      // The page shows what the frame was rendered for: its subscription names the view.
      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith({ subscription, view: {} });
    });

    it('takes a render of the route for other sites than the page shows as a newer revision alone', async () => {
      const view = answering();
      const { rerender } = openWorkspace(view);
      await filterBy('active');
      await settle();
      await answerWith(view, 0, workspaceAnswer(2, { filter: 'active', selectedId: 't1' }));
      await settle();

      // A server operation renders the route again: the root, for its states' first values.
      rerender(workspacePage(workspaceFrame(3, FIRST_SHOWS), workspaceAt(3, FIRST_SHOWS), view));
      await settle();

      // Asked of the frame the page shows, whose subscription names what the page shows.
      expect(shownText('list')).toBe('active@2');
      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith({
        subscription: workspaceFrame(2, { filter: 'active', selectedId: 't1' }).subscription,
        view: {},
      });

      await answerWith(view, 1, workspaceAnswer(3, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(shownText('list')).toBe('active@3');
    });

    it('shows a render of the route for the sites the page shows as it is', async () => {
      const view = answering();
      const { rerender } = openWorkspace(view);

      rerender(workspacePage(workspaceFrame(2, FIRST_SHOWS), workspaceAt(2, FIRST_SHOWS), view));
      await settle();

      expect(shownText('list')).toBe('all@2');
      expect(view).not.toHaveBeenCalled();
    });

    it('keeps what a site shows while a transition waits for other inputs, and shows them together', async () => {
      const view = answering();
      openWorkspace(view);

      await press('未完了を待って表示');
      await settle();

      expect(fallsBack()).toBe(false);
      expect(shownText('list')).toBe('all@1');
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          view: sentOf({ filter: 'active', selectedId: 't1' }, ['filter']),
        }),
      );

      await answerWith(view, 0, workspaceAnswer(2, { filter: 'active', selectedId: 't1' }));
      await settle();
      await settle();

      expect(shownText('list')).toBe('active@2');
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '絞り込み' }).value).toBe(
        'active',
      );
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('drops what the root it showed asked for once it is rendered for another session', async () => {
      const view = answering();
      const { rerender } = openWorkspace(view);
      await filterBy('active');
      await settle();

      const bob = 'root:p1:bob';
      rerender(
        workspacePage(
          workspaceFrame(2, FIRST_SHOWS, bob),
          workspaceAt(2, FIRST_SHOWS),
          view,
          'session:bob',
        ),
      );
      await settle();
      await answerWith(view, 0, workspaceAnswer(3, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '絞り込み' }).value).toBe(
        'all',
      );
      expect(shownText('list')).toBe('all@2');
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('renders a root mounted with a frame older than the page showed since again before it shows (T13)', async () => {
      const view = answering();
      const newer = render(
        workspacePage(workspaceFrame(5, FIRST_SHOWS), workspaceAt(5, FIRST_SHOWS), view),
      );
      await settle();
      newer.unmount();

      // The route the router kept of the page before, gone back to: its tree as first rendered.
      const kept = workspaceFrame(2, FIRST_SHOWS);
      await interact(() => {
        render(
          <Suspense fallback={<p role="status">戻っています</p>}>
            {workspacePage(kept, workspaceAt(2, FIRST_SHOWS), view)}
          </Suspense>,
        );
      });
      await settle();

      // For the view the kept frame's subscription names.
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(shownText('list')).toBeUndefined();
      expect(fallsBack()).toBe(true);

      await answerWith(view, 0, workspaceAnswer(6, FIRST_SHOWS));
      await settle();

      expect(shownText('list')).toBe('all@6');
      expect(fallsBack()).toBe(false);
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('renders each of many roots mounted with frames older than the page showed since again before they show (T13)', async () => {
      const view = answering();
      // The page was told of revision 5: every root below mounts with an older frame.
      pageRuntime().saw(5);
      const keys = Array.from({ length: 17 }, (_, each) => `root:p${String(each)}`);
      await interact(() => {
        render(
          <Suspense fallback={<p role="status">戻っています</p>}>
            {keys.map((key) => {
              return (
                <div key={key}>
                  {workspacePage(
                    workspaceFrame(2, FIRST_SHOWS, key),
                    workspaceAt(2, FIRST_SHOWS),
                    view,
                  )}
                </div>
              );
            })}
          </Suspense>,
        );
      });
      await settle();
      // Each request answered as its root asked it — a bounded few, should requests keep coming.
      for (let call = 0; call < view.mock.calls.length && call < 3 * keys.length; call += 1) {
        const asked = view.mock.calls[call]?.[0] as { readonly subscription: string } | undefined;
        const subscription = asked?.subscription ?? '';
        const rootKey = subscription.slice('subscription:'.length, subscription.lastIndexOf(':'));
        const tree = workspaceOf(workspaceAt(6, FIRST_SHOWS));
        await answerWith(view, call, rendered(workspaceFrame(6, FIRST_SHOWS, rootKey), tree));
      }
      await settle();

      expect(view).toHaveBeenCalledTimes(keys.length);
      expect(fallsBack()).toBe(false);
    });

    it('renders another root shown in its place from a frame older than the page showed since again first, the page held meanwhile (T13)', async () => {
      const view = answering();
      const routeAt = (frame: Frame, revision: number): ReactNode => {
        return (
          <Suspense fallback={<p role="status">戻っています</p>}>
            {workspacePage(frame, workspaceAt(revision, FIRST_SHOWS), view)}
          </Suspense>
        );
      };
      const { rerender } = render(routeAt(workspaceFrame(5, FIRST_SHOWS, 'root:p1:t2'), 5));
      await settle();

      // Gone back to the route the router kept: another root, its frame as it was first rendered.
      const kept = workspaceFrame(2, FIRST_SHOWS);
      await interact(() => {
        startTransition(() => {
          rerender(routeAt(kept, 2));
        });
      });
      await settle();

      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(shownText('list')).toBe('all@5');

      await answerWith(view, 0, workspaceAnswer(6, FIRST_SHOWS));
      await settle();

      expect(shownText('list')).toBe('all@6');
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('shows a root a prefetch carried at once, older than the page showed since, where the page showed nothing newer of it', async () => {
      const view = answering();
      const other = render(
        prefetchedPage(
          workspaceFrame(5, FIRST_SHOWS, 'root:p2'),
          workspaceAt(5, FIRST_SHOWS),
          view,
        ),
      );
      await settle();
      other.unmount();

      // A link's prefetch carried the root's render, at a revision before the page's newest.
      await interact(() => {
        render(
          <Suspense fallback={<p role="status">戻っています</p>}>
            {prefetchedPage(workspaceFrame(2, FIRST_SHOWS), workspaceAt(2, FIRST_SHOWS), view)}
          </Suspense>,
        );
      });
      await settle();

      // Shown at once; its stream, as it opens, sets it right.
      expect(shownText('list')).toBe('all@2');
      expect(fallsBack()).toBe(false);
      expect(view).not.toHaveBeenCalled();
    });

    it('renders a root a prefetch carried again first where the page showed that very root newer', async () => {
      const view = answering();
      const newer = render(
        prefetchedPage(workspaceFrame(5, FIRST_SHOWS), workspaceAt(5, FIRST_SHOWS), view),
      );
      await settle();
      newer.unmount();

      const kept = workspaceFrame(2, FIRST_SHOWS);
      await interact(() => {
        render(
          <Suspense fallback={<p role="status">戻っています</p>}>
            {prefetchedPage(kept, workspaceAt(2, FIRST_SHOWS), view)}
          </Suspense>,
        );
      });
      await settle();

      // The page never goes back to a revision of a root it has shown that root past.
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });

    it('shows a root mounted with a frame older than the page showed since as it is once its catch-up goes unanswered', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const view = answering();
      const newer = render(
        workspacePage(workspaceFrame(5, FIRST_SHOWS), workspaceAt(5, FIRST_SHOWS), view),
      );
      newer.unmount();

      await interact(() => {
        render(
          <Suspense fallback={<p role="status">戻っています</p>}>
            {workspacePage(workspaceFrame(2, FIRST_SHOWS), workspaceAt(2, FIRST_SHOWS), view)}
          </Suspense>,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // What it has, rather than nothing: the root follows it from there.
      expect(shownText('list')).toBe('all@2');
    });

    it('asks the root rendered with another key for what the part still shows, with its own subscription', async () => {
      const view = answering();
      const { rerender } = openWorkspace(view);
      await filterBy('active');
      await settle();

      const other = workspaceFrame(2, FIRST_SHOWS, 'root:p2');
      await interact(() => {
        rerender(workspacePage(other, workspaceAt(2, FIRST_SHOWS), view));
      });
      await settle();

      // The part keeps its state across the root's props, and its site waits for the new root.
      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith({
        subscription: other.subscription,
        view: sentOf({ filter: 'active', selectedId: 't1' }, ['filter']),
      });

      // The first root's answer is let go of.
      await answerWith(view, 0, workspaceAnswer(3, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(fallsBack()).toBe(true);
    });

    it('renders the route again once the authority refuses the session', async () => {
      const view = answering();
      openWorkspace(view);
      await filterBy('active');
      await settle();

      await answerWith(view, 0, refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));
      await settle();

      expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('asks for a reload once the authority refuses the page’s build', async () => {
      const view = answering();
      openWorkspace(view);
      await filterBy('active');
      await settle();

      await answerWith(view, 0, refusal(409, 'BUILD_MISMATCH', 'The application was updated.'));
      await settle();

      expect(screen.getByRole('alert').textContent).toContain('Reload the page.');
      expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
    });

    it('fails the site the authority refuses the view of, for the application’s error boundary', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const view = answering();
      openWorkspace(view);
      await filterBy('active');
      await settle();

      await answerWith(view, 0, refusal(400, 'INVALID_VIEW', 'The view is not valid.'));
      await settle();

      expect(shownText('boundary')).toBe('The view is not valid.');
    });

    it('sends again a request that failed, after a wait', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const view = answering();
      view.mockRejectedValueOnce(new Error('Failed to fetch'));
      openWorkspace(view);
      await filterBy('active');
      await settle();

      expect(view).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(view).toHaveBeenCalledTimes(2);

      await answerWith(view, 0, workspaceAnswer(2, { filter: 'active', selectedId: 't1' }));
      await settle();

      expect(shownText('list')).toBe('active@2');
    });
  });

  describe('a list site’s items', () => {
    it('shows each item as the authority rendered it, the same to-do in two panels, and asks for nothing', async () => {
      const view = answering();
      openPanels(view);
      await settle();

      expect([...detailsOf('A', 'B'), fallsBack()]).toStrictEqual(['t1@1', 't1@1', false]);
      expect(view).not.toHaveBeenCalled();
    });

    it('moves items without waiting, each card’s own state kept, and renders the root again for the order meanwhile', async () => {
      const view = answering();
      openPanels(view);
      await noteIn('A', 'A のメモ');

      await press('並べ替える');
      await settle();
      const reversed = panelsSent(OPEN.toReversed());

      expect([...detailsOf('A', 'B'), fallsBack()]).toStrictEqual(['t1@1', 't1@1', false]);
      expect(noteOf('A')).toBe('A のメモ');
      expect(cardOrder()).toStrictEqual(['B', 'A']);
      expect(view).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ view: reversed }));
    });

    it('asks for the items opened at once in one request, and shows them together', async () => {
      const view = answering();
      openPanels(view);
      const added = openTwo(OPEN);

      await press('二つ開く');
      await settle();

      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ view: panelsSent(added) }),
      );

      await answerWith(view, 0, panelsAnswer(added));
      await settle();

      expect(detailsOf('A', 'B', 'C', 'D')).toStrictEqual(['t1@2', 't1@2', 't2@2', 't3@2']);
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('waits for an item that shows another to-do, its card’s own state kept, the other panel’s untouched', async () => {
      const view = answering();
      openPanels(view);
      await noteIn('A', 'A のメモ');
      await noteIn('B', 'B のメモ');
      const switched = panelsOf(['A', 't2'], ['B', 't1']);

      await press('A を t2 へ');
      await settle();

      expect([fallsBack(), shownText('detail-A')]).toStrictEqual([true, undefined]);
      expect(view).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ view: panelsSent(switched) }),
      );

      await answerWith(view, 0, panelsAnswer(switched));
      await settle();

      expect([...detailsOf('A', 'B'), fallsBack()]).toStrictEqual(['t2@2', 't1@2', false]);
      expect([noteOf('A'), noteOf('B')]).toStrictEqual(['A のメモ', 'B のメモ']);
    });

    it('lets go of an item closed at once, and of every item, with nothing to wait for', async () => {
      const view = answering();
      openPanels(view);
      const left = panelsOf(['B', 't1']);
      const leftView = panelsSent(left);

      await press('A を閉じる');
      await settle();

      expect([...detailsOf('A', 'B'), fallsBack()]).toStrictEqual([undefined, 't1@1', false]);
      expect(view).toHaveBeenLastCalledWith(expect.objectContaining({ view: leftView }));

      await answerWith(view, 0, panelsAnswer(left));
      await settle();
      await press('すべて閉じる');
      await settle();

      expect([shownText('detail-B'), fallsBack()]).toStrictEqual([undefined, false]);
      expect(view).toHaveBeenLastCalledWith(expect.objectContaining({ view: panelsSent([]) }));
    });

    it('shows again what an item showed once it shows that to-do again, and lets go of the answer for the other', async () => {
      const view = answering();
      openPanels(view);

      await press('A を t2 へ');
      await settle();
      await press('A を t1 へ');
      await settle();

      expect([shownText('detail-A'), fallsBack()]).toStrictEqual(['t1@1', false]);

      await answerWith(view, 0, panelsAnswer(panelsOf(['A', 't2'], ['B', 't1'])));
      await settle();

      expect([shownText('detail-A'), fallsBack()]).toStrictEqual(['t1@1', false]);
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('keys the items of two lists in one card apart', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // A key React finds twice among a card's children is reported here.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const listed = jsonOf(OPEN);
      const view = { [TWINS]: { d0: { panels: listed }, d1: { panels: listed } } };
      render(
        workspacePage(
          frameAt(1, FIELDS, { rootKey: 'root:p1', view }),
          twinsAt(1, OPEN),
          answering(),
        ),
      );
      await settle();

      expect(['d0-A', 'd1-A', 'd0-B', 'd1-B'].map((id) => shownText(id))).toStrictEqual([
        't1@1',
        't1@1',
        't1@1',
        't1@1',
      ]);
      expect(reported.mock.calls.flat().join(' ')).not.toContain('same key');
    });

    it('fails a list the authority refused where it stands, the root’s other site shown, asking nothing again', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const listed = jsonOf(OPEN);
      const view = answering();
      const message = 'The list d1 holds the key "A" twice.';
      const frame = frameAt(1, FIELDS, {
        rootKey: 'root:p1',
        view: { [SPLIT]: { d0: { panels: listed }, d1: { panels: listed } } },
      });
      render(workspacePage(frame, splitAt(1, OPEN, message), view));
      await settle();

      expect(shownText('count')).toBe('2@1');
      expect(shownText('boundary')).toBe(message);
      expect(view).not.toHaveBeenCalled();
    });

    it('asks again for a site the authority refused for a state its conditions read that the page holds no more, rather than fail', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const view = answering();
      const message = 'The guard of d0 spent more than the steps it may.';
      const frame = frameAt(1, FIELDS, {
        rootKey: 'root:p1',
        view: { [GATED]: { d0: { count: 1, gate: 'shut' } } },
      });
      render(workspacePage(frame, gatedAt(1, message), view));
      await settle();

      expect(shownText('boundary')).toBe(message);
      expect(view).not.toHaveBeenCalled();

      await interact(() => {
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
      });
      await settle();

      expect(shownText('boundary')).toBeUndefined();
      expect(fallsBack()).toBe(true);
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('fails an item the authority listed the inputs the page sends without, for the application’s error boundary', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const view = answering();
      render(workspacePage(panelsFrame(1, OPEN), panelsAt(1, OPEN, ['B']), view));
      await settle();

      expect(shownText('boundary')).toContain('with no item "B" of this value');
      expect(view).not.toHaveBeenCalled();
    });

    it('fails an item the page cannot send where it stands — `NaN`, which JSON does not carry — the root’s other site shown, asking nothing', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const view = answering();
      const frame = frameAt(1, FIELDS, {
        rootKey: 'root:p1',
        view: { [NUMBERED]: { d0: { panels: jsonOf(OPEN) } } },
      });
      render(workspacePage(frame, numberedAt(1, OPEN), view));
      await settle();

      expect(shownText('count')).toBe('2@1');
      expect(shownText('boundary')).toBe(
        'The item "A" of the site "d1" is NaN, which JSON does not carry as it is.',
      );
      expect(view).not.toHaveBeenCalled();
    });

    it('fails a site whose inputs the page cannot send where it stands — a state set `NaN` — the part around it rendered, the site shown no more', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {
        // React reports what an error boundary caught; kept out of the output.
      });
      onTestFinished(() => {
        reported.mockRestore();
      });
      const view = answering();
      const frame = frameAt(1, FIELDS, {
        rootKey: 'root:p1',
        view: { [NOT_A_NUMBER]: { d0: { count: 1 } } },
      });
      render(workspacePage(frame, notANumberAt(1, 1), view));
      await settle();

      expect(shownText('count')).toBe('1@1');

      await press('NaN');
      await settle();

      expect(shownText('boundary')).toBe(
        'The inputs of the site "d0".count is NaN, which JSON does not carry as it is.',
      );
      expect(screen.getByRole('button', { name: 'NaN' })).toBeDefined();
      // The view the page asks for holds none of the site, as of one it closed, and no set values:
      // of a value JSON carries not, the authority would show the site of its own.
      expect(view.mock.calls).toStrictEqual([
        [expect.objectContaining({ view: { [NOT_A_NUMBER]: {} } })],
      ]);
    });
  });

  describe('a root the page kept as it let it go', () => {
    it('shows what it showed at once, mounted again from an older frame, and asks for it again at once', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      // Another root's stream told the page of a newer revision since.
      pageRuntime().saw(8);

      // The route the router kept, gone back to: its root's frame as it was first rendered.
      await interact(() => {
        render(goneBackTo({ frame: plainAt(2) }, view));
      });
      await settle();

      expect(shownText(PLAIN)).toBe('text@5');
      expect(fallsBack()).toBe(false);
      // Asked for again as it shows, with no stream event: the root as the authority renders it now.
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: plainAt(5).subscription,
        view: {},
      });
      // Followed from what it shows: its stream opens with the newest subscription.
      expect(streams()).toStrictEqual([
        { closed: true, subscription: plainAt(5).subscription },
        { closed: false, subscription: plainAt(5).subscription },
      ]);

      await answerWith(view, 0, rendered(plainAt(8), <p data-testid={PLAIN}>text@8</p>));
      await settle();

      expect(shownText(PLAIN)).toBe('text@8');
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('shows nothing in place of what it kept once the authority answers the root is forbidden', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      await interact(() => {
        render(goneBackTo({ frame: plainAt(2) }, view));
      });
      await settle();

      expect(shownText(PLAIN)).toBe('text@5');

      // The reader was taken out of the root's team meanwhile, the session still theirs.
      const forbidden: Result<ViewAnswer<ReactNode>> = {
        ok: true,
        value: { children: null, frame: plainAt(6), status: 'forbidden' },
      };
      await answerWith(view, 0, forbidden);
      await settle();

      expect(shownText(PLAIN)).toBeUndefined();
      expect(fallsBack()).toBe(false);
      expect(view).toHaveBeenCalledTimes(1);
    });

    it('shows what it showed at once in another root’s place, from an older frame', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      const { rerender } = render(goneBackTo({ frame: plainAt(6, 'root:other') }, view));
      await settle();

      // Gone back to the route the router kept: the kept root's older frame in the other's place.
      await interact(() => {
        startTransition(() => {
          rerender(goneBackTo({ frame: plainAt(2) }, view));
        });
      });
      await settle();

      expect(shownText(PLAIN)).toBe('text@5');
      expect(shownText('root:other')).toBeUndefined();
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: plainAt(5).subscription,
        view: {},
      });
      expect(streams().at(-1)).toStrictEqual({
        closed: false,
        subscription: plainAt(5).subscription,
      });
    });

    it('keeps what a root showed as another root key takes its place, and shows it at once back', async () => {
      const view = answering();
      const { rerender } = render(goneBackTo({ frame: plainAt(5) }, view));
      await settle();
      // A search parameter's navigation: the segment kept, its root rendered with other props.
      rerender(goneBackTo({ frame: plainAt(6, 'root:other') }, view));
      await settle();

      expect(pageRuntime().kept(PLAIN)?.frame).toStrictEqual(plainAt(5));

      // Gone back: the root as the router kept it, in the other's place again.
      await interact(() => {
        startTransition(() => {
          rerender(goneBackTo({ frame: plainAt(2) }, view));
        });
      });
      await settle();

      expect(shownText(PLAIN)).toBe('text@5');
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: plainAt(5).subscription,
        view: {},
      });
    });

    it('keeps nothing of a root while it is on the page, though StrictMode cleans it up as it mounts', async () => {
      const view = answering();
      const shown = render(<StrictMode>{plainPage({ frame: plainAt(5) }, view)}</StrictMode>);
      await settle();

      expect(pageRuntime().kept(PLAIN)).toBeUndefined();

      shown.unmount();

      expect(pageRuntime().kept(PLAIN)?.frame).toStrictEqual(plainAt(5));
    });

    it('lets go of what a root left it once that root shows again, its route hidden and shown', async () => {
      const view = answering();
      const frame = plainAt(5);
      const root = plainPage({ frame }, view);
      const { rerender } = render(<Activity mode="visible">{root}</Activity>);
      await settle();
      // The route left, which the router keeps in a hidden `<Activity>`.
      rerender(<Activity mode="hidden">{root}</Activity>);
      await settle();

      expect(pageRuntime().kept(PLAIN)?.frame).toBe(frame);

      rerender(<Activity mode="visible">{root}</Activity>);
      await settle();

      expect(pageRuntime().kept(PLAIN)).toBeUndefined();
    });

    it('keeps what one root left it while another root shows it, StrictMode’s cleanup of that one too', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      await interact(() => {
        render(<StrictMode>{goneBackTo({ frame: plainAt(2) }, view)}</StrictMode>);
      });
      await settle();

      expect(shownText(PLAIN)).toBe('text@5');
      expect(pageRuntime().kept(PLAIN)?.frame).toStrictEqual(plainAt(5));
    });

    it('keeps the tree another root showed last of what it kept, at the revision it kept', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5), text: 'first@5' }, view);
      // Another root shows it again, from an older frame.
      const restored = render(goneBackTo({ frame: plainAt(2) }, view));
      await settle();

      expect(shownText(PLAIN)).toBe('first@5');

      // A render of the route hands it another tree at that revision — of a render that reads the
      // time, say — and the root is let go of.
      restored.rerender(goneBackTo({ frame: plainAt(5), text: 'second@5' }, view));
      await settle();
      restored.unmount();

      await interact(() => {
        render(goneBackTo({ frame: plainAt(2) }, view));
      });
      await settle();

      expect(shownText(PLAIN)).toBe('second@5');
      expect(view).toHaveBeenLastCalledWith({ subscription: plainAt(5).subscription, view: {} });
    });

    it('keeps the newest tree it showed, where a render of the route changed its tree alone', async () => {
      const view = answering();
      const frame = plainAt(5);
      const shown = render(plainPage({ frame, text: 'first@5' }, view));
      await settle();
      // The same frame, another tree: what the root shows changes, its frame does not.
      shown.rerender(plainPage({ frame, text: 'second@5' }, view));
      await settle();
      shown.unmount();

      await interact(() => {
        render(goneBackTo({ frame: plainAt(2) }, view));
      });
      await settle();

      expect(shownText(PLAIN)).toBe('second@5');
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: frame.subscription, view: {} });
    });

    it('renders the least recently kept of 17 roots again first, and shows another at once', async () => {
      const view = answering();
      const keys = Array.from({ length: 17 }, (_, each) => `root:plain${String(each)}`);
      for (const key of keys) {
        await shownAndLeft({ frame: plainAt(5, key) }, view);
      }

      await interact(() => {
        render(goneBackTo({ frame: plainAt(2, 'root:plain1') }, view));
      });
      await settle();

      expect(shownText('root:plain1')).toBe('text@5');
      // Shown at once, and asked for again: not held for it.
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: plainAt(5, 'root:plain1').subscription,
        view: {},
      });

      // The first kept, let go of by the 17th: rendered again before it shows, as before.
      const first = plainAt(2, 'root:plain0');
      await interact(() => {
        render(goneBackTo({ frame: first }, view));
      });
      await settle();

      expect(view).toHaveBeenCalledTimes(2);
      expect(view).toHaveBeenLastCalledWith({ subscription: first.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });

    it('renders it again first where a write of the page’s own committed past it since', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      writeAnswered((operation) => receipt(operation.operationId, 6));
      await vi.waitFor(() => {
        expect(pageRuntime().carriedFloor(PLAIN)).toBe(6);
      });

      const kept = plainAt(2);
      await interact(() => {
        render(goneBackTo({ frame: kept }, view));
      });
      await settle();

      // What it kept would show the write undone.
      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });

    it('renders it again first once the page showed another session since, though it shows its own again', async () => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      // Another session's root on the page, then one of the first session's again.
      await shownAndLeft({ frame: plainAt(6, 'root:plain:bob'), session: 'session:bob' }, view);
      await shownAndLeft({ frame: plainAt(7, 'root:other') }, view);

      expect(pageRuntime().store.session).toBe(ALICE);

      const kept = plainAt(2);
      await interact(() => {
        render(goneBackTo({ frame: kept }, view));
      });
      await settle();

      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });

    it.each([
      [
        'its stream says the session ended',
        async () => {
          pageRuntime().revoked('The session ended.');
          await storeSays(({ revoked }) => revoked);
        },
      ],
      [
        'its stream says the build is another',
        async () => {
          pageRuntime().revoked('The application was updated.', 'BUILD_MISMATCH');
          await storeSays(({ mismatched }) => mismatched);
        },
      ],
      [
        'a write is refused the session',
        async () => {
          writeAnswered(() => refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));
          await storeSays(({ revoked }) => revoked);
        },
      ],
      [
        'a write is refused for its build',
        async () => {
          writeAnswered(() => refusal(409, 'BUILD_MISMATCH', 'The application was updated.'));
          await storeSays(({ mismatched }) => mismatched);
        },
      ],
    ])('renders it again first once %s', async (_, end) => {
      const view = answering();
      await shownAndLeft({ frame: plainAt(5) }, view);
      await end();

      const kept = plainAt(2);
      await interact(() => {
        render(goneBackTo({ frame: kept }, view));
      });
      await settle();

      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: kept.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });

    it.each([
      [
        'no prefetch may carry',
        (revision: number): Plain => ({ frame: plainAt(revision), prefetchable: false }),
      ],
      [
        'of a field',
        (revision: number): Plain => {
          const field = { 'todos:t1:title': 'Plan' };
          return { frame: frameAt(revision, field, { rootKey: PLAIN }) };
        },
      ],
      [
        'rendered for a site',
        (revision: number): Plain => {
          const site = viewOf({ filter: 'all' });
          return { frame: frameAt(revision, {}, { rootKey: PLAIN, view: site }) };
        },
      ],
    ])('keeps nothing of a root %s, which renders again first', async (_, plainOf) => {
      const view = answering();
      await shownAndLeft(plainOf(5), view);

      const { frame } = plainOf(2);
      await interact(() => {
        render(goneBackTo(plainOf(2), view));
      });
      await settle();

      expect(view).toHaveBeenCalledExactlyOnceWith({ subscription: frame.subscription, view: {} });
      expect(fallsBack()).toBe(true);
    });
  });
});
