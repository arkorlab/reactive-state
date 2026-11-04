import {
  actionRef,
  type ComponentProgram,
  componentRef,
  type Json,
  moduleRef,
  type OperationModule,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../../src/program.ts';
import * as todos from './app/actions/todos.ts';
import { requireUser } from './app/auth.ts';
import { db } from './app/db.ts';
import { addEstimate } from './app/input.ts';
import {
  assertCanEditProject,
  assertCanEditTodo,
  assertCanManageMembership,
  assertCanReadTodo,
  requireProjectAccess,
} from './app/permissions.ts';
import { panelsPrograms } from './workspace-v3.ts';
import { workspacePrograms } from './workspace.ts';

/**
 * The test application's programs, as a compile writes them for the project fixture's components
 * (its `src/components`) — by hand, under fixed updater ids, so that the authority's suites neither
 * run a compile nor depend on the ids a compile hashes — and a counter, whose count a page without
 * a session shows. `compiler.test.ts` holds the compiled programs to the same behaviour.
 */

export const BUILD = 'b_test';

/** TodoEditor's text input and checkbox, each a setter passed on. */
export const SET_TITLE = 'u_set_title';
export const SET_COMPLETED = 'u_set_completed';
/** `useEstimate`'s update of the estimate: `current => addEstimate(current, step)`. */
export const ADD_ESTIMATE = 'u_add_estimate';
/** MemberEditor's checkbox. */
export const SET_CAN_EDIT = 'u_set_can_edit';
/** The counter's updates. */
export const INCREMENT = 'u_increment';
export const SET_COUNT = 'u_set_count';

type TodoFilter = 'active' | 'all' | 'done';

const Link = moduleRef('next/link', 'default');
const TodoList = componentRef('components/todo-list');
const TodoRow = componentRef('components/todo-row');
const TodoDetails = componentRef('components/todo-details');
const TodoEditor = componentRef('components/todo-editor');
const TodoReadOnly = componentRef('components/todo-readonly');
const TodoCommands = componentRef('components/todo-commands');
const ProjectCommands = componentRef('components/project-commands');
const MemberEditor = componentRef('components/member-editor');
const createTodo = actionRef('actions/todos', 'createTodo');
const completeProject = actionRef('actions/todos', 'completeProject');
const deleteTodo = actionRef('actions/todos', 'deleteTodo');
const moveTodo = actionRef('actions/todos', 'moveTodo');

function projectHref(projectId: string, filter: TodoFilter, selectedId?: string): string {
  const query = new URLSearchParams({ filter });
  if (selectedId !== undefined) query.set('todo', selectedId);
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

/** A program of the test build, with no state unless given. */
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

/** A prop a component is rendered with, as the text it is. */
function textOf(props: Readonly<Record<string, Json>>, name: string): string {
  const value = props[name];
  if (typeof value !== 'string') {
    throw new TypeError(`\`${name}\` is text.`);
  }
  return value;
}

/** The props of a component of one record of a project's: the project's id, and the record's. */
function recordOf(props: Readonly<Record<string, Json>>): {
  readonly id: string;
  readonly projectId: string;
} {
  return { id: textOf(props, 'id'), projectId: textOf(props, 'projectId') };
}

const projectProgram = program('components/project', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const filter = textOf(props, 'filter') as TodoFilter;
  const selectedId = typeof props['selectedId'] === 'string' ? props['selectedId'] : undefined;
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);
  const where = filter === 'all' ? { projectId } : { projectId, completed: filter === 'done' };
  const found = await db.todos.findMany({
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: { id: true },
    where,
  });
  const remaining = await db.todos.count({ where: { completed: false, projectId } });
  const completed = await db.todos.count({ where: { completed: true, projectId } });
  const memberships = access.canManageMembers
    ? await db.memberships.findMany({ orderBy: [{ id: 'asc' }], where: { projectId } })
    : [];
  const all = $.h(Link, { href: projectHref(projectId, 'all', selectedId) }, 'すべて');
  const done = $.h(Link, { href: projectHref(projectId, 'done', selectedId) }, '完了');
  return $.h(
    'main',
    null,
    $.h('h2', null, access.project.title),
    $.h(
      'p',
      { 'data-testid': 'totals' },
      '確定した集計: 未完了 ',
      remaining,
      ' 件 / 完了 ',
      completed,
      ' 件',
    ),
    $.h('nav', { 'aria-label': '絞り込み' }, all, done),
    access.canEdit && $.h(ProjectCommands, { projectId }),
    $.h(TodoList, { filter, ids: found.map((todo) => todo.id), projectId }),
    selectedId !== undefined && $.h(TodoDetails, { id: selectedId, projectId }),
    access.canManageMembers &&
      $.h(
        'aside',
        null,
        memberships.map((membership) =>
          $.h(MemberEditor, { id: membership.id, key: membership.id, projectId }),
        ),
      ),
  );
});

const todoListProgram = program('components/todo-list', (props, $) => {
  const projectId = textOf(props, 'projectId');
  const filter = textOf(props, 'filter');
  const ids = props['ids'] as readonly string[];
  return ids.length === 0
    ? $.h('p', { 'data-testid': 'empty-list' }, '該当する Todo はありません。')
    : $.h(
        'ul',
        null,
        ids.map((id) => $.h(TodoRow, { filter, id, key: id, projectId })),
      );
});

