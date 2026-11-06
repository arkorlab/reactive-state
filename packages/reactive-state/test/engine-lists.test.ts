import { describe, expect, it, type MockInstance, onTestFinished, vi } from 'vitest';

import {
  AuthorityError,
  type CommitEvent,
  Engine,
  type EngineOptions,
} from '../src/authority/index.ts';
import {
  type ComponentProgram,
  componentRef,
  type FieldReceipt,
  type Json,
  type OperationArgument,
  PROTOCOL_VERSION,
  type RenderedClient,
  type RenderedSite,
  type RenderResult,
  type RenderScope,
  type SiteDescriptor,
  type Value,
  VIEW_LIMITS,
} from '../src/program.ts';
import { db } from './support/app/db.ts';
import { clientOf, clientsIn, textOf } from './support/frames.ts';
import { application, BUILD, SET_TITLE } from './support/program.ts';
import { FILTER, PANELS, type TodoPanel } from './support/workspace-v3.ts';

/**
 * The authority, rendering a list site — the project fixture's third version: the workspace's
 * detail for each panel the page holds open, keyed by the panel, rendered for the panels a view
 * sends in one request, each item's components the memo's where it holds them; and the bindings
 * issued inside an item, held to the to-do it was issued for.
 */

interface Opened {
  readonly engine: Engine;
  /** Alice's session: she owns p1 and p2. */
  readonly alice: string;
  /** Bob's session: a member of p1 and p2 who may edit them. */
  readonly bob: string;
}

async function open(options: Partial<EngineOptions> = {}): Promise<Opened> {
  const engine = new Engine({ ...application, ...options });
  onTestFinished(async () => {
    await engine.close();
  });
  const alice = await engine.login('alice');
  const bob = await engine.login('bob');
  return { alice: alice.sessionId, bob: bob.sessionId, engine };
}

/** The page of no panel open, and of `t1`'s. */
const EMPTY = { filter: 'all', projectId: 'p1' } as const;
const PAGE = { ...EMPTY, selectedId: 't1' } as const;

async function page(
  engine: Engine,
  session: string,
  props: Readonly<Record<string, Json>> = PAGE,
): Promise<RenderResult> {
  return engine.render(session, { build: BUILD, component: 'components/panels-project', props });
}

function workspaceOf(rendered: RenderResult): RenderedClient {
  return clientOf(rendered.tree, 'components/panels-workspace');
}

function instanceOf(rendered: RenderResult): string {
  const { instance } = workspaceOf(rendered).part;
  if (instance === undefined) {
    throw new Error('The workspace has no instance id.');
  }
  return instance;
}

/** The workspace's list of details, as a rendering shows it. */
function listOf(rendered: RenderResult): RenderedSite | undefined {
  return workspaceOf(rendered).part.sites?.['d1'];
}

/** The panels of `pairs`: each its panel's id, and the to-do it shows. */
function panels(...pairs: readonly (readonly [string, string])[]): readonly TodoPanel[] {
  return pairs.map(([panelId, todoId]) => ({ panelId, todoId }));
}

/** What a view shows of the workspace: its filter, `all` unless told, and the panels open, if any. */
interface Shown {
  readonly filter?: string;
  readonly opened?: readonly TodoPanel[];
}

/** The page `rendered` rendered again for the view of the workspace `shown` names. */
async function viewed(
  engine: Engine,
  session: string,
  rendered: RenderResult,
  shown: Shown,
): Promise<RenderResult> {
  const { filter = 'all', opened } = shown;
  const sites = {
    d0: { [FILTER]: filter },
    ...(opened !== undefined && { d1: { [PANELS]: opened as unknown as Json } }),
  };
  return engine.view(session, {
    subscription: rendered.frame.subscription,
    view: { [instanceOf(rendered)]: sites },
  });
}

/** The binding each editor in a rendering writes its title with, in the order they stand. */
function editorBindings(rendered: RenderResult): readonly string[] {
  return clientsIn(rendered.tree, 'components/todo-editor').map((editor) => {
    const state = editor.part.states['title'];
    if (state === undefined || !('binding' in state)) {
      throw new Error('An editor has no binding for its title.');
    }
    return state.binding;
  });
}

async function write(
  engine: Engine,
  session: string,
  input: { readonly binding: string; readonly value: Value },
): Promise<FieldReceipt> {
  return engine.update(session, {
    operationId: crypto.randomUUID(),
    updaterId: SET_TITLE,
    ...input,
  });
}

