import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { CommitEvent, Engine } from '../src/authority/index.ts';
import {
  fieldKey,
  type Json,
  type OperationArgument,
  type RenderResult,
  type Value,
} from '../src/program.ts';
import { clientOf, clientsIn, textOf } from './support/frames.ts';
import { orm } from './support/todo-app/db.ts';
import { opened } from './support/todo-app/engine.ts';
import {
  ADD_ESTIMATE,
  application,
  BUILD,
  INCREMENT,
  SET_CAN_EDIT,
  SET_COMPLETED,
  SET_COUNT,
  SET_TITLE,
} from './support/todo-app/programs.ts';
import { counterRow, membershipRow, todoRow } from './support/todo-app/rows.ts';
import { counters, memberships, todos } from './support/todo-app/schema.ts';
import { FILTER, PANELS } from './support/todo-app/workspace.ts';

/**
 * The test application of Drizzle in D1, run by an engine: what its
 * pages render of the seed, how its bound fields and its operations write, and what the engine
 * tells of a write — each where it differs from the application of kept tables, which these hold.
 */

const PAGE = { filter: 'all', projectId: 'p1', selectedId: 't1' } as const;

interface Opened {
  readonly engine: Engine;
  readonly alice: string;
  readonly bob: string;
  /** Carol: a user of no project. */
  readonly carol: string;
  readonly commits: CommitEvent[];
}

async function open(options: Parameters<typeof opened>[0] = {}): Promise<Opened> {
  const engine = await opened(options);
  const commits: CommitEvent[] = [];
  engine.onCommit((event) => {
    commits.push(event);
  });
  const [alice, bob, carol] = await Promise.all(
    ['alice', 'bob', 'carol'].map(async (user) => (await engine.login(user)).sessionId),
  );
  if (alice === undefined || bob === undefined || carol === undefined)
    throw new Error('No session.');
  return { alice, bob, carol, commits, engine };
}

async function render(
  engine: Engine,
  session: string,
  component = 'components/project',
  props: Readonly<Record<string, Json>> = PAGE,
): Promise<RenderResult> {
  return engine.render(session, { build: BUILD, component, props });
}

/** The binding `component` writes `key` with, where the tree renders it once. */
function bindingOf(rendered: RenderResult, component: string, key: string): string {
  const state = clientOf(rendered.tree, component).part.states[key];
  if (state === undefined || !('binding' in state)) throw new Error(`No binding of ${key}.`);
  return state.binding;
}

/** A server operation of the session's, of `actions/todos` unless another module is named. */
async function operate(
  engine: Engine,
  session: string,
  call: {
    readonly name: string;
    readonly args: readonly OperationArgument[];
    readonly module?: string;
  },
) {
  const { args, module = 'actions/todos', name } = call;
  const operationId = crypto.randomUUID();
  return engine.operate(session, { args, build: BUILD, module, name, operationId });
}

/** What a bound write sends beside its binding: a value, or what its update captures. */
type Written = Readonly<{ value?: Value; captures?: Readonly<Record<string, Json>> }>;

/** A bound write of the session's, of `updaterId`. */
async function write(
  engine: Engine,
  session: string,
  binding: string,
  input: Written & { readonly updaterId: string },
) {
  return engine.update(session, { binding, operationId: crypto.randomUUID(), ...input });
}

/** A write of the title, of `length` emoji: as many code points, and twice as many UTF-16 units. */
function emojiTitle(length: number) {
  return { updaterId: SET_TITLE, value: '😀'.repeat(length) };
}

/** The first to-do of the seed, as the database holds it now. */
async function firstTodo() {
  return (await orm.select().from(todos).where(eq(todos.id, 't1')))[0];
}

