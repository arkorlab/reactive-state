import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { digest } from '../src/authority/canonical.ts';
import { type CommitEvent, Engine, type EngineOptions } from '../src/authority/index.ts';
import { fieldOperationOf, rootOf } from '../src/authority/requests.ts';
import {
  type ComponentProgram,
  componentRef,
  type FieldReceipt,
  type Json,
  moduleRef,
  type OperationArgument,
  type OperationReceipt,
  PROTOCOL_VERSION,
  type RenderResult,
  type RenderScope,
  type Value,
} from '../src/program.ts';
import { database, forbidden, requireUser, table, text } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { clientOf, clientsIn, deferred, textOf } from './support/frames.ts';
import {
  ADD_ESTIMATE,
  application,
  BUILD,
  INCREMENT,
  programs,
  SET_CAN_EDIT,
  SET_COMPLETED,
  SET_COUNT,
  SET_TITLE,
} from './support/program.ts';
import {
  SCHEMA_3_CREATED,
  SCHEMA_3_DATABASE,
  SCHEMA_3_OPENED,
  SCHEMA_3_SESSION,
} from './support/schema-3.ts';

interface Opened {
  readonly engine: Engine;
  /** Alice's session: she owns p1 and p2. */
  readonly alice: string;
  /** Bob's session: a member of p1 and p2 who may edit them, and the owner of p3. */
  readonly bob: string;
  /** Every commit the engine announced since it opened. */
  readonly commits: CommitEvent[];
}

/** An authority on an in-memory database, closed when the test finishes, with both users signed in. */
async function open(options: Partial<EngineOptions> = {}): Promise<Opened> {
  const engine = new Engine({ ...application, ...options });
  onTestFinished(async () => {
    await engine.close();
  });
  const commits: CommitEvent[] = [];
  engine.onCommit((event) => {
    commits.push(event);
  });
  const alice = await engine.login('alice');
  const bob = await engine.login('bob');
  return { alice: alice.sessionId, bob: bob.sessionId, commits, engine };
}

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

/** A program of the test build: `evaluate`, and the states it writes, if any. */
function program(
  component: string,
  evaluate: (props: Readonly<Record<string, Json>>, $: RenderScope) => unknown,
  states?: Pick<ComponentProgram, 'updaters' | 'writable'>,
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    ...(states ?? STATELESS),
  };
}

const PAGE = { filter: 'all', projectId: 'p1', selectedId: 't1' } as const;

/** A project's page, as the fixture's route renders it: every item of it, and the one selected. */
async function project(
  engine: Engine,
  session: string | null,
  props: Readonly<Record<string, Json>> = PAGE,
): Promise<RenderResult> {
  return engine.render(session, { build: BUILD, component: 'components/project', props });
}

/** The binding `component` writes `key` with in the tree, where it is rendered once. */
function bindingOf(rendered: RenderResult, component: string, key: string): string {
  const state = clientOf(rendered.tree, component).part.states[key];
  if (state === undefined || !('binding' in state)) {
    throw new Error(`${component} has no binding for ${key}.`);
  }
  return state.binding;
}

/** The binding the editor of the selected item writes `key` with. */
function editorBinding(rendered: RenderResult, key = 'title'): string {
  return bindingOf(rendered, 'components/todo-editor', key);
}

interface WriteInput {
  readonly binding: string;
  readonly updaterId: string;
  readonly value?: Value;
  readonly captures?: Readonly<Record<string, Json>>;
  readonly operationId?: string;
}

async function write(engine: Engine, session: string, input: WriteInput): Promise<FieldReceipt> {
  return engine.update(session, { operationId: crypto.randomUUID(), ...input });
}

/** A server operation, as the application's server sends one: of `actions/todos` unless another module is named. */
async function operate(
  engine: Engine,
  session: string,
  call: {
    readonly name: string;
    readonly args: readonly OperationArgument[];
    readonly operationId?: string;
    readonly module?: string;
  },
): Promise<OperationReceipt> {
  const { args, module = 'actions/todos', name, operationId = crypto.randomUUID() } = call;
  return engine.operate(session, { args, build: BUILD, module, name, operationId });
}

/** A form's entries, as a server operation is sent them. */
function form(entries: Readonly<Record<string, string>>): OperationArgument {
  return { form: Object.entries(entries) };
}

function json(value: Json): OperationArgument {
  return { json: value };
}

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** The ids of the todos a project's page lists, in its order. */
function listed(rendered: RenderResult): readonly (string | null)[] {
  return clientsIn(rendered.tree, 'components/todo-row').map((row) => row.key);
}

