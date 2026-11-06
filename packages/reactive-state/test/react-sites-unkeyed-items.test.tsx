// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientPart } from '../src/program.ts';
import { useSites } from '../src/react/sites.tsx';

const PART: ClientPart<ReactNode> = {
  instance: 'unkeyed-items',
  props: {},
  slots: {},
  states: {},
  sites: {
    row: {
      inputs: {},
      items: [{ content: <span data-testid="row">kept</span>, item: null, key: 'kept' }],
    },
  },
};

const NO_KEY = 'An item of the list row has no key of text or a number.';

/** What catches the error an item of no key fails with, around the whole list. */
class Boundary extends Component<
  { readonly children?: ReactNode },
  { readonly error: Error | null }
> {
  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override state = { error: null as Error | null };

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : <p data-testid="boundary">{error.message}</p>;
  }
}

/** A list the part's `.map()` keys by what each of `keys` is, as the compiled JSX names its items. */
function List({ keys }: { readonly keys: readonly unknown[] }): ReactNode {
  const sites = useSites(PART);
  return <ul>{keys.map((key) => sites.item('row', {}, { item: null, key: key as never }))}</ul>;
}

/** What React reported, of what `console.error` was called with, of two siblings of one key. */
function repeatedKeys(calls: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  return calls.filter(([message]) =>
    String(message).startsWith('Encountered two children with the same key'),
  );
}

/**
 * Each item of a list whose key is no text nor a number fails where it stands; several of them, in
 * one list, are siblings all the same, which React keeps apart by their keys.
 */
describe('items of a list of no key', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('are keyed apart, so React is shown no two siblings of one key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // React reports the error the boundary caught.
    });
    render(
      <Boundary>
        <List keys={['kept', undefined, null, NaN]} />
      </Boundary>,
    );

    expect(screen.getByTestId('boundary').textContent).toBe(NO_KEY);
    expect(repeatedKeys(errors.mock.calls)).toStrictEqual([]);
  });
});
