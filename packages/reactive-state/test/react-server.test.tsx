import { type ReactNode, Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Elements, renderTree } from '../src/next/render.ts';
import type { ClientPart, Frame, Json, Rendered, RenderedItem } from '../src/program.ts';
import {
  type ClientPartProps,
  LiveRoot,
  slotOf,
  stateOf,
  useReactiveState,
  useReactiveStatus,
  useSites,
} from '../src/react/index.tsx';
import { BUILD, frameAt, projectTree } from './support/page.ts';

/**
 * The browser's half as the server renders it into a page — a Client Component rendered to HTML —
 * where nothing is followed or written, and no state of one request may outlive it.
 */

vi.mock(import('next/navigation'), () => ({ useRouter: () => ({ refresh: vi.fn() }) as never }));

function TodoRow({ part }: ClientPartProps): ReactNode {
  const [title] = useReactiveState(stateOf<string>(part, 'title'));
  return <li>{title}</li>;
}

function TodoEditor({ part }: ClientPartProps): ReactNode {
  const [title] = useReactiveState(stateOf<string>(part, 'title'));
  const [estimate] = useReactiveState(stateOf<number>(part, 'useEstimate#0.estimate'));
  return (
    <section>
      <input aria-label="タイトル" readOnly value={title} />
      {`見積もり ${String(estimate)}`}
      {slotOf(part, 's0')}
    </section>
  );
}

const ELEMENTS: Elements = {
  actions: {},
  build: BUILD,
  clients: { 'components/todo-editor': TodoEditor, 'components/todo-row': TodoRow },
  modules: {},
};

const FRAME = frameAt(4, {
  'todos:t1:completed': false,
  'todos:t1:estimate': 2,
  'todos:t1:title': 'Plan',
  'todos:t2:completed': true,
  'todos:t2:title': 'Sync',
});

function Status(): ReactNode {
  return `${String(useReactiveStatus().pending)} pending`;
}

/** A part whose filter picks what the authority renders at its site `d0`, as compiled. */
function Workspace({ part }: ClientPartProps): ReactNode {
  const [filter] = useReactiveState(stateOf<string>(part, 'filter'));
  const sites = useSites(part);
  return (
    <section>
      <output>{`filter ${filter}`}</output>
      <Suspense fallback={<p>loading</p>}>{sites.of('d0', { filter })}</Suspense>
    </section>
  );
}

/** The workspace, its filter starting from `first`, its site rendered for the filter `all`. */
function workspaceOf(first: string): Rendered {
  return {
    component: 'components/workspace',
    key: null,
    kind: 'client',
    part: {
      instance: 'instance:workspace',
      props: {},
      sites: {
        d0: {
          content: {
            children: ['the list for all'],
            key: null,
            kind: 'element',
            props: {},
            type: 'p',
          },
          inputs: { filter: 'all' },
        },
      },
      slots: {},
      states: { filter: { value: first } },
    },
  };
}

/** A panel the page holds open: its own id, and the to-do it shows. */
interface Panel {
  readonly panelId: string;
  readonly todoId: string;
}

/** A part of the detail of each panel it holds open: a list site, keyed by the panel. */
function Panels({ part }: ClientPartProps): ReactNode {
  const [panels] = useReactiveState(stateOf<readonly Panel[]>(part, 'panels'));
  const sites = useSites(part);
  const cards = panels.map((panel) => {
    return (
      <article data-panel-id={panel.panelId} key={panel.panelId}>
        {sites.item('d0', { panels }, { item: panel, key: panel.panelId })}
      </article>
    );
  });
  return (
    <section>
      <Suspense fallback={<p>loading</p>}>{cards}</Suspense>
    </section>
  );
}

/** The panels as JSON, as a tree carries them. */
function jsonOf(panels: readonly Panel[]): Json[] {
  return panels.map(({ panelId, todoId }) => ({ panelId, todoId }));
}

/** The detail of a to-do, as the authority renders it in a panel. */
function detailOf(todoId: string): Rendered {
  return {
    children: [`the detail of ${todoId}`],
    key: null,
    kind: 'element',
    props: {},
    type: 'p',
  };
}

/** The item of a panel, as the authority renders it: its key, the panel, and the detail of its to-do. */
function itemOf({ panelId, todoId }: Panel): RenderedItem {
  return { content: detailOf(todoId), item: { panelId, todoId }, key: panelId };
}

