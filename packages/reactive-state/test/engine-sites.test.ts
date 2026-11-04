import { describe, expect, it, onTestFinished } from 'vitest';

import { type CommitEvent, Engine, type EngineOptions } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  componentRef,
  type FieldReceipt,
  type Json,
  type OperationArgument,
  PROTOCOL_VERSION,
  type RenderedClient,
  type RenderResult,
  type RenderScope,
  type Value,
  type View,
} from '../src/program.ts';
import { forbidden, requireUser } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { requireProjectAccess } from './support/app/permissions.ts';
import { clientOf, clientsIn, textOf } from './support/frames.ts';
import { application, BUILD, programs, SET_TITLE } from './support/program.ts';

/**
 * The authority, rendering a composed page — the project fixture's second version: a root that
 * hands its content to an access check as its children, a layout that renders its children, and a
 * workspace whose list and detail are dynamic sites, rendered for the view a page sends — the
 * filter and the selection it holds — at one revision with the rest of the page; and the bindings
 * issued inside those sites, held to what the page renders now.
 */

interface Opened {
  readonly engine: Engine;
  /** Alice's session: she owns p1 and p2. */
  readonly alice: string;
  /** Bob's session: a member of p1 and p2 who may edit them, and the owner of p3. */
  readonly bob: string;
  readonly commits: CommitEvent[];
}

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

const PAGE = { filter: 'all', projectId: 'p1', selectedId: 't1' } as const;

/** The composed project page, as the fixture's route renders it. */
async function page(
  engine: Engine,
  session: string,
  props: Readonly<Record<string, Json>> = PAGE,
): Promise<RenderResult> {
  return engine.render(session, { build: BUILD, component: 'components/workspace-project', props });
}

/** The workspace's client part in a rendering. */
function workspaceOf(rendered: RenderResult): RenderedClient {
  return clientOf(rendered.tree, 'components/project-workspace');
}

/** The workspace's instance id, which a view names it by. */
function instanceOf(rendered: RenderResult): string {
  const { instance } = workspaceOf(rendered).part;
  if (instance === undefined) {
    throw new Error('The workspace has no instance id.');
  }
  return instance;
}

/** The page rendered again for `view`, whose sites name the workspace's by their ids. */
async function viewed(
  engine: Engine,
  session: string,
  rendered: RenderResult,
  sites: Readonly<Record<string, Readonly<Record<string, Json>>>>,
): Promise<RenderResult> {
  const view: View = { [instanceOf(rendered)]: sites };
  return engine.view(session, { subscription: rendered.frame.subscription, view });
}

/** The binding the editor in a rendering writes its title with. */
function editorBinding(rendered: RenderResult): string {
  const state = clientOf(rendered.tree, 'components/todo-editor').part.states['title'];
  if (state === undefined || !('binding' in state)) {
    throw new Error('The editor has no binding for its title.');
  }
  return state.binding;
}

async function write(
  engine: Engine,
  session: string,
  input: { readonly binding: string; readonly updaterId: string; readonly value: Value },
): Promise<FieldReceipt> {
  return engine.update(session, { operationId: crypto.randomUUID(), ...input });
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

/** The test application's programs and its server operations, with `more` beside them. */
function withPrograms(...more: readonly ComponentProgram[]): Partial<EngineOptions> {
  return { programs: [...programs, ...more] };
}

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

function program(
  component: string,
  evaluate: (props: Readonly<Record<string, unknown>>, $: RenderScope) => unknown,
  states: Pick<ComponentProgram, 'updaters' | 'writable'> = STATELESS,
): ComponentProgram {
  return { buildId: BUILD, component, evaluate, protocolVersion: PROTOCOL_VERSION, ...states };
}

const ProjectWorkspace = componentRef('components/project-workspace');
const ProjectSummary = componentRef('components/project-summary');
const ProjectCommands = componentRef('components/project-commands');
const MemberEditor = componentRef('components/member-editor');
const Row = componentRef('components/row');

/**
 * The project with its wrappers written inline: the access check, the content's reads and
 * the layout in one component, around the same workspace — the page the composed one renders, by
 * another composition of the same code.
 */
const inlineProject = program('components/inline-project', async (props, $) => {
  const projectId = String(props['projectId']);
  const filter = String(props['filter']);
  const selected = props['selectedId'];
  const initialSelectedId = typeof selected === 'string' ? selected : '';
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);
  const choices = await db.todos.findMany({
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true },
    where: { projectId },
  });
  const memberships = access.canManageMembers
    ? await db.memberships.findMany({ orderBy: [{ id: 'asc' }], where: { projectId } })
    : [];
  const workspace = $.h(
    ProjectWorkspace,
    {
      choices,
      initialFilter: filter,
      initialSelectedId,
      key: JSON.stringify([projectId, filter, initialSelectedId]),
      projectId,
    },
    $.h(ProjectSummary, { projectId }),
  );
  const members =
    access.canManageMembers &&
    $.h(
      'aside',
      null,
      $.h('h3', null, 'メンバーの編集権限'),
      memberships.map((membership) =>
        $.h(MemberEditor, { id: membership.id, key: membership.id, projectId }),
      ),
    );
  return $.h(
    'main',
    { 'data-testid': 'project-layout' },
    $.h('h2', null, access.project.title),
    $.h('div', null, workspace, access.canEdit && $.h(ProjectCommands, { projectId }), members),
  );
});

