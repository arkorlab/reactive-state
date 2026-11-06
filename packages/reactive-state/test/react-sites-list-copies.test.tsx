// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientPart, Json, RenderedSite, SiteInputs } from '../src/program.ts';
import { useSites } from '../src/react/sites.tsx';
import { type Live, LiveContext } from '../src/react/state.ts';
import { ViewController, type ViewHost } from '../src/runtime/view.ts';
import { frameAt } from './support/page.ts';

/** How many times the page copied the inputs of a site as JSON: each copy is of the whole list. */
const copies = vi.hoisted(() => ({ made: 0 }));

vi.mock(import('../src/runtime/json.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    toJsonRecord: (...args: Parameters<typeof original.toJsonRecord>) => {
      copies.made += 1;
      return original.toJsonRecord(...args);
    },
  };
});

/** A panel the page holds open: its own id, and its title. */
interface Panel {
  readonly panelId: string;
  readonly title: string;
}

/** `count` panels, of titles that begin with `title`. */
function panelsOf(count: number, title = 'Panel'): readonly Panel[] {
  const ids = Array.from({ length: count }, (_, index) => String(index));
  return ids.map((id) => ({ panelId: `p${id}`, title: `${title} ${id}` }));
}

function jsonOf(panels: readonly Panel[]): Json[] {
  return panels.map(({ panelId, title }) => ({ panelId, title }));
}

/** The part as the authority rendered its two lists for `panels`: each panel's item, by its id. */
function partOf(panels: readonly Panel[]): ClientPart<ReactNode> {
  const listed = (site: string): Readonly<Record<string, RenderedSite<ReactNode>>> => {
    const items = panels.map((panel) => {
      const content = <span data-testid={site}>{panel.title}</span>;
      return { content, item: { panelId: panel.panelId, title: panel.title }, key: panel.panelId };
    });
    return { [site]: { inputs: { panels: jsonOf(panels) }, items } };
  };
  return {
    instance: 'panels',
    props: {},
    sites: { ...listed('d0'), ...listed('d1') },
    slots: {},
    states: {},
  };
}

/**
 * Two lists of one array, as the compiler writes list sites: each panel's item of each, named with
 * every panel — the array the part's `.map()` is of.
 */
function Lists({
  panels,
  part,
}: {
  readonly panels: readonly Panel[];
  readonly part: ClientPart<ReactNode>;
}): ReactNode {
  const sites = useSites(part);
  const items = panels.map((panel) => {
    return (
      <li key={panel.panelId}>
        {sites.item('d0', { panels }, { item: panel, key: panel.panelId })}
        {sites.item('d1', { panels }, { item: panel, key: panel.panelId })}
      </li>
    );
  });
  return <ul>{items}</ul>;
}

/** How many copies of the inputs one render of the lists of `count` panels makes. */
function copiesOf(count: number): number {
  const panels = panelsOf(count);
  copies.made = 0;
  render(<Lists panels={panels} part={partOf(panels)} />);
  const made = copies.made;
  cleanup();
  return made;
}

/** What the page shows of the list `site`: each item's title, in order. */
function shownOf(site: string): readonly (string | null)[] {
  return screen.getAllByTestId(site).map((item) => item.textContent);
}

/**
 * The inputs of a list site are the whole array its `.map()` is of, named again by each item: a
 * render copies them once for each list, which a long list would otherwise copy once for each of its
 * items, at a cost of the square of its length.
 */
describe('the inputs of a list site', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('are copied once for the list in a render, not once for each of its items', () => {
    expect(copiesOf(30)).toBe(copiesOf(3));
  });

  // A pin, which passes before the change as well: each render copies what it is handed.
  it('are copied anew by each render, which shows and names what it is handed', () => {
    // Never started: it asks for nothing, and is only told what the part names.
    const controller = new ViewController<ReactNode>('root:p1', {
      adopt: vi.fn<ViewHost<ReactNode>['adopt']>(),
      refresh: vi.fn<ViewHost<ReactNode>['refresh']>(),
      request: vi.fn<ViewHost<ReactNode>['request']>(),
      revoked: vi.fn<ViewHost<ReactNode>['revoked']>(),
    });
    const named: Readonly<Record<string, SiteInputs>>[] = [];
    vi.spyOn(controller, 'commit').mockImplementation((_instance, sites) => {
      named.push(sites);
    });
    const live: Live = {
      frame: frameAt(1, {}),
      send: vi.fn<Live['send']>(),
      session: undefined,
      sites: controller,
      store: null,
    };
    const first = panelsOf(2, 'First');
    const later = panelsOf(3, 'Later');
    const { rerender } = render(
      <LiveContext value={live}>
        <Lists panels={first} part={partOf(first)} />
      </LiveContext>,
    );
    rerender(
      <LiveContext value={live}>
        <Lists panels={later} part={partOf(later)} />
      </LiveContext>,
    );

    expect(shownOf('d0')).toStrictEqual(['Later 0', 'Later 1', 'Later 2']);
    expect(shownOf('d1')).toStrictEqual(['Later 0', 'Later 1', 'Later 2']);
    expect(named.at(-1)).toStrictEqual({
      d0: { panels: jsonOf(later) },
      d1: { panels: jsonOf(later) },
    });
  });
});