async function operate(
  engine: Engine,
  session: string,
  call: { readonly name: string; readonly args: readonly OperationArgument[]; module?: string },
): Promise<unknown> {
  const { args, module = 'actions/todos', name } = call;
  return engine.operate(session, {
    args,
    build: BUILD,
    module,
    name,
    operationId: crypto.randomUUID(),
  });
}

/** How many times the authority evaluated the detail. */
async function details(engine: Engine): Promise<number> {
  return (await engine.stats()).evaluationsByComponent['components/todo-details'] ?? 0;
}

describe('a list site', () => {
  it('renders the detail of the panel a page opens with as the list’s item, keyed by the panel', async () => {
    const { alice, engine } = await open();

    const rendered = await page(engine, alice);
    const opened = panels(['initial:t1', 't1']);

    expect(listOf(rendered)?.inputs).toStrictEqual({ [PANELS]: opened });
    expect(listOf(rendered)?.items?.map(({ item, key }) => ({ item, key }))).toStrictEqual([
      { item: { panelId: 'initial:t1', todoId: 't1' }, key: 'initial:t1' },
    ]);
    expect(clientOf(rendered.tree, 'components/todo-editor').key).toBe('t1');
    expect(rendered.frame.view).toStrictEqual({
      [instanceOf(rendered)]: { d0: { [FILTER]: 'all' }, d1: { [PANELS]: opened } },
    });
  });

  it('shows no list of no panel, and evaluates no detail', async () => {
    const { alice, engine } = await open();

    const rendered = await page(engine, alice, EMPTY);

    expect(Object.keys(workspaceOf(rendered).part.sites ?? {})).toStrictEqual(['d0']);
    await expect(details(engine)).resolves.toBe(0);
  });

  it('renders every panel a view opens at once in the one request', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice, EMPTY);

    const rendered = await viewed(engine, alice, first, {
      opened: panels(['A', 't1'], ['B', 't2']),
    });

    expect(listOf(rendered)?.items?.map(({ key }) => key)).toStrictEqual(['A', 'B']);
    expect(clientsIn(rendered.tree, 'components/todo-editor').map(({ key }) => key)).toStrictEqual([
      't1',
      't2',
    ]);
  });

  it('evaluates a to-do two panels show once, and binds each panel’s editor apart', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice, EMPTY);

    const rendered = await viewed(engine, alice, first, {
      opened: panels(['A', 't1'], ['B', 't1']),
    });
    const [a = '', b = ''] = editorBindings(rendered);
    const evaluated = await details(engine);
    await write(engine, alice, { binding: a, value: 'A から' });
    await write(engine, alice, { binding: b, value: 'B から' });
    const after = await page(engine, alice);

    expect(evaluated).toBe(1);
    expect(a).not.toBe(b);
    expect(after.frame.fields['todos:t1:title']).toBe('B から');
  });

  it('moves panels without a query, or a detail evaluated again', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice, EMPTY);
    await viewed(engine, alice, first, { opened: panels(['A', 't1'], ['B', 't2']) });
    const { renderQueries } = await engine.stats();
    const evaluated = await details(engine);

    const moved = await viewed(engine, alice, first, {
      opened: panels(['B', 't2'], ['A', 't1']),
    });

    expect(listOf(moved)?.items?.map(({ key }) => key)).toStrictEqual(['B', 'A']);
    expect((await engine.stats()).renderQueries).toBe(renderQueries);
    await expect(details(engine)).resolves.toBe(evaluated);
  });

  it('writes through a binding issued in a panel to its to-do, though the panel shows another since, or is closed', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);
    const [binding = ''] = editorBindings(first);

    await viewed(engine, alice, first, { opened: panels(['initial:t1', 't2']) });
    await write(engine, alice, { binding, value: '元の t1 へ' });
    await viewed(engine, alice, first, {});
    await write(engine, alice, { binding, value: '閉じた後も t1 へ' });
    const after = await page(engine, alice);

    expect(after.frame.fields['todos:t1:title']).toBe('閉じた後も t1 へ');
    expect(after.frame.fields['todos:t2:title']).toBe('同期を確認する');
  });

  it('binds the editor of a panel of a long id, naming the item’s key by a digest of it, within a token’s length', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice, EMPTY);
    const long = 'p'.repeat(1400);

    const rendered = await viewed(engine, alice, first, { opened: panels([long, 't1']) });
    const [binding = ''] = editorBindings(rendered);
    await write(engine, alice, { binding, value: '長い id のパネルから' });
    const after = await page(engine, alice);

    expect(binding.length).toBeLessThanOrEqual(4096);
    expect(after.frame.fields['todos:t1:title']).toBe('長い id のパネルから');
  });

  it('writes nothing through a binding of a panel’s to-do moved to another project, or deleted', async () => {
    const { alice, engine } = await open();
    const opened = panels(['A', 't1'], ['B', 't2']);
    const first = await viewed(engine, alice, await page(engine, alice, EMPTY), { opened });
    const [moving = '', deleting = ''] = editorBindings(first);

    await operate(engine, alice, {
      args: [{ json: 'p1' }, { json: 't1' }, { form: [['targetProjectId', 'p2']] }],
      name: 'moveTodo',
    });
    await operate(engine, alice, { args: [{ json: 'p1' }, { json: 't2' }], name: 'deleteTodo' });
    const shown = await viewed(engine, alice, first, { opened });

    for (const binding of [moving, deleting]) {
      await expect(write(engine, alice, { binding, value: '書けない' })).rejects.toMatchObject({
        code: 'TARGET_CHANGED',
        status: 409,
      });
    }

    expect(clientsIn(shown.tree, 'components/todo-editor')).toHaveLength(0);
    expect(textOf(shown.tree)).toContain('選択した Todo は削除または移動されました。');
  });

  it('writes nothing through a binding of a panel once its user may edit no more', async () => {
    const revoke = {
      revoke: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.memberships.update('p1-bob', { canEdit: false });
        });
      },
    };
    const { alice, bob, engine } = await open({
      operations: { ...application.operations, 'test/revoke': revoke },
    });
    const opened = panels(['A', 't1'], ['B', 't2']);
    const first = await viewed(engine, bob, await page(engine, bob, EMPTY), { opened });
    const bindings = editorBindings(first);

    await operate(engine, alice, { args: [], module: 'test/revoke', name: 'revoke' });

    expect(bindings).toHaveLength(2);

    for (const binding of bindings) {
      await expect(write(engine, bob, { binding, value: '書けない' })).rejects.toMatchObject({
        code: 'TARGET_CHANGED',
        status: 409,
      });
    }

    const shown = await viewed(engine, bob, first, { opened });

    expect(clientsIn(shown.tree, 'components/todo-editor')).toHaveLength(0);
    expect(clientsIn(shown.tree, 'components/todo-readonly')).toHaveLength(2);
  });

  it('renders the filter a view sends as the application normalizes it', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    const rendered = await viewed(engine, alice, first, {
      filter: 'bogus',
      opened: panels(['initial:t1', 't1']),
    });

    expect(textOf(workspaceOf(rendered).part.sites?.['d0']?.content ?? null)).toContain(
      '表示中の一覧: all / 2 件',
    );
    expect(rendered.frame.view[instanceOf(first)]?.['d0']).toStrictEqual({ [FILTER]: 'bogus' });
  });

  it('shows no list a view empties, and renders no detail for what its stream follows', async () => {
    const touched = {
      title: async (id: Json): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update(id as string, { title: '詳細だけが読む' });
        });
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/touch': touched },
    });
    const first = await page(engine, alice);

    const closed = await viewed(engine, alice, first, { opened: panels() });
    const evaluated = await details(engine);
    await operate(engine, alice, { args: [{ json: 't1' }], module: 'test/touch', name: 'title' });
    await engine.watch(alice, closed.frame.subscription);

    expect(Object.keys(workspaceOf(closed).part.sites ?? {})).toStrictEqual(['d0']);
    expect(closed.frame.view).toStrictEqual({ [instanceOf(first)]: { d0: { [FILTER]: 'all' } } });
    await expect(details(engine)).resolves.toBe(evaluated);
  });

  it.each([
    ['a panel twice', panels(['A', 't1'], ['A', 't2'])],
    [
      'more panels than a list renders',
      Array.from({ length: 17 }, (_, index) => ({ panelId: `p${String(index)}`, todoId: 't1' })),
    ],
    ['a panel that is no object', [null]],
    ['a panel of no id', [{ todoId: 't1' }]],
  ])('refuses the list of a view of %s where it stands, the rest rendered', async (_, sent) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // The fault the authority's log keeps, kept out of the output.
    });
    onTestFinished(() => {
      logged.mockRestore();
    });
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    const rendered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: {
        [instanceOf(first)]: { d0: { [FILTER]: 'active' }, d1: { [PANELS]: sent as Json } },
      },
    });

    expect(listOf(rendered)?.refused?.code).toBe('INVALID_VIEW');
    expect(textOf(workspaceOf(rendered).part.sites?.['d0']?.content ?? null)).toContain(
      '表示中の一覧: active',
    );
    expect(rendered.frame.view[instanceOf(first)]?.['d1']).toStrictEqual({ [PANELS]: sent });
  });

  it('refuses a view of panels that are no array whole, which no page sends', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    await expect(
      engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instanceOf(first)]: { d0: { [FILTER]: 'all' }, d1: { [PANELS]: 'A' } } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW', status: 400 });
  });
});

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