describe('a render', () => {
  it('renders a page’s root and every component its tree renders, at one revision', async () => {
    const { alice, engine } = await open();

    const rendered = await project(engine, alice);

    expect(rendered.status).toBe('rendered');
    expect(textOf(rendered.tree)).toContain('確定した集計: 未完了 2 件 / 完了 0 件');
    expect(listed(rendered)).toStrictEqual(['t1', 't2']);
    expect(clientOf(rendered.tree, 'components/member-editor').part.props).toStrictEqual({
      id: 'p1-bob',
    });
    expect(rendered.frame.fields).toStrictEqual({
      'memberships:p1-bob:canEdit': true,
      'todos:t1:completed': false,
      'todos:t1:estimate': 2,
      'todos:t1:title': '一覧を作る',
      'todos:t2:completed': false,
      'todos:t2:estimate': 3,
      'todos:t2:title': '同期を確認する',
    });
    expect(rendered.frame).toMatchObject({ buildId: BUILD, operations: [], revision: 0 });
  });

  it('renders a component the server renders as a fragment under its key, and one with states as its client part', async () => {
    const { bob, engine } = await open();

    const rendered = await project(engine, bob);
    const editor = clientOf(rendered.tree, 'components/todo-editor');

    expect(rendered.tree).toMatchObject({ key: null, kind: 'fragment' });
    expect(editor.key).toBe('t1');
    expect(editor.part.states).toMatchObject({
      completed: { field: 'todos:t1:completed', set: SET_COMPLETED },
      draft: { value: '' },
      title: { field: 'todos:t1:title', set: SET_TITLE },
      'useEstimate#0.estimate': { field: 'todos:t1:estimate' },
    });
    // The setter's binding, and no registered `set` where the state has none.
    expect(editor.part.states['useEstimate#0.estimate']).not.toHaveProperty('set');
    expect(editor.part.slots['s0']).toMatchObject({ key: null, kind: 'fragment' });
    // A member is no owner: the members' editors are not rendered for him.
    expect(clientsIn(rendered.tree, 'components/member-editor')).toHaveLength(0);
  });

  it('issues no binding for a state the component has no setter for', async () => {
    const { alice, engine } = await open();

    const rendered = await project(engine, alice);
    const [row] = clientsIn(rendered.tree, 'components/todo-row');

    expect(row?.part.states).toStrictEqual({
      completed: { field: 'todos:t1:completed' },
      estimate: { field: 'todos:t1:estimate' },
      title: { field: 'todos:t1:title' },
    });
  });

  it('renders a component that refuses the session as nothing in its place', async () => {
    const refusing = program('test/refusing', () => forbidden());
    const parent = program('test/parent', (_, $) => {
      return $.h(
        'div',
        null,
        $.h(componentRef('test/refusing'), { key: 'a' }),
        $.h(componentRef('components/counter'), { id: 'main' }),
      );
    });
    const { alice, engine } = await open({ programs: [...programs, refusing, parent] });

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/parent',
      props: {},
    });

    expect(rendered.status).toBe('rendered');
    expect(rendered.tree).toMatchObject({
      children: [{ children: [null, { component: 'components/counter', kind: 'client' }] }],
    });
  });

  it('answers a session that may not see the root with its status, an empty tree and a frame', async () => {
    const { alice, engine } = await open();

    const signedOut = await project(engine, null);
    const refused = await project(engine, alice, { filter: 'all', projectId: 'p3' });

    expect(signedOut).toMatchObject({
      frame: { fields: {}, operations: [], subscription: '' },
      status: 'unauthenticated',
      tree: null,
    });
    expect(refused).toMatchObject({ frame: { fields: {} }, status: 'forbidden', tree: null });
    // A root refused is followed all the same: access may come back.
    expect(refused.frame.subscription).not.toBe('');
  });

  it('refuses a root it does not run, of another build, or rendered with props that are not JSON', async () => {
    const { alice, engine } = await open();
    const props = { filter: 'all', projectId: 'p1' };

    await expect(
      engine.render(alice, { build: BUILD, component: 'components/missing', props }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_COMPONENT', status: 404 });
    await expect(
      engine.render(alice, { build: 'b_other', component: 'components/project', props }),
    ).rejects.toMatchObject({ code: 'BUILD_MISMATCH', status: 409 });
    await expect(
      engine.render(alice, { build: BUILD, component: 'components/project', props: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_ROOT', status: 400 });
  });

  it('answers a selected id no record could have with the todo’s absence, not a fault', async () => {
    const { alice, engine } = await open();

    const rendered = await project(engine, alice, {
      filter: 'all',
      projectId: 'p1',
      selectedId: 'a.b',
    });

    expect(rendered.status).toBe('rendered');
    expect(textOf(rendered.tree)).toContain('選択した Todo は削除または移動されました。');
  });

  it('answers as a fault what a component throws other than a refusal, a function prop, and a state no page could be sent', async () => {
    const failing = program('test/failing', () => {
      throw new Error('broken');
    });
    const handler = program('test/handler', (_, $) => $.h('button', { onClick: vi.fn() }));
    const unsent = program('test/unsent', (_, $) =>
      $.client({ props: {}, slots: {}, states: { when: new Date() } }),
    );
    const { alice, engine } = await open({ programs: [...programs, failing, handler, unsent] });
    const render = async (component: string): Promise<unknown> =>
      rejection(engine.render(alice, { build: BUILD, component, props: {} }));

    await expect(render('test/failing')).resolves.toMatchObject({ message: 'broken' });
    await expect(render('test/handler')).resolves.toBeInstanceOf(TypeError);
    await expect(render('test/unsent')).resolves.toBeInstanceOf(TypeError);
  });

  it('starts a state from JSON shaped as a field reference as that value, binding no field', async () => {
    const shaped = program(
      'test/shaped',
      (props, $) => $.client({ props: {}, slots: {}, states: { title: props['initial'] } }),
      { updaters: { [SET_TITLE]: { keys: ['title'], kind: 'set' } }, writable: ['title'] },
    );
    const { alice, engine } = await open({ programs: [...programs, shaped] });
    const initial = { field: 'title', id: 't1', kind: 'field', table: 'todos' };

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/shaped',
      props: { initial },
    });

    expect(clientOf(rendered.tree, 'test/shaped').part.states).toStrictEqual({
      title: { value: initial },
    });
    expect(rendered.frame.fields).toStrictEqual({});
  });

  it('answers as a fault a field reference handed to a component as a prop, which is no JSON', async () => {
    const child = program('test/child', (_, $) => $.h('p', null, 'child'));
    const parent = program('test/parent', (_, $) =>
      $.h(componentRef('test/child'), { title: db.todos.ref('t1').title }),
    );
    const { alice, engine } = await open({ programs: [...programs, child, parent] });

    const fault = await rejection(
      engine.render(alice, { build: BUILD, component: 'test/parent', props: {} }),
    );

    expect(fault).toBeInstanceOf(TypeError);
    expect((fault as Error).message).toContain('holds a reference');
  });

  it('answers as a fault a prop of an entry a symbol keys, which no JSON holds, rather than drop it', async () => {
    const child = program('test/child', (_, $) => $.h('p', null, 'child'));
    const parent = program('test/parent', (_, $) =>
      $.h(componentRef('test/child'), { payload: { [Symbol('marker')]: 'x', title: 'y' } }),
    );
    const { alice, engine } = await open({ programs: [...programs, child, parent] });

    const fault = await rejection(
      engine.render(alice, { build: BUILD, component: 'test/parent', props: {} }),
    );

    expect(fault).toBeInstanceOf(TypeError);
    expect((fault as Error).message).toContain('is not JSON');
  });

  it.each([
    [
      'an entry it does not enumerate',
      Object.defineProperty({ title: 'y' }, 'hidden', { value: 'x' }),
    ],
    ['raw JSON text', (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON('1')],
    [
      'a name of its own beside an array’s elements',
      Object.defineProperty([1], 'extra', { enumerable: true, value: 'x' }),
    ],
    [
      'an entry an accessor computes',
      Object.defineProperty({ title: 'y' }, 'x', { enumerable: true, get: () => 'z' }),
    ],
    [
      'an element an accessor computes',
      Object.defineProperty(['a'], '0', { enumerable: true, get: () => 'b' }),
    ],
    ['a hole of an array', Object.assign([] as string[], { 1: 'x' })],
  ])(
    'answers as a fault a prop of an object of %s, which JSON writes otherwise, rather than copy it',
    async (_what, payload) => {
      const child = program('test/child', (_, $) => $.h('p', null, 'child'));
      const parent = program('test/parent', (_, $) => $.h(componentRef('test/child'), { payload }));
      const { alice, engine } = await open({ programs: [...programs, child, parent] });

      const fault = await rejection(
        engine.render(alice, { build: BUILD, component: 'test/parent', props: {} }),
      );

      expect(fault).toBeInstanceOf(TypeError);
      expect((fault as Error).message).toContain('is not JSON');
    },
  );

  it('answers as a fault a state a component starts of an array of a hole, rather than send `null` in its place', async () => {
    const holed = program('test/holed', (_, $) => {
      return $.client({
        props: {},
        slots: {},
        states: { items: Object.assign([] as string[], { 1: 'x' }) },
      });
    });
    const { alice, engine } = await open({ programs: [...programs, holed] });

    const fault = await rejection(
      engine.render(alice, { build: BUILD, component: 'test/holed', props: {} }),
    );

    expect(fault).toBeInstanceOf(TypeError);
    expect((fault as Error).message).toContain('starts from a value that is not JSON');
  });

  it('normalizes accepted root props to the same JSON snapshot from RPC and HTTP', async () => {
    const items: Json[] = [];
    items.length = 2;
    items[1] = { value: -0 };
    const request = {
      build: BUILD,
      component: 'test/root-props',
      props: { nested: { items, omitted: undefined }, zero: -0 },
    };
    const httpBody: unknown = await new Request('https://authority.example/render', {
      body: JSON.stringify(request),
      method: 'POST',
    }).json();

    const rpc = rootOf(request);
    const http = rootOf(httpBody);

    expect(digest(rpc)).toBe(digest(http));
    expect(rpc).toStrictEqual(http);
    expect(rpc.props).toStrictEqual({ nested: { items: [null, { value: 0 }] }, zero: 0 });
    expect(Object.hasOwn(items, 0)).toBe(false);
  });

  it('copies accepted root props before a caller can change the request snapshot', () => {
    const props = { nested: { items: ['first'], title: 'before' } };
    const read = rootOf({ build: BUILD, component: 'test/root-props', props });

    props.nested.items[0] = 'after';
    props.nested.title = 'after';

    expect(read.props).toStrictEqual({ nested: { items: ['first'], title: 'before' } });
    expect(Object.isFrozen(props)).toBe(false);
  });

  it('hands a root’s props to its code as JSON carries them, whichever host sent them', async () => {
    const sparse: Json[] = [1];
    sparse[2] = 3;
    const seen: Readonly<Record<string, Json>>[] = [];
    const echoed = program('test/root-props', (props, $) => {
      seen.push(props);
      const { items, zero } = props as { readonly items: readonly Json[]; readonly zero: number };
      return $.h('p', null, `${String(1 in items)}:${String(Object.is(zero, -0))}`);
    });
    const { alice, engine } = await open({ programs: [...programs, echoed] });
    const request = {
      build: BUILD,
      component: 'test/root-props',
      props: { items: sparse, zero: -0 },
    };

    const rendered = await engine.render(alice, request);
    const httpBody: unknown = await new Request('https://authority.example/render', {
      body: JSON.stringify(request),
      method: 'POST',
    }).json();
    const http = await engine.render(alice, httpBody);

    // As HTTP's JSON sends them, whatever a Durable Object's RPC carried: the hole a `null`, `-0` a `0`.
    expect(textOf(rendered.tree)).toBe('true:false');
    expect(http.tree).toStrictEqual(rendered.tree);
    expect(http.frame.rootKey).toBe(rendered.frame.rootKey);
    expect(http.frame.digest).toBe(rendered.frame.digest);
    expect(seen).toStrictEqual([{ items: [1, null, 3], zero: 0 }]);

    const [props] = seen;

    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props?.['items'])).toBe(true);
  });

  it('refuses a root of props of an array of holes longer than a request’s body could write it, unwalked', async () => {
    const { alice, engine } = await open();
    const long: Json[] = [];
    long.length = 524_289;

    await expect(
      engine.render(alice, { build: BUILD, component: 'components/project', props: { long } }),
    ).rejects.toMatchObject({ code: 'INVALID_ROOT', status: 400 });
  });

  it('renders the JSON an element’s prop holds as JSON carries it, whichever host answers', async () => {
    const sparse: Json[] = [1];
    sparse[2] = 3;
    const shaped = program('test/props', (_, $) => {
      return $.h(moduleRef('next/link', 'default'), {
        data: { gone: undefined, items: sparse, zero: -0 },
        href: '/',
      });
    });
    const { alice, engine } = await open({ programs: [...programs, shaped] });

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/props',
      props: {},
    });
    const [link] = (rendered.tree as unknown as { readonly children: readonly unknown[] }).children;

    expect(link).toMatchObject({ kind: 'module', module: 'next/link' });
    expect((link as { readonly props: unknown }).props).toStrictEqual({
      data: { items: [1, null, 3], zero: 0 },
      href: '/',
    });
  });

  it('renders every component of a page at one revision, though a write is sent while it renders', async () => {
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    const slow = program('test/slow', async (_, $) => {
      entered.resolve(undefined);
      await gate.promise;
      const first = await db.todos.get('t1');
      return $.h('p', null, first?.title ?? '');
    });
    const { alice, engine } = await open({ programs: [...programs, slow] });
    const binding = editorBinding(await project(engine, alice));

    const rendering = engine.render(alice, { build: BUILD, component: 'test/slow', props: {} });
    await entered.promise;
    const writing = write(engine, alice, { binding, updaterId: SET_TITLE, value: '後から' });
    gate.resolve(undefined);
    const [rendered, receipt] = await Promise.all([rendering, writing]);

    // The write waits for the render, which reads what was there when it began, at its revision.
    expect(rendered.frame.revision).toBe(0);
    expect(textOf(rendered.tree)).toBe('一覧を作る');
    expect(receipt.committedRevision).toBe(1);
  });

  it('answers as a fault a page of more components than a render renders, or rendered too deep', async () => {
    const wide = program('test/wide', (_, $) => {
      return $.h(
        'ul',
        null,
        Array.from({ length: 2001 }, (_item, index) =>
          $.h(componentRef('components/counter'), { id: 'main', key: index }),
        ),
      );
    });
    const deep = program('test/deep', (props, $) =>
      $.h(componentRef('test/deep'), { depth: Number(props['depth'] ?? 0) + 1 }),
    );
    const { alice, engine } = await open({ programs: [...programs, wide, deep] });

    await expect(
      engine.render(alice, { build: BUILD, component: 'test/wide', props: {} }),
    ).rejects.toThrow('more than 2000 components');
    await expect(
      engine.render(alice, { build: BUILD, component: 'test/deep', props: {} }),
    ).rejects.toThrow('more than 64 deep');
  });
});

