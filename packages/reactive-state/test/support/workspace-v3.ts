import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../../src/program.ts';
import { requireUser } from './app/auth.ts';
import { requireProjectAccess } from './app/permissions.ts';

/**
 * The project fixture's third version's workspace, as a compile writes its program — by hand, as
 * `workspace.ts` writes the second's: the list of the filter a hook holds, of what the hook
 * computes of it (`normalizeFilter`), and the detail of each panel the page holds open, a list site
 * keyed by the panel. Its root is `components/panels-project`.
 */

const BUILD = 'b_test';

const PanelsWorkspace = componentRef('components/panels-workspace');
const TodoResults = componentRef('components/todo-results');
const TodoDetails = componentRef('components/todo-details');

/** A panel the page holds open: the UI's own id, and the to-do it shows. */
export interface TodoPanel {
  readonly panelId: string;
  readonly todoId: string;
}

/** The key the workspace's filter is kept under: its hook's state, by the hook's call. */
export const FILTER = 'useTodoFilter#0.filter';
/** The key the workspace's panels are kept under. */
export const PANELS = 'useTodoPanels#0.panels';

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

/** The application's own normalization of a filter, which the hook computes of its state. */
function normalizeFilter(value: string): string {
  return value === 'active' || value === 'done' ? value : 'all';
}

/** The panels a page opens with: one of the to-do its address selects, or none. */
function initialPanelsFor(selectedId: string): readonly TodoPanel[] {
  return selectedId === '' ? [] : [{ panelId: `initial:${selectedId}`, todoId: selectedId }];
}

/** The list of the filter the page holds, as the application normalizes it. */
function resultsOf($: RenderScope, projectId: string, filter: string): unknown {
  return $.h(TodoResults, { filter: normalizeFilter(filter), projectId });
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
        render: (values) => resultsOf($, projectId, values[FILTER]),
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

/** v3's programs, beside v1's and v2's. */
export const panelsPrograms: readonly ComponentProgram[] = [
  panelsProjectProgram,
  panelsWorkspaceProgram,
];