function program(
  component: string,
  evaluate: (props: Readonly<Record<string, unknown>>, $: RenderScope) => unknown,
): ComponentProgram {
  return { buildId: BUILD, component, evaluate, protocolVersion: PROTOCOL_VERSION, ...STATELESS };
}

const Row = componentRef('test/item-row');

/** A list of rows, each a part of a site of its own, keyed by its id. */
const rowsProgram = program('test/item-rows', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => ids.map((id) => ({ item: id, key: id, render: () => $.h(Row, { id }) })),
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['a', 'b'] as readonly string[] },
  });
});

const rowProgram = program('test/item-row', (props, $) => {
  const id = String(props['id']);
  return $.client({
    props: { id },
    sites: {
      d0: {
        guard: ({ open: opened }) => opened,
        inputs: ['open'],
        render: () => $.h('p', null, `open:${id}`),
      },
    },
    slots: {},
    states: { open: true },
  });
});

/** The instance of each row a rendering holds, by the row's id. */
function rowInstances(rendered: RenderResult): ReadonlyMap<unknown, string | undefined> {
  return new Map(
    clientsIn(rendered.tree, 'test/item-row').map(({ part }) => [part.props['id'], part.instance]),
  );
}

describe('the parts of a list’s items', () => {
  it('names each item’s part apart, and by its key wherever the item moves', async () => {
    const { alice, engine } = await open({
      programs: [...application.programs, rowsProgram, rowProgram],
    });
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/item-rows',
      props: {},
    });
    const { instance = '' } = clientOf(first.tree, 'test/item-rows').part;

    const moved = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { ids: ['b', 'a'] } } },
    });

    const before = rowInstances(first);
    const ids = new Set(before.values());

    expect(textOf(first.tree)).toBe('open:aopen:b');
    expect(textOf(moved.tree)).toBe('open:bopen:a');
    expect(ids.size).toBe(2);
    expect(rowInstances(moved)).toStrictEqual(before);
  });
});

