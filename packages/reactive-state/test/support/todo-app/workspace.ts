import {
  type ComponentProgram,
  componentRef,
  type Json,
  type RenderScope,
} from '../../../src/program.ts';
import { requireUser } from '../../../src/server/index.ts';
import { program, textOf } from './build.ts';
import { requireProjectAccess } from './permissions.ts';
import { membershipIdsOf, todoChoicesOf, todoIdsOf, totalsOf } from './reads.ts';

/**
 * The test application's composed project pages, of its Drizzle in D1, as
 * `test/support/workspace.ts` and `workspace-v3.ts` write them of the tables the authority keeps:
 * the project fixture's second version — a root that wraps its content in an access check through
 * `children`, a layout, and a workspace whose list and detail are dynamic sites, with the summary
 * in a slot (`components/workspace-project`) — and its third — the list of the filter a hook
 * holds, and a detail of each panel the page holds open (`components/panels-project`).
 */

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
const PanelsWorkspace = componentRef('components/panels-workspace');

/** A panel the page holds open: the UI's own id, and the to-do it shows. */
interface TodoPanel {
  readonly panelId: string;
  readonly todoId: string;
}

/** The key the third version's filter is kept under: its hook's state, by the hook's call. */
export const FILTER = 'useTodoFilter#0.filter';
/** The key the third version's panels are kept under. */
export const PANELS = 'useTodoPanels#0.panels';

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
  const choices = await todoChoicesOf(projectId);
  const members = access.canManageMembers ? await membershipIdsOf(projectId) : [];
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
        members.map((id) => $.h(MemberEditor, { id, key: id, projectId })),
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
  const { completed, remaining } = await totalsOf(projectId);
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
  const ids = await todoIdsOf(projectId, filter);
  return $.h(
    'section',
    { 'data-filter': filter, 'data-testid': 'results' },
    $.h('h3', null, '表示中の一覧: ', filter, ' / ', ids.length, ' 件'),
    $.h(TodoList, { filter, ids, projectId }),
  );
});

/** The application's own normalization of a filter, which the hook computes of its state. */
function normalizeFilter(value: string): string {
  return value === 'active' || value === 'done' ? value : 'all';
}

/** The panels a page opens with: one of the to-do its address selects, or none. */
function initialPanelsFor(selectedId: string): readonly TodoPanel[] {
  return selectedId === '' ? [] : [{ panelId: `initial:${selectedId}`, todoId: selectedId }];
}

/** The detail of a panel: of its to-do, keyed by the project and the to-do, as the browser keys it. */
function detailOf($: RenderScope, projectId: string, panel: TodoPanel): unknown {
  return $.h(TodoDetails, { id: panel.todoId, key: `${projectId}:${panel.todoId}`, projectId });
}

/** v3's `Project`: the access check, and the workspace of the filter and the to-do selected. */
const panelsProjectProgram = program('components/panels-project', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const selected = props['selectedId'];
  const initialSelectedId = typeof selected === 'string' ? selected : '';
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const initialFilter = textOf(props, 'filter');
  return $.h(PanelsWorkspace, {
    initialFilter,
    initialSelectedId,
    key: JSON.stringify([projectId, initialFilter, initialSelectedId]),
    projectId,
  });
});

/** v3's `ProjectWorkspace`: the list of what the hook computes, and a detail for each panel. */
const panelsWorkspaceProgram = program('components/panels-workspace', async (props, $) => {
  const projectId = textOf(props, 'projectId');
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const initialPanels = initialPanelsFor(textOf(props, 'initialSelectedId'));
  return $.client({
    props: {},
    sites: {
      d0: {
        inputs: [FILTER],
        render: (values) =>
          $.h(TodoResults, { filter: normalizeFilter(values[FILTER]), projectId }),
      },
      d1: {
        each: (values) => {
          return values[PANELS].map((panel) => {
            const render = (): unknown => detailOf($, projectId, panel);
            return { item: panel, key: panel.panelId, render };
          });
        },
        inputs: [PANELS],
      },
    },
    slots: {},
    states: { [FILTER]: textOf(props, 'initialFilter'), [PANELS]: initialPanels },
  });
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

/** v3's programs, beside v1's and v2's. */
export const panelsPrograms: readonly ComponentProgram[] = [
  panelsProjectProgram,
  panelsWorkspaceProgram,
];