describe('the memo', () => {
  it('renders nothing again for a page nothing it read has changed of', async () => {
    const { alice, engine } = await open();
    await project(engine, alice);
    const before = await engine.stats();

    const again = await project(engine, alice);
    const after = await engine.stats();

    expect(after.evaluations).toBe(before.evaluations);
    expect(after.memoHits).toBe(before.memoHits + 1);
    expect(again.frame.digest).toBe((await project(engine, alice)).frame.digest);
  });

  it('keeps every rendering through a commit to a record no component of the page read', async () => {
    const { alice, engine } = await open();
    const first = await project(engine, alice);
    const counter = await engine.render(alice, {
      build: BUILD,
      component: 'components/counter',
      props: { id: 'main' },
    });
    const before = await engine.stats();

    await write(engine, alice, {
      binding: bindingOf(counter, 'components/counter', 'count'),
      updaterId: INCREMENT,
    });
    const after = await project(engine, alice);

    expect((await engine.stats()).evaluations).toBe(before.evaluations);
    expect(after.frame.digest).toBe(first.frame.digest);
    expect(after.frame.revision).toBe(1);
  });

  it('keeps what a component it renders from the memo read, as what the page depends on', async () => {
    const parent = program('test/parent', async (_, $) => {
      const other = await db.counters.get('other');
      return $.h(
        'div',
        null,
        other?.count ?? 0,
        $.h(componentRef('components/counter'), { id: 'main' }),
      );
    });
    const { alice, commits, engine } = await open({ programs: [...programs, parent] });
    const root = { build: BUILD, component: 'test/parent', props: {} };
    const count = async (id: string): Promise<void> => {
      const counter = await engine.render(alice, {
        build: BUILD,
        component: 'components/counter',
        props: { id },
      });
      await write(engine, alice, {
        binding: bindingOf(counter, 'components/counter', 'count'),
        updaterId: INCREMENT,
      });
    };
    await engine.render(alice, root);

    // The parent alone read `other`: it is rendered again, and the counter it renders is not.
    await count('other');
    const again = await engine.render(alice, root);
    const watched = await engine.watch(alice, again.frame.subscription);
    await count('main');

    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    expect((await engine.render(alice, root)).frame.fields['counters:main:count']).toBe(1);
  });

  it('renders again, after a while, a component no commit changed what it read of', async () => {
    let now = 1_000_000;
    let reads = 0;
    const outside = program('test/outside', (_props, $) => {
      // What no commit says the change of: a clock, another service.
      reads += 1;
      return $.h('p', null, String(reads));
    });
    const { alice, engine } = await open({
      clock: () => now,
      programs: [...programs, outside],
    });
    const root = { build: BUILD, component: 'test/outside', props: {} };

    const first = textOf((await engine.render(alice, root)).tree);
    const kept = textOf((await engine.render(alice, root)).tree);
    now += 30_000;
    const later = textOf((await engine.render(alice, root)).tree);

    expect([first, kept, later]).toStrictEqual(['1', '1', '2']);
  });

  it('keeps one user’s renderings apart from another’s', async () => {
    const { alice, bob, engine } = await open();
    await project(engine, alice);
    const before = await engine.stats();

    const rendered = await project(engine, bob);

    expect((await engine.stats()).evaluations).toBeGreaterThan(before.evaluations);
    expect(clientsIn(rendered.tree, 'components/member-editor')).toHaveLength(0);
  });
});