/** A list of the ids its state holds, each item an array of a hole before its id. */
const holedProgram = program('test/holed-list', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          return ids.map((id) => {
            const item = Object.assign([] as string[], { 1: id });
            return { item, key: id, render: () => $.h('p', null, id) };
          });
        },
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['a'] as readonly string[] },
  });
});

/** A list of the ids its props start it with, each item a paragraph of its id. */
const listedProgram = program('test/listed', (props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) =>
          ids.map((id) => ({ item: id, key: id, render: () => $.h('p', null, id) })),
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: props['ids'] as readonly string[] },
  });
});

/** What a refusal of another copy of the package is: its mark, its status and its code. */
const FOREIGN = Object.assign(new Error('Your current access does not allow this.'), {
  code: 'FORBIDDEN',
  [Symbol.for('arkorlab.reactive-state.authority-error')]: true,
  status: 403,
});

/** What a site's own functions make of the page `n` a view sends: the first alone, or a throw. */
function pageOf(n: number): string {
  if (n === 3) {
    throw FOREIGN;
  }
  if (n !== 1) {
    throw new RangeError(`There is no page ${String(n)}.`);
  }
  return 'page 1';
}

/** A site that renders the keys of its options, in the order its function finds them. */
const keyedProgram = program('test/keyed', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        inputs: ['options'],
        render: ({ options }) => $.h('p', null, Object.keys(options).join(',')),
      },
    },
    slots: {},
    states: { options: { a: 1, b: 2 } },
  });
});