/** The panels, starting from `first`, their list rendered for `rendered`, each item's detail of its to-do. */
function panelsOf(first: readonly Panel[], rendered: readonly Panel[]): Rendered {
  const items = rendered.map((panel) => itemOf(panel));
  return {
    component: 'components/panels',
    key: null,
    kind: 'client',
    part: {
      instance: 'instance:panels',
      props: {},
      sites: { d0: { inputs: { panels: jsonOf(rendered) }, items } },
      slots: {},
      states: { panels: { value: jsonOf(first) } },
    },
  };
}

function workspacePage(frame: Frame, tree: Rendered): ReactNode {
  return (
    <LiveRoot
      events="/api/reactive-state/events"
      frame={frame}
      update={() => Promise.reject(new Error('Nothing is written on the server.'))}
      view={() => Promise.reject(new Error('Nothing is asked for on the server.'))}
    >
      {renderTree(tree, {
        ...ELEMENTS,
        clients: { 'components/panels': Panels, 'components/workspace': Workspace },
      })}
    </LiveRoot>
  );
}

describe('a root, rendered on the server', () => {
  it('renders the tree with its frame’s values, and makes no page store', () => {
    const html = renderToString(
      <LiveRoot
        events="/api/reactive-state/events"
        frame={FRAME}
        update={() => Promise.reject(new Error('Nothing is written on the server.'))}
        view={() => Promise.reject(new Error('Nothing is asked for on the server.'))}
      >
        {renderTree(projectTree(['t1', 't2'], 't1'), ELEMENTS)}
        <Status />
      </LiveRoot>,
    );

    expect(html).toContain('<li>Plan</li><li>Sync</li>');
    expect(html).toContain('value="Plan"');
    expect(html).toContain('見積もり 2');
    expect(html).toContain('commands of t1');
    expect(html).toContain('0 pending');
    expect(html).not.toContain('data-reactive-state');
    expect(
      (globalThis as Partial<Record<symbol, unknown>>)[Symbol.for('arkorlab.reactive-state.page')],
    ).toBeUndefined();
  });

  it('refuses a persistent state rendered outside a root', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {
      // React reports what it throws; kept out of the output.
    });
    onTestFinished(() => {
      reported.mockRestore();
    });
    const part: ClientPart<ReactNode> = {
      props: {},
      slots: {},
      states: { title: { field: 'todos:t1:title' } },
    };

    expect(() => renderToString(<TodoRow part={part} />)).toThrow(/inside <LiveRoot>/u);
  });

  it('renders what the authority rendered at a site for the states’ first values, and waits for nothing', () => {
    const view = { 'instance:workspace': { d0: { filter: 'all' } } };

    const html = renderToString(workspacePage(frameAt(4, {}, { view }), workspaceOf('all')));

    expect(html).toContain('filter all');
    expect(html).toContain('the list for all');
    expect(html).not.toContain('loading');
  });

  it('leaves a site rendered for other inputs to the browser, and renders the rest of the part', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {
      // React reports the boundary it leaves to the browser; kept out of the output.
    });
    onTestFinished(() => {
      reported.mockRestore();
    });

    const html = renderToString(workspacePage(frameAt(4, {}), workspaceOf('active')));

    expect(html).toContain('filter active');
    expect(html).toContain('loading');
    expect(html).not.toContain('the list for all');
  });

  it('renders each item of a list site the authority rendered for the panels’ first values, the same to-do in two panels', () => {
    const panels = [
      { panelId: 'initial:t1', todoId: 't1' },
      { panelId: 'B', todoId: 't1' },
    ];
    const view = { 'instance:panels': { d0: { panels } } };

    const html = renderToString(workspacePage(frameAt(4, {}, { view }), panelsOf(panels, panels)));

    expect(html).toContain(
      '<article data-panel-id="initial:t1"><p>the detail of t1</p></article><article data-panel-id="B"><p>the detail of t1</p></article>',
    );
    expect(html).not.toContain('loading');
  });

  it('leaves an item rendered of another value to the browser', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {
      // React reports the boundary it leaves to the browser; kept out of the output.
    });
    onTestFinished(() => {
      reported.mockRestore();
    });
    const first = [{ panelId: 'A', todoId: 't2' }];

    const html = renderToString(
      workspacePage(frameAt(4, {}), panelsOf(first, [{ panelId: 'A', todoId: 't1' }])),
    );

    expect(html).toContain('loading');
    expect(html).not.toContain('the detail of');
  });

  it('names the state or the slot the authority rendered none of', () => {
    const part: ClientPart<ReactNode> = { props: {}, slots: {}, states: {} };

    expect(() => stateOf(part, 'title')).toThrow(/no state "title"/u);
    expect(() => slotOf(part, 's0')).toThrow(/no slot "s0"/u);
  });
});
