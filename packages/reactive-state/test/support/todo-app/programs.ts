import {
  actionRef,
  type ComponentProgram,
  componentRef,
  type Json,
  moduleRef,
  type OperationModule,
} from '../../../src/program.ts';
import { requireUser } from '../../../src/server/index.ts';
import * as prepared from './actions/prepared.ts';
import * as session from './actions/session.ts';
import * as todos from './actions/todos.ts';
import { BUILD, program, textOf } from './build.ts';
import { db } from './db.ts';
import { addEstimate } from './input.ts';
import {
  assertCanEditProject,
  assertCanEditTodo,
  assertCanManageMembership,
  assertCanReadTodo,
  requireProjectAccess,
} from './permissions.ts';
import { membershipIdsOf, projectOfTodo, todoIdsOf, totalsOf } from './reads.ts';
import { counterRow, membershipRow, todoRow } from './rows.ts';
import { panelsPrograms, workspacePrograms } from './workspace.ts';

/**
 * The test application's programs, of its Drizzle in D1, as `test/support/program.ts` writes them
 * of the tables the authority keeps — by hand, under the same build and updater ids: the project
 * fixture's components and a counter. A read is a statement of the application's Drizzle, which the
 * authority notes the rows of; a state binds a row's column (`rows.ts`); the project's two totals
 * are one statement, as a render reads no snapshot across two.
 */

export { BUILD } from './build.ts';

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
  const ids = await todoIdsOf(projectId, filter);
  const { completed, remaining } = await totalsOf(projectId);
  const members = access.canManageMembers ? await membershipIdsOf(projectId) : [];
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
    $.h(TodoList, { filter, ids, projectId }),
    selectedId !== undefined && $.h(TodoDetails, { id: selectedId, projectId }),
    access.canManageMembers &&
      $.h(
        'aside',
        null,
        members.map((id) => $.h(MemberEditor, { id, key: id, projectId })),
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
  const row = todoRow(projectId, id);
  return $.client({
    props: { filter, id, projectId },
    slots: {},
    states: { completed: row.completed, estimate: row.estimate, title: row.title },
  });
});

const todoDetailsProgram = program('components/todo-details', async (props, $) => {
  const { id, projectId } = recordOf(props);
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);
  if ((await projectOfTodo(id)) !== projectId) {
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
    const row = todoRow(projectId, id);
    return $.client({
      props: {},
      slots: { s0: $.h(TodoCommands, { id, projectId }) },
      states: {
        completed: row.completed,
        draft: '',
        title: row.title,
        'useEstimate#0.estimate': row.estimate,
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
  const row = todoRow(projectId, id);
  return $.client({
    props: {},
    slots: {},
    states: { completed: row.completed, estimate: row.estimate, title: row.title },
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
      states: { canEdit: membershipRow(projectId, id).canEdit },
    });
  },
  {
    updaters: Object.freeze({ [SET_CAN_EDIT]: { keys: ['canEdit'], kind: 'set' } }),
    writable: ['canEdit'],
  },
);

/** A counter anyone signed in may count. */
const counterProgram = program(
  'components/counter',
  async (props, $) => {
    const id = textOf(props, 'id');
    await requireUser();
    return $.client({
      props: { id },
      slots: {},
      states: { count: counterRow(id).count, step: 1 },
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
const programs: readonly ComponentProgram[] = [
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
const operations: Readonly<Record<string, OperationModule>> = {
  'actions/prepared': prepared,
  'actions/session': session,
  'actions/todos': todos,
};

/** The test application, as a compile's `authority.mts` hands it to an authority. */
export const application = { buildId: BUILD, database: db, operations, programs } as const;