/** A site and a list of the page its state holds, which fault of any page but the first. */
const pagedProgram = program('test/paged', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: { inputs: ['page'], render: ({ page: n }) => $.h('p', null, pageOf(n)) },
      d1: {
        each: ({ page: n }) => [{ item: n, key: pageOf(n), render: () => $.h('p', null, 'item') }],
        inputs: ['page'],
      },
    },
    slots: {},
    states: { page: 1 },
  });
});

const TodoEditor = componentRef('components/todo-editor');

/** Whether the list of editors keys each item alike, which the test sets once a binding is issued. */
const keying = { alike: false };

/** A list of the editors of the to-dos its state holds, keyed by each to-do, or alike. */
const editorsProgram = program('test/editors', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          return ids.map((id) => {
            const render = (): unknown => $.h(TodoEditor, { id, projectId: 'p1' });
            return { item: id, key: keying.alike ? 'same' : id, render };
          });
        },
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['t1', 't2'] as readonly string[] },
  });
});

/** A list of a sparse array: a hole before each id, which `.map()` keeps and React renders nothing of. */
const sparseProgram = program('test/sparse', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          const spread: string[] = [];
          for (const [index, id] of ids.entries()) {
            spread[index + index + 1] = id;
          }
          return spread.map((id) => ({ item: id, key: id, render: () => $.h('p', null, id) }));
        },
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['a', 'b'] as readonly string[] },
  });
});

/** A list of a sparse array one entry longer than a list renders, one item of it present. */
const longProgram = program('test/sparse-long', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          const spread: string[] = [];
          spread[VIEW_LIMITS.items] = ids[0] ?? '';
          return spread.map((id) => ({ item: id, key: id, render: () => $.h('p', null, id) }));
        },
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['a'] as readonly string[] },
  });
});

/** How many times the counted list's function has made its items. */
const made = { items: 0 };

/** A list of the ids its state holds, which counts each time its function makes its items. */
const countedProgram = program('test/counted', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          made.items += 1;
          return ids.map((id) => ({ item: id, key: id, render: () => $.h('p', null, id) }));
        },
        inputs: ['ids'],
      },
    },
    slots: {},
    states: { ids: ['a'] as readonly string[] },
  });
});

/**
 * What `ids` make of themselves — the cube of them — as the compile writes it: each function a
 * method is given answering through `$.counted`.
 */
function cubed(ids: readonly string[], $: RenderScope): readonly string[] {
  return ids.flatMap(() => $.counted(ids)).flatMap(() => $.counted(ids));
}

/** A list, and a site, of the cube of their state's ids. */
const cubedProgram = program('test/cubed', (_props, $) => {
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ ids }) => {
          return cubed(ids, $)
            .slice(0, 1)
            .map((id) => ({ item: id, key: id, render: () => $.h('p', null, id) }));
        },
        inputs: ['ids'],
      },
      d1: { inputs: ['ids'], render: ({ ids }) => $.h('p', null, String(cubed(ids, $).length)) },
    },
    slots: {},
    states: { ids: ['a'] as readonly string[] },
  });
});