describe('the test application of Drizzle in D1, in an engine', () => {
  it('renders the project page of the seed, its fields keyed by the rows they bind', async () => {
    const { alice, commits, engine } = await open();

    const rendered = await render(engine, alice);

    expect(textOf(rendered.tree)).toContain('確定した集計: 未完了 2 件 / 完了 0 件');
    expect(clientsIn(rendered.tree, 'components/todo-row').map((row) => row.key)).toStrictEqual([
      't1',
      't2',
    ]);
    expect(rendered.frame.fields).toStrictEqual({
      [fieldKey(membershipRow('p1', 'p1-bob').canEdit)]: true,
      [fieldKey(todoRow('p1', 't1').completed)]: false,
      [fieldKey(todoRow('p1', 't1').estimate)]: 2,
      [fieldKey(todoRow('p1', 't1').title)]: '一覧を作る',
      [fieldKey(todoRow('p1', 't2').completed)]: false,
      [fieldKey(todoRow('p1', 't2').estimate)]: 3,
      [fieldKey(todoRow('p1', 't2').title)]: '同期を確認する',
    });
    // Of a digest of the row's condition, not of its id.
    expect(fieldKey(todoRow('p1', 't1').title)).toMatch(/^todos:[\da-f]{64}:title$/u);
    // The first read of the log, as the engine was opened, began its epoch: a commit of its own.
    expect(rendered.frame.revision).toBe(1);
    expect(commits).toStrictEqual([]);
  });

  it('renders the composed pages of the second and third versions', async () => {
    const { alice, engine } = await open();

    const composed = await render(engine, alice, 'components/workspace-project');
    const panels = await render(engine, alice, 'components/panels-project');

    expect(textOf(composed.tree)).toContain('確定した集計: 未完了 2 件 / 完了 0 件');
    expect(textOf(composed.tree)).toContain('表示中の一覧: all / 2 件');
    expect(clientOf(panels.tree, 'components/panels-workspace').part.states).toMatchObject({
      [FILTER]: { value: 'all' },
      [PANELS]: { value: [{ panelId: 'initial:t1', todoId: 't1' }] },
    });
  });

  it.each([
    {
      what: 'the title',
      key: 'title',
      sent: { updaterId: SET_TITLE, value: 'Renamed' },
      written: { title: 'Renamed' },
    },
    {
      what: 'completion',
      key: 'completed',
      sent: { updaterId: SET_COMPLETED, value: true },
      written: { completed: true },
    },
    {
      what: 'the estimate',
      key: 'useEstimate#0.estimate',
      sent: { captures: { step: 5 }, updaterId: ADD_ESTIMATE },
      written: { estimate: 7 },
    },
  ])('writes $what of the editor as the row', async ({ key, sent, written }) => {
    const { alice, engine } = await open();
    const binding = bindingOf(await render(engine, alice), 'components/todo-editor', key);

    await write(engine, alice, binding, sent);

    await expect(firstTodo()).resolves.toMatchObject(written);
  });

  it('writes a membership and a counter, each as its row', async () => {
    const { alice, engine } = await open();
    const member = bindingOf(await render(engine, alice), 'components/member-editor', 'canEdit');
    const counted = await render(engine, alice, 'components/counter', { id: 'main' });
    const count = bindingOf(counted, 'components/counter', 'count');

    await write(engine, alice, member, { updaterId: SET_CAN_EDIT, value: false });
    await write(engine, alice, count, { captures: { by: 3 }, updaterId: INCREMENT });
    await write(engine, alice, count, { updaterId: SET_COUNT, value: -4 });

    await expect(
      orm.select().from(memberships).where(eq(memberships.id, 'p1-bob')),
    ).resolves.toMatchObject([{ canEdit: false }]);
    await expect(orm.select().from(counters).where(eq(counters.id, 'main'))).resolves.toMatchObject(
      [{ count: -4 }],
    );
    expect(counted.frame.fields).toStrictEqual({ [fieldKey(counterRow('main').count)]: 0 });
  });

  it('commits a bound write of its own, and again as the log tells of it', async () => {
    const { alice, commits, engine } = await open();
    const binding = bindingOf(await render(engine, alice), 'components/todo-editor', 'title');

    const receipt = await engine.update(alice, {
      binding,
      operationId: 'write-title',
      updaterId: SET_TITLE,
      value: 'Renamed',
    });

    expect(receipt).toStrictEqual({
      committedRevision: 2,
      deduplicated: false,
      operationId: 'write-title',
    });
    // Each a change of a row of the table, not of the record's id.
    expect(commits.map((event) => [event.revision, event.changed])).toStrictEqual([
      [2, ['todos:row']],
      [3, ['todos:row']],
    ]);
  });

  it('refuses a bound value the database takes not, as the field’s range did', async () => {
    const { alice, engine } = await open();
    const binding = bindingOf(await render(engine, alice), 'components/todo-editor', 'title');
    const value = 'x'.repeat(201);

    await expect(
      write(engine, alice, binding, { updaterId: SET_TITLE, value }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE', status: 422 });
  });

  it('takes a bound title of 200 emoji, and refuses one of 201: a length in code points', async () => {
    const { alice, engine } = await open();
    const binding = bindingOf(await render(engine, alice), 'components/todo-editor', 'title');

    await expect(write(engine, alice, binding, emojiTitle(200))).resolves.toMatchObject({
      deduplicated: false,
    });
    await expect(firstTodo()).resolves.toMatchObject({ title: '😀'.repeat(200) });
    await expect(write(engine, alice, binding, emojiTitle(201))).rejects.toMatchObject({
      code: 'INVALID_VALUE',
      status: 422,
    });
  });

  it('refuses a second engine of a database of its own in one test, naming `reopened()`', async () => {
    await open();

    await expect(opened()).rejects.toThrow('give another engine over it (`reopened()` on Node)');
  });

  it('refuses a bound write of a row deleted since it was rendered', async () => {
    const { alice, engine } = await open();
    const binding = bindingOf(await render(engine, alice), 'components/todo-editor', 'title');
    await orm.delete(todos).where(eq(todos.id, 't1'));

    await expect(
      write(engine, alice, binding, { updaterId: SET_TITLE, value: 'Gone' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
  });

  it('answers an operation of no revision, its writes told as the log is read before it answers', async () => {
    const { alice, commits, engine } = await open();

    const receipt = await operate(engine, alice, {
      args: [{ json: 'p1' }, { form: [['title', 'Made']] }],
      name: 'createTodo',
    });
    const made = await orm.select().from(todos).where(eq(todos.title, 'Made'));

    expect(receipt).toMatchObject({ committedRevision: null, result: null });
    // Its id, the operation's own: a UUID, where the authority made one of its own before.
    expect(made).toMatchObject([{ id: expect.stringMatching(/^[\da-f-]{36}$/u), projectId: 'p1' }]);
    expect(commits.map((event) => event.changed)).toStrictEqual([['todos:row']]);
  });

  it.each([
    ['a to-do in a project she may not edit', 'alice', 'createTodo', ['p3', { title: 'Made' }]],
    ['another project’s to-do', 'carol', 'deleteTodo', ['p1', 't1']],
    ['a to-do there is not', 'alice', 'deleteTodo', ['p1', 'gone']],
    [
      'a to-do into a project she may not edit',
      'alice',
      'moveTodo',
      ['p1', 't1', { targetProjectId: 'p3' }],
    ],
    ['a project she may not edit complete', 'carol', 'completeProject', ['p1']],
  ] as const)('forbids making %s, and writes nothing', async (_, user, name, args) => {
    const app = await open();
    const sent = args.map((arg): OperationArgument =>
      typeof arg === 'string' ? { json: arg } : { form: Object.entries(arg) },
    );
    const before = await orm.select().from(todos);

    await expect(operate(app.engine, app[user], { args: sent, name })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(orm.select().from(todos)).resolves.toStrictEqual(before);
  });

  it('completes a project of none open, which writes no row', async () => {
    const { alice, engine } = await open();
    await orm.update(todos).set({ completed: true }).where(eq(todos.projectId, 'p1'));

    await expect(
      operate(engine, alice, { args: [{ json: 'p1' }], name: 'completeProject' }),
    ).resolves.toMatchObject({ result: null });
  });

  it('rejects an operation whose write the database refuses, a range’s or a unique index’s', async () => {
    const { alice, engine } = await open({
      operations: {
        ...application.operations,
        'test/refused': {
          estimate: async () => {
            await orm.update(todos).set({ estimate: -1 }).where(eq(todos.id, 't1'));
          },
          member: async () => {
            await orm.insert(memberships).values({ id: 'again', projectId: 'p1', userId: 'bob' });
          },
        },
      },
    });

    for (const name of ['estimate', 'member']) {
      await expect(
        operate(engine, alice, { args: [], module: 'test/refused', name }),
      ).rejects.toMatchObject({
        code: 'OPERATION_REJECTED',
        status: 422,
      });
    }

    await expect(firstTodo()).resolves.toMatchObject({ estimate: 2 });
  });

  it('renders again what read a row written behind its back, once the log is read', async () => {
    const { alice, engine } = await open();
    await render(engine, alice);
    const t1 = and(eq(todos.id, 't1'), eq(todos.projectId, 'p1'));
    await orm.update(todos).set({ title: 'Written apart' }).where(t1);

    const before = await render(engine, alice);
    await engine.poke();
    const after = await render(engine, alice);

    // Until the log is read, the render the engine holds is the one it answers.
    expect(before.frame.fields[fieldKey(todoRow('p1', 't1').title)]).toBe('一覧を作る');
    expect(after.frame.fields[fieldKey(todoRow('p1', 't1').title)]).toBe('Written apart');
  });
});