const todoRowProgram = program('components/todo-row', async (props, $) => {
  const { id, projectId } = recordOf(props);
  const filter = textOf(props, 'filter');
  const user = await requireUser();
  await assertCanReadTodo(user, projectId, id);
  const ref = db.todos.ref(id);
  return $.client({
    props: { filter, id, projectId },
    slots: {},
    states: { completed: ref.completed, estimate: ref.estimate, title: ref.title },
  });
});

const todoDetailsProgram = program('components/todo-details', async (props, $) => {
  const { id, projectId } = recordOf(props);
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);
  const todo = await db.todos.get(id);
  if (todo?.projectId !== projectId) {
    return $.h('p', { role: 'status' }, '選択した Todo は削除または移動されました。');
  }
  return access.canEdit
    ? $.h(TodoEditor, { id, key: id, projectId })
    : $.h(TodoReadOnly, { id, key: id, projectId });
});

const todoEditorProgram = program(
  'components/todo-editor',
  async (props, $) => {
    const { id, projectId } = recordOf(props);
    const user = await requireUser();
    await assertCanEditTodo(user, projectId, id);
    const ref = db.todos.ref(id);
    return $.client({
      props: {},
      slots: { s0: $.h(TodoCommands, { id, projectId }) },
      states: {
        completed: ref.completed,
        draft: '',
        title: ref.title,
        'useEstimate#0.estimate': ref.estimate,
      },
    });
  },
  {
    updaters: Object.freeze({
      [ADD_ESTIMATE]: {
        apply: (current: number, { step }: { readonly step: number }): number =>
          addEstimate(current, step),
        keys: ['useEstimate#0.estimate'],
        kind: 'apply',
      },
      [SET_COMPLETED]: { keys: ['completed'], kind: 'set' },
      [SET_TITLE]: { keys: ['title'], kind: 'set' },
    }),
    writable: ['title', 'completed', 'useEstimate#0.estimate'],
  },
);

const todoReadOnlyProgram = program('components/todo-readonly', async (props, $) => {
  const { id, projectId } = recordOf(props);
  const user = await requireUser();
  await assertCanReadTodo(user, projectId, id);
  const ref = db.todos.ref(id);
  return $.client({
    props: {},
    slots: {},
    states: { completed: ref.completed, estimate: ref.estimate, title: ref.title },
  });
});

const todoCommandsProgram = program('components/todo-commands', async (props, $) => {
  const { id, projectId } = recordOf(props);
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);
  return $.h(
    'div',
    null,
    $.h(
      'form',
      { action: deleteTodo.bind(null, projectId, id) },
      $.h('button', { type: 'submit' }, '削除'),
    ),
    $.h(
      'form',
      { action: moveTodo.bind(null, projectId, id) },
      $.h('input', { maxLength: 64, name: 'targetProjectId', required: true }),
      $.h('button', { type: 'submit' }, '移動'),
    ),
  );
});

const projectCommandsProgram = program('components/project-commands', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const user = await requireUser();
  await assertCanEditProject(user, projectId);
  return $.h(
    'section',
    null,
    $.h('form', { action: createTodo.bind(null, projectId) }, $.h('input', { name: 'title' })),
    $.h(
      'form',
      { action: completeProject.bind(null, projectId) },
      $.h('button', null, 'すべて完了にする'),
    ),
  );
});

const memberEditorProgram = program(
  'components/member-editor',
  async (props, $) => {
    const { id, projectId } = recordOf(props);
    const user = await requireUser();
    await assertCanManageMembership(user, projectId, id);
    return $.client({
      props: { id },
      slots: {},
      states: { canEdit: db.memberships.ref(id).canEdit },
    });
  },
  {
    updaters: Object.freeze({ [SET_CAN_EDIT]: { keys: ['canEdit'], kind: 'set' } }),
    writable: ['canEdit'],
  },
);

/** A counter anyone signed in may count, and whose count a page without a session shows. */
export const counterProgram = program(
  'components/counter',
  async (props, $) => {
    const id = textOf(props, 'id');
    await requireUser();
    return $.client({
      props: { id },
      slots: {},
      states: { count: db.counters.ref(id).count, step: 1 },
    });
  },
  {
    updaters: Object.freeze({
      [INCREMENT]: {
        apply: (count: number, { by = 1 }: { readonly by?: number }): number => count + by,
        keys: ['count'],
        kind: 'apply',
      },
      [SET_COUNT]: { keys: ['count'], kind: 'set' },
    }),
    writable: ['count'],
  },
);

/** Every program of the test application, as an authority is given them. */
export const programs: readonly ComponentProgram[] = [
  projectProgram,
  todoListProgram,
  todoRowProgram,
  todoDetailsProgram,
  todoEditorProgram,
  todoReadOnlyProgram,
  todoCommandsProgram,
  projectCommandsProgram,
  memberEditorProgram,
  counterProgram,
  ...workspacePrograms,
  ...panelsPrograms,
];

/** Every server operation module of the test application, by its id. */
export const operations: Readonly<Record<string, OperationModule>> = { 'actions/todos': todos };

/** The test application, as a compile's `authority.mts` hands it to an authority. */
export const application = { buildId: BUILD, database: db, operations, programs } as const;