/** What `promise` was rejected with: none where it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a list’s items, made once a render', () => {
  it('runs a list’s function once to show it at first, and once to show what a view sends', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, countedProgram] });
    made.items = 0;
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/counted',
      props: {},
    });
    const atFirst = made.items;
    const { instance = '' } = clientOf(first.tree, 'test/counted').part;

    const answered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { ids: ['a', 'b'] } } },
    });

    expect(textOf(first.tree)).toBe('a');
    expect(textOf(answered.tree)).toBe('ab');
    expect([atFirst, made.items - atFirst]).toStrictEqual([1, 1]);
  });
});

describe('a view of a part inside a list’s item', () => {
  it('refuses whole a view naming a site the part inside an item has not, no refusal of the list', async () => {
    const { alice, engine } = await open({
      programs: [...application.programs, rowsProgram, rowProgram],
    });
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/item-rows',
      props: {},
    });
    const { instance = '' } = clientOf(first.tree, 'test/item-rows').part;
    const row = rowInstances(first).get('a') ?? '';

    await expect(
      engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: { ids: ['a', 'b'] } }, [row]: { d9: {} } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW', status: 400 });
  });
});

describe('the inputs a site is rendered of', () => {
  it('hands a site’s functions what a view sends, each object’s keys in order of their names, as a first render does', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, keyedProgram] });
    const first = await engine.render(alice, { build: BUILD, component: 'test/keyed', props: {} });
    const { instance = '' } = clientOf(first.tree, 'test/keyed').part;

    const answered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { options: { c: 3, b: 2, a: 1 } } } },
    });

    expect(textOf(first.tree)).toBe('a,b');
    expect(textOf(answered.tree)).toBe('a,b,c');
  });
});

describe('a list site beyond its rules, and a site’s fault', () => {
  it.each([
    [
      'more items than a list renders',
      Array.from({ length: 17 }, (_, index) => `i${String(index)}`),
    ],
    ['a key twice', ['a', 'a']],
  ])(
    'shows nothing at first of a list the authority starts of %s, and refuses it where it stands in a view',
    async (_, ids) => {
      const { alice, engine } = await open({
        programs: [...application.programs, listedProgram],
      });

      const first = await engine.render(alice, {
        build: BUILD,
        component: 'test/listed',
        props: { ids },
      });
      const { instance = '', sites } = clientOf(first.tree, 'test/listed').part;

      const answered = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: { ids } } },
      });

      expect(sites ?? {}).toStrictEqual({});
      expect(clientOf(answered.tree, 'test/listed').part.sites?.['d0']?.refused?.code).toBe(
        'INVALID_VIEW',
      );
    },
  );

  it('shows nothing at first of a list of an item of a hole, which JSON writes as `null`, and refuses it where it stands in a view', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, holedProgram] });
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/holed-list',
      props: {},
    });
    const { instance = '', sites } = clientOf(first.tree, 'test/holed-list').part;

    const answered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { ids: ['a'] } } },
    });

    expect(sites ?? {}).toStrictEqual({});
    expect(clientOf(answered.tree, 'test/holed-list').part.sites?.['d0']?.refused?.code).toBe(
      'INVALID_VIEW',
    );
  });

  it.each(['d0', 'd1'])(
    'refuses where it stands a site %s of whose own function faults of a view’s inputs, the fault in the authority’s log',
    async (site) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {
        // The fault the authority's log keeps, kept out of the output.
      });
      onTestFinished(() => {
        logged.mockRestore();
      });
      const { alice, engine } = await open({
        programs: [...application.programs, pagedProgram],
      });
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'test/paged',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'test/paged').part;

      const answered = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { [site]: { page: 2 } } },
      });

      expect(clientOf(answered.tree, 'test/paged').part.sites?.[site]?.refused).toStrictEqual({
        code: 'INVALID_VIEW',
        message: `The site ${site} renders nothing of the inputs the view sends.`,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('There is no page 2.'));
    },
  );

  it.each(['d0', 'd1'])(
    'refuses where it stands a site %s of what a view’s inputs make of themselves beyond what it may spend, before it is made',
    async (site) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {
        // The fault the authority's log keeps, kept out of the output.
      });
      onTestFinished(() => {
        logged.mockRestore();
      });
      const { alice, engine } = await open({ programs: [...application.programs, cubedProgram] });
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'test/cubed',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'test/cubed').part;
      // As many ids as a view's bytes hold: their cube, which the authority would make whole before
      // a list's bound is checked, is 64 million of them.
      const ids = Array.from({ length: 400 }, () => 'a');

      const answered = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { [site]: { ids } } },
      });

      expect(textOf(first.tree)).toBe('a1');
      expect(clientOf(answered.tree, 'test/cubed').part.sites?.[site]?.refused?.code).toBe(
        'INVALID_VIEW',
      );
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(`more than ${String(VIEW_LIMITS.steps)} steps`),
      );
    },
  );

  it('counts a sparse array’s holes against what a list renders, before looking at its items', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, longProgram] });

    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/sparse-long',
      props: {},
    });

    expect(clientOf(first.tree, 'test/sparse-long').part.sites ?? {}).toStrictEqual({});
  });

  it('lists the items of a sparse array, a hole none of them, as React renders it', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, sparseProgram] });

    const first = await engine.render(alice, { build: BUILD, component: 'test/sparse', props: {} });

    expect(textOf(first.tree)).toBe('ab');
  });

  it('refuses as changed a write through a binding of a list whose items break its rules since', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, editorsProgram] });
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'test/editors',
      props: {},
    });
    const [binding = ''] = editorBindings(first);
    keying.alike = true;
    onTestFinished(() => {
      keying.alike = false;
    });

    await expect(write(engine, alice, { binding, value: '書けない' })).rejects.toMatchObject({
      code: 'TARGET_CHANGED',
      status: 409,
    });
  });

  it('keeps a refusal a site’s own function throws of a view’s inputs, of another copy of the package', async () => {
    const { alice, engine } = await open({ programs: [...application.programs, pagedProgram] });
    const first = await engine.render(alice, { build: BUILD, component: 'test/paged', props: {} });
    const { instance = '' } = clientOf(first.tree, 'test/paged').part;

    const refused = await thrownBy(
      engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: { page: 3 } } },
      }),
    );

    expect(refused).toBeInstanceOf(AuthorityError);
    expect(refused).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

const PagePart = componentRef('test/page-part');

/** A site and a list of the page their state holds, each rendering the part of that page. */
const pagesProgram = program('test/pages', (_props, $) => {
  const part = (n: number): unknown => $.h(PagePart, { page: n });
  return $.client({
    props: {},
    sites: {
      d0: { inputs: ['page'], render: ({ page: n }) => part(n) },
      d1: {
        each: ({ page: n }) => [{ item: n, key: String(n), render: () => part(n) }],
        inputs: ['page'],
      },
    },
    slots: {},
    states: { page: 1 },
  });
});