describe('what a render depends on', () => {
  it('renders again for a commit that changed a record it read, and its query’s answer', async () => {
    const { alice, commits, engine } = await open();
    const first = await project(engine, alice);
    const evaluations = (await engine.stats()).evaluations;

    await operate(engine, alice, {
      args: [json('p1'), form({ title: 'あとで' })],
      name: 'createTodo',
    });
    const watched = await engine.watch(alice, first.frame.subscription);
    const evaluated = (await engine.stats()).evaluations - evaluations;

    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    expect(watched.digest).not.toBe(watched.issued);
    // The page, its list and the new row; the other rows, the details and the commands are kept.
    expect(evaluated).toBe(3);
  });

  it('hears of a record made where a query named none', async () => {
    const { bob, commits, engine } = await open();
    const empty = await project(engine, bob, { filter: 'all', projectId: 'p3' });
    const watched = await engine.watch(bob, empty.frame.subscription);

    await operate(engine, bob, {
      args: [json('p3'), form({ title: '最初の一件' })],
      name: 'createTodo',
    });

    expect(textOf(empty.tree)).toContain('該当する Todo はありません。');
    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    expect(listed(await project(engine, bob, { filter: 'all', projectId: 'p3' }))).toHaveLength(1);
  });

  it('hears of the first record an empty query names', async () => {
    const { alice, commits, engine } = await open();
    const done = await project(engine, alice, { filter: 'done', projectId: 'p1' });
    const watched = await engine.watch(alice, done.frame.subscription);

    expect(textOf(done.tree)).toContain('該当する Todo はありません。');

    await write(engine, alice, {
      binding: editorBinding(await project(engine, alice), 'completed'),
      updaterId: SET_COMPLETED,
      value: true,
    });

    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    expect(listed(await project(engine, alice, { filter: 'done', projectId: 'p1' }))).toStrictEqual(
      ['t1'],
    );
  });

  it('orders the list again for a title that moves a todo in it', async () => {
    const { alice, commits, engine } = await open();
    const first = await project(engine, alice, {
      filter: 'all',
      projectId: 'p1',
      selectedId: 't2',
    });
    const watched = await engine.watch(alice, first.frame.subscription);

    await write(engine, alice, {
      binding: editorBinding(first),
      updaterId: SET_TITLE,
      value: 'あ',
    });
    const after = await project(engine, alice, {
      filter: 'all',
      projectId: 'p1',
      selectedId: 't2',
    });

    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    expect(listed(first)).toStrictEqual(['t1', 't2']);
    expect(listed(after)).toStrictEqual(['t2', 't1']);
  });

  it('does not hear of a commit to another project’s todo, nor another session’s sign-out', async () => {
    const { alice, bob, commits, engine } = await open();
    const p1 = await project(engine, alice);
    const p2 = await project(engine, alice, { filter: 'all', projectId: 'p2', selectedId: 't3' });
    const watched = await engine.watch(alice, p1.frame.subscription);

    await write(engine, alice, { binding: editorBinding(p2), updaterId: SET_TITLE, value: '別' });
    await engine.logout(bob);

    expect(commits.map((event) => watched.dependsOn(event))).toStrictEqual([false, false]);
  });

  it('hears of its own session’s sign-out', async () => {
    const { alice, commits, engine } = await open();
    const watched = await engine.watch(alice, (await project(engine, alice)).frame.subscription);

    await engine.logout(alice);

    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
    await expect(engine.watch(alice, '')).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a subscription of another session, or none of its own', async () => {
    const { alice, bob, engine } = await open();
    const { subscription } = (await project(engine, alice)).frame;

    await expect(engine.watch(bob, subscription)).rejects.toMatchObject({ status: 403 });
    await expect(engine.watch(alice, `${subscription}x`)).rejects.toMatchObject({ status: 403 });
    await expect(engine.watch(alice, subscription)).resolves.toMatchObject({ revision: 0 });
  });
});

