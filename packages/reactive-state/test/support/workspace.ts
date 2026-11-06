import {
  type ComponentProgram,
  componentRef,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../../src/program.ts';
import { requireUser } from './app/auth.ts';
import { db } from './app/db.ts';
import { requireProjectAccess } from './app/permissions.ts';

/**
 * The test application's composed project page, as a compile writes the programs of the project
 * fixture's second version — by hand, as `program.ts` writes the first's: a root that wraps its content in an
 * access check through `children`, a layout that renders its children, and a workspace with states
 * of its own whose list and detail are dynamic sites — the list of the filter it holds, the detail
 * of the to-do it holds selected, shown while it holds one and the detail is open — and the summary
 * it is handed as its children in a slot. Its root is `components/workspace-project`, beside v1's
 * `components/project`.
 */

const BUILD = 'b_test';

const ProjectAccess = componentRef('components/project-access');
const ProjectContent = componentRef('components/project-content');
const ProjectLayout = componentRef('components/project-layout');
const ProjectWorkspace = componentRef('components/project-workspace');
const ProjectSummary = componentRef('components/project-summary');
const TodoResults = componentRef('components/todo-results');
const TodoDetails = componentRef('components/todo-details');
const TodoList = componentRef('components/todo-list');
const ProjectCommands = componentRef('components/project-commands');
const MemberEditor = componentRef('components/member-editor');

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

function program(
  component: string,
  evaluate: (props: Readonly<Record<string, unknown>>, $: RenderScope) => unknown,
): ComponentProgram {
  return { buildId: BUILD, component, evaluate, protocolVersion: PROTOCOL_VERSION, ...STATELESS };
}

function textOf(props: Readonly<Record<string, unknown>>, name: string): string {
  const value = props[name];
  if (typeof value !== 'string') {
    throw new TypeError(`\`${name}\` is text.`);
  }
  return value;
}

/** v2's `Project`: the content, inside the access check, handed as its children. */
const workspaceProjectProgram = program('components/workspace-project', (props, $) => {
  const projectId = textOf(props, 'projectId');
  const selectedId = props['selectedId'];
  return $.h(
    ProjectAccess,
    { projectId },
    $.h(ProjectContent, {
      initialFilter: textOf(props, 'filter'),
      initialSelectedId: typeof selectedId === 'string' ? selectedId : '',
      projectId,
    }),
  );
});

const projectAccessProgram = program('components/project-access', async (props, $) => {
  const user = await requireUser();
  await requireProjectAccess(user, textOf(props, 'projectId'));
  return $.h($.fragment, null, props['children']);
});

const projectContentProgram = program('components/project-content', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const initialFilter = textOf(props, 'initialFilter');
  const initialSelectedId = textOf(props, 'initialSelectedId');
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
  return $.h(
    ProjectLayout,
    { title: access.project.title },
    $.h(
      ProjectWorkspace,
      {
        choices,
        initialFilter,
        initialSelectedId,
        key: JSON.stringify([projectId, initialFilter, initialSelectedId]),
        projectId,
      },
      $.h(ProjectSummary, { projectId }),
    ),
    access.canEdit && $.h(ProjectCommands, { projectId }),
    access.canManageMembers &&
      $.h(
        'aside',
        null,
        $.h('h3', null, 'メンバーの編集権限'),
        memberships.map((membership) =>
          $.h(MemberEditor, { id: membership.id, key: membership.id, projectId }),
        ),
      ),
  );
});

const projectLayoutProgram = program('components/project-layout', (props, $) => {
  return $.h(
    'main',
    { 'data-testid': 'project-layout' },
    $.h('h2', null, textOf(props, 'title')),
    $.h('div', null, props['children']),
  );
});

/** v2's `ProjectWorkspace`: the summary in a slot, and the list and the detail as sites. */
const projectWorkspaceProgram = program('components/project-workspace', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  return $.client({
    props: { choices: props['choices'] as Json },
    sites: {
      d0: {
        inputs: ['filter'],
        render: ({ filter }) => $.h(TodoResults, { filter, projectId }),
      },
      d1: {
        guard: ({ selectedId, showDetails }) => showDetails && selectedId !== '',
        inputs: ['selectedId', 'showDetails'],
        render: ({ selectedId }) =>
          $.h(TodoDetails, { id: selectedId, key: `${projectId}:${selectedId}`, projectId }),
      },
    },
    slots: { s0: props['children'] },
    states: {
      filter: textOf(props, 'initialFilter'),
      selectedId: textOf(props, 'initialSelectedId'),
      showDetails: true,
    },
  });
});

const projectSummaryProgram = program('components/project-summary', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const remaining = await db.todos.count({ where: { completed: false, projectId } });
  const completed = await db.todos.count({ where: { completed: true, projectId } });
  return $.h(
    'p',
    { 'data-testid': 'totals' },
    '確定した集計: 未完了 ',
    remaining,
    ' 件 / 完了 ',
    completed,
    ' 件',
  );
});

const todoResultsProgram = program('components/todo-results', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const filter = textOf(props, 'filter');
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const where = filter === 'all' ? { projectId } : { completed: filter === 'done', projectId };
  const todos = await db.todos.findMany({
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: { id: true },
    where,
  });
  return $.h(
    'section',
    { 'data-filter': filter, 'data-testid': 'results' },
    $.h('h3', null, '表示中の一覧: ', filter, ' / ', todos.length, ' 件'),
    $.h(TodoList, { filter, ids: todos.map((todo) => todo.id), projectId }),
  );
});

/** v2's programs, beside v1's: what the composed page renders that v1's page does not. */
export const workspacePrograms: readonly ComponentProgram[] = [
  workspaceProjectProgram,
  projectAccessProgram,
  projectContentProgram,
  projectLayoutProgram,
  projectWorkspaceProgram,
  projectSummaryProgram,
  todoResultsProgram,
];