/**
 * The part of the page its parent hands it, of a to-do it reads first: its site renders the page
 * (`render`), stands under a condition of it (`guard`), or lists it (`each`) — each of which faults
 * of any page but the first.
 */
function pagePart(kind: 'each' | 'guard' | 'render'): ComponentProgram {
  return program('test/page-part', async (props, $) => {
    await db.todos.get('t1');
    const sites = {
      each: {
        each: ({ page: n }) => [{ item: n, key: pageOf(n), render: () => $.h('p', null, 'item') }],
        inputs: ['page'],
      },
      guard: {
        guard: ({ page: n }) => pageOf(n) !== '',
        inputs: ['page'],
        render: () => $.h('p', null, 'shown'),
      },
      render: { inputs: ['page'], render: ({ page: n }) => $.h('p', null, pageOf(n)) },
    } satisfies Record<string, SiteDescriptor<{ readonly page: number }>>;
    return $.client({
      props: {},
      sites: { d0: sites[kind] },
      slots: {},
      states: { page: props['page'] as number },
    });
  });
}

/** The authority's log, kept out of the output while the test runs: what it is written. */
function quietLog(): MockInstance<(...data: unknown[]) => void> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // The fault the authority's log keeps, kept out of the output.
  });
  onTestFinished(() => {
    logged.mockRestore();
  });
  return logged;
}

describe('a part a site renders of the inputs a view sends', () => {
  it.each(
    (['d0', 'd1'] as const).flatMap((site) =>
      (['render', 'guard', 'each'] as const).map((kind) => [site, kind] as const),
    ),
  )(
    'refuses where it stands a site %s whose part’s own site faults, its %s, of the first values those inputs made',
    async (site, kind) => {
      const logged = quietLog();
      const { alice, engine } = await open({
        programs: [...application.programs, pagesProgram, pagePart(kind)],
      });
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'test/pages',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'test/pages').part;

      const answered = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { [site]: { page: 2 } } },
      });

      expect(clientOf(answered.tree, 'test/pages').part.sites?.[site]?.refused).toStrictEqual({
        code: 'INVALID_VIEW',
        message: `The site ${site} renders nothing of the inputs the view sends.`,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('There is no page 2.'));
    },
  );

  it('follows what the part read before its site faulted, for the site that refuses of it', async () => {
    quietLog();
    const touched = {
      estimate: async (id: Json): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update(id as string, { estimate: 9 });
        });
      },
    };
    const { alice, engine } = await open({
      operations: { ...application.operations, 'test/touch': touched },
      programs: [...application.programs, pagesProgram, pagePart('guard')],
    });
    const commits: CommitEvent[] = [];
    engine.onCommit((event) => {
      commits.push(event);
    });
    const first = await engine.render(alice, { build: BUILD, component: 'test/pages', props: {} });
    const { instance = '' } = clientOf(first.tree, 'test/pages').part;
    const refused = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { page: 2 } } },
    });
    const watched = await engine.watch(alice, refused.frame.subscription);

    await operate(engine, alice, {
      args: [{ json: 't1' }],
      module: 'test/touch',
      name: 'estimate',
    });

    expect(clientOf(refused.tree, 'test/pages').part.sites?.['d0']?.refused?.code).toBe(
      'INVALID_VIEW',
    );
    expect(watched.dependsOn(commits.at(-1)!)).toBe(true);
  });
});