describe('a write to a field', () => {
  it('writes the value a `set` is sent, and the next render shows it and the operation', async () => {
    const { alice, engine } = await open();
    const rendered = await project(engine, alice);

    const receipt = await write(engine, alice, {
      binding: editorBinding(rendered),
      operationId: 'op-title',
      updaterId: SET_TITLE,
      value: '一覧を直す',
    });
    const after = await project(engine, alice);

    expect(receipt).toStrictEqual({
      committedRevision: 1,
      deduplicated: false,
      operationId: 'op-title',
    });
    expect(after.frame.fields['todos:t1:title']).toBe('一覧を直す');
    expect(after.frame).toMatchObject({ operations: ['op-title'], revision: 1 });
  });

  it('runs a registered update on the current value with the values its call captured', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await project(engine, alice), 'useEstimate#0.estimate');

    await write(engine, alice, { binding, captures: { step: 1 }, updaterId: ADD_ESTIMATE });
    await write(engine, alice, { binding, captures: { step: 5 }, updaterId: ADD_ESTIMATE });

    expect((await project(engine, alice)).frame.fields['todos:t1:estimate']).toBe(8);
  });

  it('answers a resent operation with its first receipt, writing it once', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await project(engine, alice), 'useEstimate#0.estimate');
    const sent = { binding, captures: { step: 5 }, operationId: 'op-add', updaterId: ADD_ESTIMATE };

    const first = await write(engine, alice, sent);
    const again = await write(engine, alice, sent);

    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect((await project(engine, alice)).frame.fields['todos:t1:estimate']).toBe(7);
    await expect(write(engine, alice, { ...sent, captures: { step: 1 } })).rejects.toMatchObject({
      code: 'OPERATION_REUSED',
      status: 409,
    });
  });

  it('refuses a write to a todo moved to another project, under the binding of the old one', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await project(engine, alice));

    await operate(engine, alice, {
      args: [json('p1'), json('t1'), form({ targetProjectId: 'p2' })],
      name: 'moveTodo',
    });

    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '移動後' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });

    const moved = await project(engine, alice, {
      filter: 'all',
      projectId: 'p2',
      selectedId: 't1',
    });

    expect(moved.frame.fields['todos:t1:title']).toBe('一覧を作る');
  });

  it('never makes again a todo deleted under a binding of it', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await project(engine, alice));

    await operate(engine, alice, { args: [json('p1'), json('t1')], name: 'deleteTodo' });
    const error = await rejection(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '復活' }),
    );
    const after = await project(engine, alice);

    expect(error).toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
    expect(listed(after)).toStrictEqual(['t2']);
    expect(textOf(after.tree)).toContain('選択した Todo は削除または移動されました。');
  });

  it('refuses a member’s write once the owner takes his editing away, and renders the todo read-only for him', async () => {
    const { alice, bob, engine } = await open();
    const binding = editorBinding(await project(engine, bob));

    await write(engine, alice, {
      binding: bindingOf(await project(engine, alice), 'components/member-editor', 'canEdit'),
      updaterId: SET_CAN_EDIT,
      value: false,
    });
    const after = await project(engine, bob);

    await expect(
      write(engine, bob, { binding, updaterId: SET_TITLE, value: 'Bob の' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
    expect(clientsIn(after.tree, 'components/todo-editor')).toHaveLength(0);
    expect(clientsIn(after.tree, 'components/todo-readonly')).toHaveLength(1);
  });

  it('refuses a write a component along its path refuses the session', async () => {
    const leave = {
      leave: async (projectId: Json): Promise<void> => {
        await db.transaction(async () => {
          const user = await requireUser();
          await db.memberships.delete(`${projectId as string}-${user.id}`);
        });
      },
    };
    const { bob, engine } = await open({
      operations: { ...application.operations, 'test/leave': leave },
    });
    const binding = editorBinding(await project(engine, bob));

    await operate(engine, bob, { args: [json('p1')], name: 'leave', module: 'test/leave' });

    await expect(
      write(engine, bob, { binding, updaterId: SET_TITLE, value: 'Bob の' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await project(engine, bob)).status).toBe('forbidden');
  });

  it('refuses a write that would hold a `unique` group another record holds, and makes none', async () => {
    const setProject = 'u_set_project';
    const member = program(
      'test/member',
      (_, $) => {
        return $.client({
          props: {},
          slots: {},
          states: { projectId: db.memberships.ref('p1-bob').projectId },
        });
      },
      { updaters: { [setProject]: { keys: ['projectId'], kind: 'set' } }, writable: ['projectId'] },
    );
    const { alice, engine } = await open({ programs: [...programs, member] });
    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/member',
      props: {},
    });
    const binding = bindingOf(rendered, 'test/member', 'projectId');

    // p2-bob holds p2 and bob already.
    await expect(
      write(engine, alice, { binding, updaterId: setProject, value: 'p2' }),
    ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION', status: 409 });
    expect((await engine.stats()).commits).toBe(0);
    await expect(
      write(engine, alice, { binding, updaterId: setProject, value: 'p3' }),
    ).resolves.toMatchObject({ committedRevision: 1 });
  });

  it('answers a write to a record there is not as not found, and makes none', async () => {
    const ghost = program(
      'test/ghost',
      (_, $) => $.client({ props: {}, slots: {}, states: { title: db.todos.ref('ghost').title } }),
      { updaters: { [SET_TITLE]: { keys: ['title'], kind: 'set' } }, writable: ['title'] },
    );
    const { alice, engine } = await open({ programs: [...programs, ghost] });
    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/ghost',
      props: {},
    });

    await expect(
      write(engine, alice, {
        binding: bindingOf(rendered, 'test/ghost', 'title'),
        updaterId: SET_TITLE,
        value: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(rendered.frame.fields['todos:ghost:title']).toBe('');
    expect((await engine.stats()).commits).toBe(0);
  });

  it('refuses an update its state does not register, a `set` without its value and an `apply` with one', async () => {
    const { alice, engine } = await open();
    const rendered = await project(engine, alice);
    const title = editorBinding(rendered);
    const estimate = editorBinding(rendered, 'useEstimate#0.estimate');

    await expect(
      write(engine, alice, { binding: title, updaterId: ADD_ESTIMATE }),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_UPDATER',
      status: 400,
    });
    await expect(
      write(engine, alice, { binding: title, updaterId: SET_TITLE }),
    ).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    });
    await expect(
      write(engine, alice, { binding: estimate, updaterId: ADD_ESTIMATE, value: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('refuses a value the field cannot hold, and writes nothing', async () => {
    const { alice, engine } = await open();
    const rendered = await project(engine, alice);

    await expect(
      write(engine, alice, {
        binding: editorBinding(rendered),
        updaterId: SET_TITLE,
        value: 'x'.repeat(201),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE', status: 422 });
    await expect(
      write(engine, alice, {
        binding: editorBinding(rendered, 'completed'),
        updaterId: SET_COMPLETED,
        value: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE', status: 422 });
    await expect(
      write(engine, alice, {
        binding: editorBinding(rendered, 'useEstimate#0.estimate'),
        captures: { step: 'x' },
        updaterId: ADD_ESTIMATE,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE', status: 422 });
    expect((await engine.stats()).commits).toBe(0);
  });

  it('refuses a binding of another session, one tampered with, and any once the session ends', async () => {
    const { alice, bob, engine } = await open();
    const binding = editorBinding(await project(engine, alice));
    const sent = { binding, updaterId: SET_TITLE, value: 'x' };

    await expect(write(engine, bob, sent)).rejects.toMatchObject({ status: 403 });
    await expect(write(engine, alice, { ...sent, binding: `${binding}x` })).rejects.toMatchObject({
      status: 403,
    });

    await engine.logout(alice);

    await expect(write(engine, alice, sent)).rejects.toMatchObject({ status: 401 });
  });

  it('writes an equal value as an operation, and changes nothing that read the record', async () => {
    const { alice, commits, engine } = await open();
    const rendered = await project(engine, alice);
    const before = await engine.stats();

    const receipt = await write(engine, alice, {
      binding: editorBinding(rendered),
      updaterId: SET_TITLE,
      value: '一覧を作る',
    });

    expect(receipt.committedRevision).toBe(1);
    expect(commits.at(-1)).toMatchObject({ changed: [], rows: [] });
    expect((await engine.stats()).memoEvictions).toBe(before.memoEvictions);
  });
});

describe('a server operation', () => {
  it('commits what it wrote, and the next render shows it', async () => {
    const { alice, engine } = await open();

    const receipt = await operate(engine, alice, {
      args: [json('p1'), form({ title: 'あとで' })],
      name: 'createTodo',
      operationId: 'op-create',
    });
    const after = await project(engine, alice);

    expect(receipt).toStrictEqual({
      committedRevision: 1,
      deduplicated: false,
      operationId: 'op-create',
      result: null,
    });
    expect(textOf(after.tree)).toContain('未完了 3 件');
    expect(listed(after)).toHaveLength(3);
  });

  it('runs a resent operation once, answering its first receipt, and refuses its id for another', async () => {
    const { alice, engine } = await open();
    const args = [json('p1'), form({ title: 'あとで' })];

    const first = await operate(engine, alice, { args, name: 'createTodo', operationId: 'op-1' });
    const again = await operate(engine, alice, { args, name: 'createTodo', operationId: 'op-1' });

    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect(listed(await project(engine, alice))).toHaveLength(3);
    await expect(
      operate(engine, alice, {
        args: [json('p1'), form({ title: '別' })],
        name: 'createTodo',
        operationId: 'op-1',
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_REUSED', status: 409 });
  });

  it('answers a refusal with its status, and a resend with the same refusal', async () => {
    const { alice, engine } = await open();

    const first = await rejection(
      operate(engine, alice, { args: [json('p3')], name: 'completeProject', operationId: 'op-p3' }),
    );
    const again = await rejection(
      operate(engine, alice, { args: [json('p3')], name: 'completeProject', operationId: 'op-p3' }),
    );

    expect(first).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(again).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await engine.stats()).deduplicated).toBe(1);
  });

  it('rejects an operation its own checks refuse, with their message, and writes nothing', async () => {
    const { alice, engine } = await open();
    const args = [json('p1'), form({ title: '  ' })];

    const first = await rejection(
      operate(engine, alice, { args, name: 'createTodo', operationId: 'op-empty' }),
    );
    const again = await rejection(
      operate(engine, alice, { args, name: 'createTodo', operationId: 'op-empty' }),
    );

    expect(first).toMatchObject({
      code: 'OPERATION_REJECTED',
      message: 'title must contain 1..200 characters',
      status: 422,
    });
    expect(again).toStrictEqual(first);
    expect((await engine.stats()).commits).toBe(0);
  });

  it('answers an operation that threw after its transaction committed as a failure that committed, again on a resend', async () => {
    const after = {
      retitle: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update('t1', { title: '書いた' });
        });
        throw new Error('after the commit');
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/after': after },
    });
    const call = { args: [], module: 'test/after', name: 'retitle', operationId: 'op-after' };

    const first = await rejection(operate(engine, alice, call));
    const again = await rejection(operate(engine, alice, call));

    expect(first).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    expect((first as Error).message).toContain('after the commit');
    expect(again).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    expect((await project(engine, alice)).frame.fields['todos:t1:title']).toBe('書いた');
  });

  it('writes nothing of a transaction whose code caught a fault it raised, and answers the fault', async () => {
    const caught = {
      retitle: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update('t1', { title: '書いた' });
          try {
            await db.transaction(async () => {
              await db.todos.update('t2', { title: 'もう一つ' });
            });
          } catch {
            // Caught: a second transaction is the call's fault all the same.
          }
        });
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/caught': caught },
    });
    const call = { args: [], module: 'test/caught', name: 'retitle', operationId: 'op-caught' };

    const fault = await rejection(operate(engine, alice, call));

    expect((fault as Error).message).toContain('runs one transaction');
    expect((await engine.stats()).commits).toBe(0);
    expect((await project(engine, alice)).frame.fields['todos:t1:title']).toBe('一覧を作る');
  });

  it('answers a resend of an operation that committed and never settled as of an unknown outcome, not as a result', async () => {
    const after = {
      retitle: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update('t1', { title: '書いた' });
        });
        await new Promise(() => {
          // Never settles: the call's time runs out after the commit.
        });
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/after': after },
      timeoutMs: 50,
    });
    const call = { args: [], module: 'test/after', name: 'retitle', operationId: 'op-hung' };

    await rejection(operate(engine, alice, call));
    const again = await rejection(operate(engine, alice, call));

    expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
  });

  it('answers what an operation returned as JSON carries it, the same on a resend', async () => {
    const shaped = {
      answer: (): Readonly<Record<string, unknown>> => ({ kept: 1, left: undefined }),
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/shaped': shaped },
    });
    const call = { args: [], module: 'test/shaped', name: 'answer', operationId: 'op-shaped' };

    const first = await operate(engine, alice, call);
    const again = await operate(engine, alice, call);

    expect(first.result).toStrictEqual({ kept: 1 });
    expect(again.result).toStrictEqual(first.result);
  });

  it('hands an operation what JSON carries of its arguments, however they crossed to it', async () => {
    const seen: unknown[] = [];
    const echo = {
      take: (...args: readonly unknown[]): void => {
        seen.push(...args);
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/echo': echo },
    });
    // As a structured clone carries it across a Durable Object's RPC: with its hole.
    // eslint-disable-next-line no-sparse-arrays -- the hole is what crosses
    const sparse = [1, , 3] as unknown as Json;

    await operate(engine, alice, { args: [json(sparse)], module: 'test/echo', name: 'take' });

    expect(seen).toStrictEqual([[1, null, 3]]);
  });

  it('renders the children an element’s props hold, as a spread gives them, and hands them on to a reactive component', async () => {
    const spread = program('test/spread', (_props, $) =>
      $.h('section', { children: $.h('span', null, 'kept') }),
    );
    const frame = program('test/frame', (props, $) =>
      $.h('div', null, '[', props['children'], ']'),
    );
    const handed = program('test/handed', (_props, $) => {
      return $.h(
        $.fragment,
        null,
        $.h(componentRef('test/frame'), { children: 'given' }),
        $.h(componentRef('test/frame'), null, $.h('b', null, 'one'), 'two'),
      );
    });
    const { alice, engine } = await open({ programs: [...programs, spread, frame, handed] });

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/spread',
      props: {},
    });
    const passed = await engine.render(alice, {
      build: BUILD,
      component: 'test/handed',
      props: {},
    });

    expect(textOf(rendered.tree)).toBe('kept');
    // As React's `createElement` hands them on: the one child, or the list of them.
    expect(textOf(passed.tree)).toBe('[given][onetwo]');
  });

  it('takes JSON shaped as a server operation for JSON, which it refuses, and never for the operation', async () => {
    const shaped = program('test/shaped', (_props, $) => {
      return $.h('form', {
        action: { bound: [], kind: 'action', module: 'actions/todos', name: 'deleteTodo' },
      });
    });
    const { alice, engine } = await open({ programs: [...programs, shaped] });

    const refused = await rejection(
      engine.render(alice, { build: BUILD, component: 'test/shaped', props: {} }),
    );

    expect(refused).toMatchObject({
      message: expect.stringContaining('reads as something rendered') as unknown,
    });
  });

  it('reads a write’s value and captures as JSON carries them, `-0` as `0`, however they crossed', () => {
    const read = fieldOperationOf({
      binding: 'b',
      captures: { step: -0 },
      operationId: 'op',
      updaterId: 'u',
      value: -0,
    });

    expect(Object.is(read.value, 0)).toBe(true);
    expect(Object.is(read.captures?.['step'], 0)).toBe(true);
  });

  it('completes every todo of a project in one commit', async () => {
    const { alice, commits, engine } = await open();

    const receipt = await operate(engine, alice, { args: [json('p1')], name: 'completeProject' });

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      changed: ['todos:t1', 'todos:t2'],
      revision: receipt.committedRevision,
    });
    expect(textOf((await project(engine, alice)).tree)).toContain('未完了 0 件 / 完了 2 件');
  });

  it('moves a todo only to a project the session may edit too, and moves nothing otherwise', async () => {
    const { alice, bob, engine } = await open();

    await expect(
      operate(engine, alice, {
        args: [json('p1'), json('t1'), form({ targetProjectId: 'p3' })],
        name: 'moveTodo',
      }),
    ).rejects.toMatchObject({ status: 403 });

    await operate(engine, bob, {
      args: [json('p1'), json('t1'), form({ targetProjectId: 'p3' })],
      name: 'moveTodo',
    });

    expect(listed(await project(engine, alice))).toStrictEqual(['t2']);
    expect(listed(await project(engine, bob, { filter: 'all', projectId: 'p3' }))).toStrictEqual([
      't1',
    ]);
  });

  it('refuses an operation it does not run, of another build, or sent what it does not read', async () => {
    const { alice, engine } = await open();
    const call = {
      args: [],
      build: BUILD,
      module: 'actions/todos',
      name: 'completeProject',
      operationId: 'op',
    };

    await expect(engine.operate(alice, { ...call, name: 'missing' })).rejects.toMatchObject({
      code: 'UNKNOWN_OPERATION',
      status: 404,
    });
    await expect(engine.operate(alice, { ...call, module: 'actions/other' })).rejects.toMatchObject(
      {
        status: 404,
      },
    );
    await expect(engine.operate(alice, { ...call, build: 'b_other' })).rejects.toMatchObject({
      code: 'BUILD_MISMATCH',
    });
    await expect(
      engine.operate(alice, { ...call, args: [{ form: [['a', 1]] }] }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      engine.operate(alice, { ...call, args: [{ form: [['a', 'x'.repeat(16_385)]] }] }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
  });

  it('answers what an operation returns, and no revision where it committed nothing', async () => {
    const reads = {
      titles: async (projectId: Json): Promise<Json> => {
        const found = await db.todos.findMany({
          orderBy: [{ id: 'desc' }],
          select: { title: true },
          where: { projectId: projectId as string },
        });
        return found.map((todo) => todo.title);
      },
    };
    const { alice, engine } = await open({ operations: { 'test/reads': reads } });

    const receipt = await operate(engine, alice, {
      args: [json('p1')],
      name: 'titles',
      module: 'test/reads',
    });

    expect(receipt).toMatchObject({
      committedRevision: null,
      result: ['同期を確認する', '一覧を作る'],
    });
  });

  it('refuses an operation without a session, and keeps nothing of it', async () => {
    const { alice, engine } = await open();
    await engine.logout(alice);

    await expect(
      operate(engine, alice, { args: [json('p1')], name: 'completeProject' }),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect((await engine.stats()).operations).toBe(0);
  });
});

/** A file in a directory of the test's own, removed when it finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-engine-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

describe('the authority’s database', () => {
  it('keeps the records, the revision and the sessions across a restart', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    const { sessionId } = await first.login('alice');
    await first.operate(sessionId, {
      args: [json('p1'), form({ title: 'あとで' })],
      build: BUILD,
      module: 'actions/todos',
      name: 'createTodo',
      operationId: 'op',
    });
    await first.close();

    const second = new Engine({ ...application, filename });
    onTestFinished(async () => {
      await second.close();
    });

    expect(second.revision()).toBe(1);
    expect(listed(await project(second, sessionId))).toHaveLength(3);
  });

  it('keeps a seeded record deleted, however often the database is opened again', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    const { sessionId } = await first.login('alice');
    await operate(first, sessionId, { args: [json('p1'), json('t1')], name: 'deleteTodo' });
    await first.close();

    const second = new Engine({ ...application, filename });
    onTestFinished(async () => {
      await second.close();
    });

    expect(listed(await project(second, sessionId))).toStrictEqual(['t2']);
    expect(second.revision()).toBe(1);
  });

  it('gives a database of schema 5 its ended keys’ table, empty, and leaves it schema 5', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    const { sessionId } = await first.login('alice');
    await first.close();
    const sqlite = new DatabaseSync(filename);
    // As an authority before asserted sessions left a database: no table of ended keys.
    sqlite.exec('DROP TABLE ended');
    sqlite.close();

    const second = new Engine({ ...application, filename });
    onTestFinished(async () => {
      await second.close();
    });
    const kept = new DatabaseSync(filename, { readOnly: true });
    onTestFinished(() => {
      kept.close();
    });

    // Schema 5 still, which an authority before this one opens as it left it.
    expect(kept.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.['value']).toBe('5');
    expect(kept.prepare('SELECT COUNT(*) AS kept FROM ended').get()?.['kept']).toBe(0);
    // The rest as it was: Alice's session, signed in before.
    await expect(second.logout(sessionId)).resolves.toBeUndefined();
  });

  it('brings a database of schema 4 up to this one, its artifacts — of no deployment of the site — let go of, and nothing else', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    const { sessionId } = await first.login('alice');
    await first.close();
    const sqlite = new DatabaseSync(filename);
    // Schema 4's artifacts, as an earlier authority kept them: of no deployment.
    sqlite.exec('DROP TABLE artifacts');
    sqlite.exec(
      'CREATE TABLE artifacts (view TEXT NOT NULL, generation INTEGER NOT NULL, profile TEXT NOT NULL, etag TEXT NOT NULL, headers TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (view, generation, profile))',
    );
    sqlite.exec("INSERT INTO artifacts VALUES ('v', 1, 'document', 'e', '[]', 'kept', 0)");
    sqlite.exec("UPDATE meta SET value = '4' WHERE key = 'schema'");
    sqlite.close();

    const second = new Engine({ ...application, filename });
    onTestFinished(async () => {
      await second.close();
    });
    const kept = new DatabaseSync(filename, { readOnly: true });
    onTestFinished(() => {
      kept.close();
    });

    expect(kept.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.['value']).toBe('5');
    expect(kept.prepare('SELECT COUNT(*) AS kept FROM artifacts').get()?.['kept']).toBe(0);
    expect(
      kept
        .prepare('PRAGMA table_info(artifacts)')
        .all()
        .map((column) => column['name']),
    ).toContain('deployment');
    // The rest as it was: Alice's session, signed in before.
    await expect(second.logout(sessionId)).resolves.toBeUndefined();
  });

  it('brings a database of schema 3, as the authority before it left one, up to this one: every record, session, operation and change kept, and a seed deleted under it still deleted', async () => {
    const filename = await databaseFile();
    const sqlite = new DatabaseSync(filename);
    for (const statement of SCHEMA_3_DATABASE) {
      sqlite.exec(statement);
    }
    // As if the declaration it was made with had no counter `other`: one the declaration gained
    // since, which no commit wrote.
    sqlite.exec("DELETE FROM records WHERE tbl = 'counters' AND id = 'other'");
    sqlite.close();

    const engine = new Engine({ ...application, clock: () => SCHEMA_3_OPENED + 10_000, filename });
    onTestFinished(async () => {
      await engine.close();
    });
    const kept = new DatabaseSync(filename, { readOnly: true });
    onTestFinished(() => {
      kept.close();
    });

    expect(kept.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.['value']).toBe('5');

    // Alice's session, signed in before, sees p1 as it left it — by title: the to-do it made, t1
    // retitled, and the seed t2 deleted and not made again.
    const rendered = await project(engine, SCHEMA_3_SESSION);

    expect(listed(rendered)).toStrictEqual([SCHEMA_3_CREATED, 't1']);
    expect(rendered.frame.fields['todos:t1:title']).toBe('一覧を直す');
    expect(rendered.frame).toMatchObject({ operations: ['op-title'], revision: 4 });
    // Its three changes, and the counter the declaration gained since — the one seed made.
    await expect(engine.changes()).resolves.toMatchObject([
      { changed: [`todos:${SCHEMA_3_CREATED}`], revision: 1 },
      { changed: ['todos:t2'], revision: 2 },
      { changed: ['todos:t1'], revision: 3 },
      { changed: ['counters:other'], kind: 'state', revision: 4 },
    ]);
    // An operation it ran, sent again, is answered with its first receipt, and not run again.
    await expect(
      operate(engine, SCHEMA_3_SESSION, {
        args: [json('p1'), form({ title: 'あとで' })],
        name: 'createTodo',
        operationId: 'op-create',
      }),
    ).resolves.toStrictEqual({
      committedRevision: 1,
      deduplicated: true,
      operationId: 'op-create',
      result: null,
    });
    expect(engine.revision()).toBe(4);
  });

  it('refuses a database of another schema, and leaves it as it was', async () => {
    const filename = await databaseFile();
    const sqlite = new DatabaseSync(filename);
    sqlite.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sqlite.exec("INSERT INTO meta VALUES ('schema', '2'), ('revision', '7')");
    sqlite.close();

    expect(() => new Engine({ ...application, filename })).toThrow('schema 2');

    const kept = new DatabaseSync(filename);
    onTestFinished(() => {
      kept.close();
    });

    expect(kept.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.['value']).toBe(
      '7',
    );
  });

  it('logs a seed the declaration gains, so that a page rendered before hears of it', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    await first.close();
    const grown = database(
      { notes: table({ body: text() }) },
      { seed: { notes: { n1: { body: 'first' } } } },
    );

    const second = new Engine({ ...application, database: grown, filename, programs: [] });
    onTestFinished(async () => {
      await second.close();
    });

    await expect(second.changes()).resolves.toMatchObject([
      { changed: ['notes:n1'], kind: 'state', revision: 1 },
    ]);
  });

  it('refuses a seed that would hold what a record the database keeps holds of a `unique` group', async () => {
    const filename = await databaseFile();
    const first = new Engine({ ...application, filename });
    const { sessionId } = await first.login('alice');
    const join = {
      join: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.memberships.insert({ canEdit: false, projectId: 'p3', userId: 'carol' });
        });
      },
    };
    await first.close();
    const joining = new Engine({ ...application, filename, operations: { 'test/join': join } });
    await joining.operate(sessionId, {
      args: [],
      build: BUILD,
      module: 'test/join',
      name: 'join',
      operationId: 'op',
    });
    await joining.close();
    const seeded = database(
      {
        memberships: table(
          { canEdit: text(), projectId: text(), userId: text() },
          { unique: [['projectId', 'userId']] },
        ),
      },
      { seed: { memberships: { 'p3-carol': { projectId: 'p3', userId: 'carol' } } } },
    );

    expect(() => new Engine({ buildId: BUILD, database: seeded, filename, programs: [] })).toThrow(
      'hold the same projectId, userId',
    );
  });

  it('refuses a database that holds a `unique` group twice, though the declaration seeds nothing', async () => {
    const filename = await databaseFile();
    const fields = { canEdit: text(), projectId: text(), userId: text() };
    const loose = database({ memberships: table(fields) });
    const twice = {
      join: async (): Promise<void> => {
        await loose.transaction(async () => {
          await loose.memberships.insert({ projectId: 'p3', userId: 'carol' });
          await loose.memberships.insert({ projectId: 'p3', userId: 'carol' });
        });
      },
    };
    const first = new Engine({
      buildId: BUILD,
      database: loose,
      filename,
      operations: { 'test/twice': twice },
      programs: [],
    });
    const { sessionId } = await first.login('alice');
    await first.operate(sessionId, {
      args: [],
      build: BUILD,
      module: 'test/twice',
      name: 'join',
      operationId: 'op',
    });
    await first.close();
    const strict = database({ memberships: table(fields, { unique: [['projectId', 'userId']] }) });

    expect(() => new Engine({ buildId: BUILD, database: strict, filename, programs: [] })).toThrow(
      'hold the same projectId, userId',
    );
  });
});

describe('sessions, public views and the change log', () => {
  it('renders nothing for a session that ended, and writes nothing for it', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await project(engine, alice));

    await engine.logout(alice);

    expect((await project(engine, alice)).status).toBe('unauthenticated');
    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: 'x' }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it('shows a record’s public fields to anyone, from its cache until the record changes', async () => {
    const { alice, engine } = await open();
    const counter = await engine.render(alice, {
      build: BUILD,
      component: 'components/counter',
      props: { id: 'main' },
    });
    const binding = bindingOf(counter, 'components/counter', 'count');

    const first = await engine.publicSnapshot('counters', 'main');
    const cached = await engine.publicSnapshot('counters', 'main');
    await write(engine, alice, { binding, captures: { by: 2 }, updaterId: INCREMENT });
    await write(engine, alice, { binding, updaterId: SET_COUNT, value: 7 });
    const changed = await engine.publicSnapshot('counters', 'main');

    expect([first.cache, cached.cache, changed.cache]).toStrictEqual(['MISS', 'HIT', 'MISS']);
    expect(changed.values).toStrictEqual({ count: 7 });
    await expect(engine.publicSnapshot('todos', 't1')).rejects.toMatchObject({ status: 404 });
  });

  it('says which of a change’s records a page without a session may show', async () => {
    const { alice, engine } = await open();
    const counter = await engine.render(alice, {
      build: BUILD,
      component: 'components/counter',
      props: { id: 'main' },
    });

    await write(engine, alice, {
      binding: bindingOf(counter, 'components/counter', 'count'),
      updaterId: INCREMENT,
    });
    await operate(engine, alice, { args: [json('p1')], name: 'completeProject' });

    await expect(engine.changes()).resolves.toMatchObject([
      { changed: ['counters:main'], published: ['counters:main'] },
      { changed: ['todos:t1', 'todos:t2'], published: [] },
    ]);
  });

  it('keeps a delivery cursor monotonic, and refuses one past the last revision', async () => {
    const { alice, engine } = await open();
    await operate(engine, alice, { args: [json('p1')], name: 'completeProject' });

    await engine.acknowledge('site', 1);
    await engine.acknowledge('site', 0);

    await expect(engine.delivery('site')).resolves.toBe(1);
    await expect(engine.acknowledge('site', 2)).rejects.toMatchObject({ status: 400 });
  });
});