describe('a composed page', () => {
  it('renders, writes and refuses with its wrappers written inline as it does with them handed children', async () => {
    const { alice, bob, engine } = await open(withPrograms(inlineProject));
    const both = async (
      session: string,
      props: Readonly<Record<string, Json>> = PAGE,
    ): Promise<readonly [RenderResult, RenderResult]> => {
      return [
        await page(engine, session, props),
        await engine.render(session, {
          build: BUILD,
          component: 'components/inline-project',
          props,
        }),
      ];
    };

    for (const session of [alice, bob]) {
      const [split, inline] = await both(session);

      expect(textOf(inline.tree)).toBe(textOf(split.tree));
      expect(inline.frame.fields).toStrictEqual(split.frame.fields);
    }
    // Alice is no member of Bob's p3: neither shows her anything of it.
    const refused = await both(alice, { filter: 'all', projectId: 'p3', selectedId: 't1' });

    expect(refused.map((rendered) => textOf(rendered.tree))).toStrictEqual(['', '']);

    // A title written through the inline page's editor is the split page's too, and a view of
    // either workspace renders alike.
    const [, inline] = await both(alice);
    await write(engine, alice, {
      binding: editorBinding(inline),
      updaterId: SET_TITLE,
      value: '書き直した題',
    });
    const [splitAfter, inlineAfter] = await both(alice);
    const active = { d0: { filter: 'active' } };
    const splitView = await viewed(engine, alice, splitAfter, active);
    const inlineView = await viewed(engine, alice, inlineAfter, active);

    expect(splitAfter.frame.fields['todos:t1:title']).toBe('書き直した題');
    expect(inlineAfter.frame.fields).toStrictEqual(splitAfter.frame.fields);
    expect(textOf(inlineView.tree)).toBe(textOf(splitView.tree));
    expect(inlineView.frame.fields).toStrictEqual(splitView.frame.fields);
  });

  it('renders a node handed by a prop other than children where the component puts it', async () => {
    const Card = componentRef('components/card');
    const card = program('components/card', (props, $) =>
      $.h('section', null, props['header'], props['children']),
    );
    const cards = program('components/cards', (_props, $) => {
      return $.h(
        $.fragment,
        null,
        $.h(Card, { header: $.h('h3', null, '見出し'), key: 'one' }, '本文'),
        $.h(Card, { header: 'ただの文字', key: 'two' }),
      );
    });
    const { alice, engine } = await open(withPrograms(card, cards));

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'components/cards',
      props: {},
    });

    expect(textOf(rendered.tree)).toBe('見出し本文ただの文字');
  });

  it('hands a component an `undefined` it is given as a child as React does, apart from `null`', async () => {
    const Telling = componentRef('components/telling');
    const telling = program('components/telling', (props, $) => {
      const { children } = props;
      const said = Array.isArray(children)
        ? children.map((child) => (child === undefined ? 'u' : String(child))).join('')
        : String(children);
      return $.h('p', null, `${'children' in props ? 'in' : 'out'}:${said};`);
    });
    const tellings = program('components/tellings', (_props, $) => {
      return $.h(
        $.fragment,
        null,
        $.h(Telling, { key: 'a' }, undefined),
        $.h(Telling, { key: 'b' }, null),
        $.h(Telling, { key: 'c' }, undefined, 'x'),
        $.h(Telling, { key: 'd' }, null, 'x'),
        // As a spread of props gives it (`<Telling {...{ children: undefined }} />`), and none.
        $.h(Telling, { children: undefined, key: 'e' }),
        $.h(Telling, { key: 'f' }),
      );
    });
    const { alice, engine } = await open(withPrograms(telling, tellings));

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'components/tellings',
      props: {},
    });

    expect(textOf(rendered.tree)).toBe(
      'in:undefined;in:null;in:ux;in:nullx;in:undefined;out:undefined;',
    );
  });

  it('tells a component given no children from one given a `null` child, though the memo holds one', async () => {
    const Telling = componentRef('components/telling');
    const telling = program('components/telling', (props, $) =>
      $.h('p', null, props['children'] === undefined ? 'none' : 'given'),
    );
    const tellings = program('components/tellings', (_props, $) =>
      $.h($.fragment, null, $.h(Telling, { key: 'a' }), $.h(Telling, { key: 'b' }, null)),
    );
    const { alice, engine } = await open(withPrograms(telling, tellings));

    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'components/tellings',
      props: {},
    });

    expect(textOf(rendered.tree)).toBe('nonegiven');
  });

  it('renders the children a component is handed where it puts them, and a workspace’s sites at first', async () => {
    const { alice, engine } = await open();

    const rendered = await page(engine, alice);
    const workspace = workspaceOf(rendered);
    const instance = instanceOf(rendered);

    expect(rendered.status).toBe('rendered');
    expect(textOf(workspace.part.slots['s0'] ?? null)).toBe(
      '確定した集計: 未完了 2 件 / 完了 0 件',
    );
    expect(workspace.part.sites?.['d0']?.inputs).toStrictEqual({ filter: 'all' });
    expect(
      clientsIn(workspace.part.sites?.['d0']?.content ?? null, 'components/todo-row'),
    ).toHaveLength(2);
    expect(workspace.part.sites?.['d1']?.inputs).toStrictEqual({
      selectedId: 't1',
      showDetails: true,
    });
    expect(clientOf(rendered.tree, 'components/todo-editor').key).toBe('t1');
    expect(rendered.frame.view).toStrictEqual({
      [instance]: { d0: { filter: 'all' }, d1: { selectedId: 't1', showDetails: true } },
    });
  });

  it('shows no detail while no to-do is selected, and evaluates none', async () => {
    const { alice, engine } = await open();

    const rendered = await page(engine, alice, { filter: 'all', projectId: 'p1' });

    expect(Object.keys(workspaceOf(rendered).part.sites ?? {})).toStrictEqual(['d0']);
    expect((await engine.stats()).evaluationsByComponent).not.toHaveProperty(
      'components/todo-details',
    );
  });

  it('evaluates nothing a wrapper that refuses the session was handed', async () => {
    const { alice, engine } = await open();

    const rendered = await page(engine, alice, {
      filter: 'all',
      projectId: 'p3',
      selectedId: 't1',
    });
    const evaluated = (await engine.stats()).evaluationsByComponent;

    expect(textOf(rendered.tree)).toBe('');
    expect(evaluated).toMatchObject({
      'components/project-access': 1,
      'components/workspace-project': 1,
    });

    for (const component of [
      'project-content',
      'project-summary',
      'todo-results',
      'todo-details',
    ]) {
      expect(evaluated).not.toHaveProperty(`components/${component}`);
    }
  });

  it('renders the sites a view names, with the inputs it sends, at one revision with the page', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    const rendered = await viewed(engine, alice, first, {
      d0: { filter: 'done' },
      d1: { selectedId: 't2', showDetails: true },
    });
    const workspace = workspaceOf(rendered);

    expect(workspace.part.instance).toBe(instanceOf(first));
    expect(textOf(workspace.part.sites?.['d0']?.content ?? null)).toContain(
      '表示中の一覧: done / 0 件',
    );
    expect(clientOf(rendered.tree, 'components/todo-editor').key).toBe('t2');
    expect(rendered.frame.view).toStrictEqual({
      [instanceOf(first)]: { d0: { filter: 'done' }, d1: { selectedId: 't2', showDetails: true } },
    });
    expect(rendered.frame.subscription).not.toBe(first.frame.subscription);
    expect(rendered.frame.revision).toBe(first.frame.revision);
  });

  it.each([
    // The page closed the detail by a state it set, whose value it sends.
    ['a state the page set', { $set: { showDetails: false }, d0: { filter: 'all' } }],
    // A view without the page's set states — past what a request carries — names what shows.
    ['the sites a view names', { d0: { filter: 'all' } }],
  ])('renders no site the view does not name, closed by %s', async (_closed, sites) => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);
    const before = (await engine.stats()).evaluationsByComponent['components/todo-details'];

    const rendered = await viewed(engine, alice, first, sites);

    expect(Object.keys(workspaceOf(rendered).part.sites ?? {})).toStrictEqual(['d0']);
    expect(clientsIn(rendered.tree, 'components/todo-editor')).toHaveLength(0);
    expect((await engine.stats()).evaluationsByComponent['components/todo-details']).toBe(before);
  });

  it.each([
    ['a site the part has not', { d9: { filter: 'all' } }],
    ['inputs the site does not read', { d0: { filter: 'all', memo: 'kept' } }],
    ['an input of another kind than its first value', { d0: { filter: 1 } }],
    ['inputs that are no object', { d0: ['all'] }],
  ])('refuses a view of %s', async (_, sites) => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    await expect(
      viewed(
        engine,
        alice,
        first,
        sites as Readonly<Record<string, Readonly<Record<string, Json>>>>,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW', status: 400 });
  });

  it('refuses a view that is no view, or more than a page shows', async () => {
    const { alice, engine } = await open();
    const { frame } = await page(engine, alice);
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`part${String(index)}`, {}]),
    );

    // Measured in bytes, as a token carries it: fewer characters than the limit, but more bytes.
    const wide = { part: { d0: { filter: 'あ'.repeat(700) } } };

    for (const view of [
      null,
      'all',
      [],
      many,
      { part: { d0: { filter: 'x'.repeat(4096) } } },
      wide,
    ]) {
      await expect(
        engine.view(alice, { subscription: frame.subscription, view }),
      ).rejects.toMatchObject({ code: 'INVALID_VIEW', status: 400 });
    }
  });

  it('renders a site of a state that starts as null for a value, and of one that starts as a value for null', async () => {
    const nullable = program('components/nullable', (_props, $) => {
      return $.client({
        props: {},
        sites: {
          d0: {
            inputs: ['choice'],
            render: ({ choice }) => $.h('p', null, `choice:${JSON.stringify(choice)}`),
          },
          d1: {
            inputs: ['label'],
            render: ({ label }) => $.h('p', null, `label:${JSON.stringify(label)}`),
          },
        },
        slots: {},
        states: { choice: null, label: 'first' },
      });
    });
    const { alice, engine } = await open(withPrograms(nullable));
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'components/nullable',
      props: {},
    });
    const { instance = '' } = clientOf(first.tree, 'components/nullable').part;
    const view = { [instance]: { d0: { choice: 't1' }, d1: { label: null } } };

    const rendered = await engine.view(alice, { subscription: first.frame.subscription, view });

    expect(textOf(rendered.tree)).toBe(`choice:"t1"label:null`);
  });

  describe('a site of a state the page follows', () => {
    /** A part whose state starts of what the database holds, and whose site reads the state. */
    const followed = program('components/followed', async (_props, $) => {
      const todo = await db.todos.get('t1');
      return $.client({
        props: {},
        sites: {
          d0: {
            inputs: ['done'],
            render: ({ done }) => $.h('p', null, `done:${JSON.stringify(done)}`),
          },
        },
        slots: {},
        states: { done: todo?.completed ?? false },
      });
    });

    async function opened(): Promise<Opened & { readonly first: RenderResult; instance: string }> {
      const setup = await open(withPrograms(followed));
      const first = await setup.engine.render(setup.alice, {
        build: BUILD,
        component: 'components/followed',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'components/followed').part;
      return { ...setup, first, instance };
    }

    it('renders an input the view leaves out of the value the authority renders now', async () => {
      const { alice, engine, first, instance } = await opened();

      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: {} } },
      });

      expect(textOf(shown.tree)).toBe('done:false');
      expect(shown.frame.view).toStrictEqual({ [instance]: { d0: { done: false } } });

      await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
      // A request that changes nothing: the subscription leaves the input out still.
      const again = await engine.view(alice, { subscription: shown.frame.subscription, view: {} });

      expect(textOf(again.tree)).toBe('done:true');
      expect(again.frame.view).toStrictEqual({ [instance]: { d0: { done: true } } });
    });

    it('renders an input the view sends of its value, whatever the authority renders now', async () => {
      const { alice, engine, first, instance } = await opened();
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: { done: false } } },
      });

      await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
      const again = await engine.view(alice, { subscription: shown.frame.subscription, view: {} });

      expect(textOf(again.tree)).toBe('done:false');
    });

    /**
     * A part whose site `d0` shows while a state of the database's holds, `done`, and `d1` while
     * the page's `open` does; `note` is the page's.
     */
    const opening = program('components/opening', async (_props, $) => {
      const todo = await db.todos.get('t1');
      return $.client({
        props: {},
        sites: {
          d0: {
            guard: ({ done }) => done,
            inputs: ['done'],
            render: () => $.h('p', null, 'all done'),
          },
          d1: {
            guard: ({ open: shown }) => shown,
            inputs: ['note', 'open'],
            render: ({ note }) => $.h('p', null, `note:${JSON.stringify(note)}`),
          },
        },
        slots: {},
        states: { done: todo?.completed ?? false, note: '', open: true },
      });
    });

    async function openedOf(): Promise<
      Opened & { readonly first: RenderResult; readonly instance: string }
    > {
      const setup = await open(withPrograms(opening));
      const first = await setup.engine.render(setup.alice, {
        build: BUILD,
        component: 'components/opening',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'components/opening').part;
      return { ...setup, first, instance };
    }

    it('tells the page which states the sites of a part read', async () => {
      const { first } = await openedOf();

      expect(clientOf(first.tree, 'components/opening').part.reads).toStrictEqual([
        'done',
        'note',
        'open',
      ]);
    });

    it('shows a site of a part the view names that a state it follows opens', async () => {
      const { alice, engine, first, instance } = await openedOf();
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { $set: { note: 'x' }, d1: { note: 'x' } } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: { d1: { note: 'x', open: true } } });

      await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
      const again = await engine.view(alice, { subscription: shown.frame.subscription, view: {} });

      expect(textOf(again.tree)).toContain('all done');
      expect(textOf(again.tree)).toContain('note:"x"');
      expect(again.frame.view).toStrictEqual({
        [instance]: { d0: { done: true }, d1: { note: 'x', open: true } },
      });
    });

    it('shows no site of a part the view names that a state the page set closes', async () => {
      const { alice, engine, first, instance } = await openedOf();

      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { $set: { open: false } } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: {} });
    });

    it('takes a set value of what is no local state of the part now, or of another kind, as followed', async () => {
      const { alice, engine, first, instance } = await openedOf();

      // A state the page set may since have been bound to a field: its value is the authority's.
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { $set: { missing: true, open: 'no' } } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: { d1: { note: '', open: true } } });
    });

    it('refuses a view whose set states are no object of values', async () => {
      const { alice, engine, first, instance } = await openedOf();

      await expect(
        engine.view(alice, {
          subscription: first.frame.subscription,
          view: { [instance]: { $set: ['open'] as unknown as Readonly<Record<string, Json>> } },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_VIEW', status: 400 });
    });

    it('shows only the sites named of a part a view names without the states the page set', async () => {
      const { alice, engine, first, instance } = await openedOf();

      // A request past what it carries, or a view of before `$set`: d1's condition holds of the
      // authority's values, but the view closed it.
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { d0: {} } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: {} });

      await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
      const again = await engine.view(alice, { subscription: shown.frame.subscription, view: {} });

      expect(again.frame.view).toStrictEqual({ [instance]: { d0: { done: true } } });
    });

    /** A part whose site `d0` shows the page's `open`, and `d1` shows while it holds. */
    const carrying = program('components/carrying', (_props, $) => {
      return $.client({
        props: {},
        sites: {
          d0: {
            guard: () => true,
            inputs: ['open'],
            render: ({ open: shown }) => $.h('p', null, `open:${JSON.stringify(shown)}`),
          },
          d1: {
            guard: ({ open: shown }) => shown,
            inputs: ['open'],
            render: () => $.h('p', null, 'details'),
          },
        },
        slots: {},
        states: { open: true },
      });
    });

    it('tells nothing of what the sites of a part read where they read no state', async () => {
      const still = program('components/still', (_props, $) => {
        return $.client({
          props: {},
          sites: { d0: { guard: () => true, inputs: [], render: () => $.h('p', null, 'still') } },
          slots: {},
          states: {},
        });
      });
      const { alice, engine } = await open(withPrograms(still));
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'components/still',
        props: {},
      });

      expect(Object.hasOwn(clientOf(first.tree, 'components/still').part, 'reads')).toBe(false);
    });

    it('takes the value a site the view names carries for set, of the sites it names not', async () => {
      const { alice, engine } = await open(withPrograms(carrying));
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'components/carrying',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'components/carrying').part;

      // The page closed the detail by the state its other site carries, which `$set` leaves out.
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { $set: {}, d0: { open: false } } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: { d0: { open: false } } });
    });

    it('takes the set value a view sends over another a site it names carries', async () => {
      const { alice, engine } = await open(withPrograms(carrying));
      const first = await engine.render(alice, {
        build: BUILD,
        component: 'components/carrying',
        props: {},
      });
      const { instance = '' } = clientOf(first.tree, 'components/carrying').part;

      // A site a render not committed yet waits for carries the page's old value.
      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: { $set: { open: false }, d0: { open: true } } },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: { d0: { open: true } } });
    });

    it('opens no site of a part a view names with nothing, as a part no longer rendered', async () => {
      const { alice, engine, first, instance } = await openedOf();

      const shown = await engine.view(alice, {
        subscription: first.frame.subscription,
        view: { [instance]: {} },
      });

      expect(shown.frame.view).toStrictEqual({ [instance]: {} });
    });
  });

  it('renders no site a view names whose condition no longer holds of what its parent decides, and writes nothing through a binding issued in it', async () => {
    const Guarded = componentRef('components/guarded');
    const Editor = componentRef('components/todo-editor');
    // The parent decides from the database whether the part's editor may show at all.
    const parent = program('components/guarded-parent', async (_props, $) => {
      const todo = await db.todos.get('t1');
      return $.h(Guarded, { canEdit: todo !== null && !todo.completed });
    });
    const guarded = program('components/guarded', (props, $) => {
      const canEdit = props['canEdit'] === true;
      return $.client({
        props: {},
        sites: {
          d0: {
            guard: ({ open: opened }) => canEdit && opened,
            inputs: ['open'],
            render: () => $.h(Editor, { id: 't2', projectId: 'p1' }),
          },
        },
        slots: {},
        states: { open: true },
      });
    });
    const { alice, engine } = await open(withPrograms(parent, guarded));
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'components/guarded-parent',
      props: {},
    });
    const binding = editorBinding(first);
    const { instance = '' } = clientOf(first.tree, 'components/guarded').part;

    await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
    // The page still shows the editor, open: its view names the site.
    const answered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { open: true } } },
    });

    expect(clientsIn(answered.tree, 'components/todo-editor')).toHaveLength(0);
    expect(answered.frame.view).toStrictEqual({ [instance]: {} });
    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '条件の外から' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
  });

  it('follows a page of many parts, each showing what it showed at first, by a short subscription, which keeps what a request changed', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `r${String(index)}`);
    const rows = program('components/rows', (_props, $) =>
      $.h('ul', null, ...ids.map((id) => $.h(Row, { id, key: id }))),
    );
    const row = program('components/row', (props, $) => {
      return $.client({
        props: { id: String(props['id']) },
        sites: {
          d0: {
            guard: ({ open: opened }) => opened,
            inputs: ['open'],
            render: () => $.h('p', null, 'details'),
          },
        },
        slots: {},
        states: { open: false },
      });
    });
    const { alice, engine } = await open(withPrograms(rows, row));
    const first = await engine.render(alice, {
      build: BUILD,
      component: 'components/rows',
      props: {},
    });
    const instances = Object.keys(first.frame.view);
    const target = instances[7] ?? '';
    const shown = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { [target]: { d0: { open: true } } },
    });
    // A request that changes nothing: the view its subscription names.
    const again = await engine.view(alice, { subscription: shown.frame.subscription, view: {} });
    const showing = Object.entries(again.frame.view).filter(
      ([, sites]) => Object.keys(sites).length > 0,
    );

    expect(instances).toHaveLength(300);
    expect(first.frame.subscription.length).toBeLessThan(1024);
    expect(showing).toStrictEqual([[target, { d0: { open: true } }]]);
  });

  it('refuses for good a render whose tokens would be longer than it reads back', async () => {
    const { alice, engine } = await open();

    await expect(
      page(engine, alice, { filter: 'all', projectId: 'p1', selectedId: 'x'.repeat(4000) }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
  });

  it('renders a view naming another project’s to-do as the detail renders it: gone from this one', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    const rendered = await viewed(engine, alice, first, {
      d0: { filter: 'all' },
      d1: { selectedId: 't3', showDetails: true },
    });

    expect(textOf(workspaceOf(rendered).part.sites?.['d1']?.content ?? null)).toBe(
      '選択した Todo は削除または移動されました。',
    );
    expect(clientsIn(rendered.tree, 'components/todo-editor')).toHaveLength(0);
  });

  it('shows a part the view does not name, for one it names that the page renders not, at first', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);

    const rendered = await engine.view(alice, {
      subscription: first.frame.subscription,
      view: { gone: { d0: { filter: 'done' } } },
    });

    expect(rendered.frame.view).toStrictEqual(first.frame.view);
  });

  it('refuses a view of a subscription another session holds', async () => {
    const { alice, bob, engine } = await open();
    const first = await page(engine, alice);

    await expect(
      engine.view(bob, { subscription: first.frame.subscription, view: {} }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('follows the view the page shows, not the one it showed first', async () => {
    const touched = {
      estimate: async (id: Json): Promise<void> => {
        await db.transaction(async () => {
          await db.todos.update(id as string, { estimate: 9 });
        });
      },
    };
    const { alice, commits, engine } = await open({
      operations: { ...application.operations, 'test/touch': touched },
    });
    const first = await page(engine, alice);
    const done = await viewed(engine, alice, first, { d0: { filter: 'done' } });
    const watched = await engine.watch(alice, done.frame.subscription);

    await operate(engine, alice, {
      args: [{ json: 't3' }],
      module: 'test/touch',
      name: 'estimate',
    });
    const elsewhere = commits.at(-1)!;
    await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
    const completed = commits.at(-1)!;
    const again = await engine.watch(alice, done.frame.subscription);

    // The stream renders the done list with the detail closed, as the page shows them: what it
    // showed when the subscription was issued, and nothing of p2's.
    expect(watched.digest).toBe(watched.issued);
    expect(watched.dependsOn(elsewhere)).toBe(false);
    // The done list hears of p1's to-dos completed, and shows them.
    expect(watched.dependsOn(completed)).toBe(true);
    expect(again.digest).not.toBe(watched.digest);
  });

  it('writes through a binding issued in a site, whatever the page shows since', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);
    const binding = editorBinding(first);

    await viewed(engine, alice, first, {
      d0: { filter: 'all' },
      d1: { selectedId: 't2', showDetails: true },
    });
    await write(engine, alice, { binding, updaterId: SET_TITLE, value: '一つ目のまま' });
    const after = await page(engine, alice);

    expect(after.frame.fields['todos:t1:title']).toBe('一つ目のまま');
    expect(after.frame.fields['todos:t2:title']).toBe('同期を確認する');
  });

  it('keeps writing through a binding as the commits before it change what its parents are rendered with', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await page(engine, alice));

    // Each title is a choice the workspace is rendered with, and the layout holds the workspace.
    await write(engine, alice, { binding, updaterId: SET_TITLE, value: 'あ' });
    await write(engine, alice, { binding, updaterId: SET_TITLE, value: 'あい' });
    const receipt = await write(engine, alice, { binding, updaterId: SET_TITLE, value: 'あいう' });

    expect(receipt.committedRevision).toBe(3);
    expect((await page(engine, alice)).frame.fields['todos:t1:title']).toBe('あいう');
  });

  it('writes nothing through a binding of a to-do moved to another project, though the view names it', async () => {
    const { alice, engine } = await open();
    const binding = editorBinding(await page(engine, alice));

    await operate(engine, alice, {
      args: [{ json: 'p1' }, { json: 't1' }, { form: [['targetProjectId', 'p2']] }],
      name: 'moveTodo',
    });

    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '移った先で' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
  });

  it('refuses a write once its parent no longer lets it be rendered, though it checks nothing itself', async () => {
    const Gate = componentRef('test/gate');
    const Editor = componentRef('test/gated-editor');
    const gated = program('test/gated', (_, $) => $.h(Gate, null, $.h(Editor, { id: 't1' })));
    const gate = program('test/gate', async (props, $) => {
      const held = await db.counters.get('other');
      if ((held?.count ?? 0) < 100) {
        forbidden();
      }
      return $.h($.fragment, null, props['children']);
    });
    const editor = program(
      'test/gated-editor',
      async (props, $) => {
        await requireUser();
        return $.client({
          props: {},
          slots: {},
          states: { title: db.todos.ref(props['id'] as string).title },
        });
      },
      { updaters: { [SET_TITLE]: { keys: ['title'], kind: 'set' } }, writable: ['title'] },
    );
    const lower = {
      lower: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.counters.update('other', { count: 50 });
        });
      },
    };
    const { alice, engine } = await open({
      ...withPrograms(gated, gate, editor),
      operations: { ...application.operations, 'test/lower': lower },
    });
    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/gated',
      props: {},
    });
    const state = clientOf(rendered.tree, 'test/gated-editor').part.states['title'];
    const binding = state !== undefined && 'binding' in state ? state.binding : '';

    await write(engine, alice, { binding, updaterId: SET_TITLE, value: '通る' });
    await operate(engine, alice, { args: [], module: 'test/lower', name: 'lower' });

    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '通らない' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('writes nothing through a binding of a component now rendered with other props where it stood', async () => {
    const Bound = componentRef('test/bound');
    const holder = program('test/holder', async (_, $) => {
      const counter = await db.counters.get('main');
      return $.h(Bound, { scope: counter?.title ?? '' });
    });
    const bound = program(
      'test/bound',
      async (_, $) => {
        await requireUser();
        return $.client({ props: {}, slots: {}, states: { title: db.todos.ref('t1').title } });
      },
      { updaters: { [SET_TITLE]: { keys: ['title'], kind: 'set' } }, writable: ['title'] },
    );
    const rename = {
      rename: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.counters.update('main', { title: 'another scope' });
        });
      },
    };
    const { alice, engine } = await open({
      ...withPrograms(holder, bound),
      operations: { ...application.operations, 'test/rename': rename },
    });
    const rendered = await engine.render(alice, {
      build: BUILD,
      component: 'test/holder',
      props: {},
    });
    const state = clientOf(rendered.tree, 'test/bound').part.states['title'];
    const binding = state !== undefined && 'binding' in state ? state.binding : '';

    await operate(engine, alice, { args: [], module: 'test/rename', name: 'rename' });

    // The same field, at the same place, but the component is rendered for another scope now.
    await expect(
      write(engine, alice, { binding, updaterId: SET_TITLE, value: '別の文脈で' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
  });

  it('reuses the renderings a view showed before when it shows them again, and none a commit changed', async () => {
    const { alice, engine } = await open();
    const first = await page(engine, alice);
    const results = async (): Promise<number> =>
      (await engine.stats()).evaluationsByComponent['components/todo-results'] ?? 0;
    const content = async (): Promise<number> =>
      (await engine.stats()).evaluationsByComponent['components/project-content'] ?? 0;
    const all = { d0: { filter: 'all' }, d1: { selectedId: 't1', showDetails: true } };
    const done = { d0: { filter: 'done' }, d1: { selectedId: 't1', showDetails: true } };

    await viewed(engine, alice, first, done);
    const once = await results();
    const queries = (await engine.stats()).renderQueries;
    await viewed(engine, alice, first, all);

    // all, then done; all again is the memo's, and the page around it too: it runs no query.
    expect(once).toBe(2);
    expect(queries).toBeGreaterThan(0);
    await expect(results()).resolves.toBe(2);
    await expect(content()).resolves.toBe(1);
    expect((await engine.stats()).renderQueries).toBe(queries);

    await operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' });
    const afterwards = await viewed(engine, alice, first, done);

    expect(textOf(workspaceOf(afterwards).part.sites?.['d0']?.content ?? null)).toContain(
      '表示中の一覧: done / 2 件',
    );
    await expect(results()).resolves.toBe(3);
    expect((await engine.stats()).renderQueries).toBeGreaterThan(queries);
  });
});
