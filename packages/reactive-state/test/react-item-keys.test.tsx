// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientPart } from '../src/program.ts';
import { localOf, useReactiveState, useSites } from '../src/react/index.tsx';

const PART: ClientPart<ReactNode> = {
  instance: 'item-key-boundaries',
  props: {},
  slots: {},
  states: { selectedKey: { value: 'kept' } },
  sites: {
    row: {
      inputs: {},
      items: [
        'kept',
        '7',
        '0',
        'constructor',
        '__proto__',
        'false',
        'null',
        'undefined',
        'NaN',
        'Infinity',
        'Symbol(key)',
      ].map((key) => {
        return {
          content: <span data-testid="row">{key}</span>,
          item: { label: 'row' },
          key,
        };
      }),
    },
    neighbor: {
      inputs: {},
      items: [{ key: 'neighbor', item: null, content: <span data-testid="neighbor">kept</span> }],
    },
  },
};

/** A site's error is caught after its parent's JSX has already constructed the child element. */
class Boundary extends Component<
  { readonly name: string; readonly children?: ReactNode },
  { readonly error: Error | null }
> {
  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override state = { error: null as Error | null };

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? (
      this.props.children
    ) : (
      <p data-testid={`${this.props.name}-boundary`}>{error.message}</p>
    );
  }
}

/** Untyped data enters a local state after the valid authority-started item was rendered. */
function LocalList({ incoming }: { readonly incoming: unknown }): ReactNode {
  const [key, setKey] = useReactiveState(localOf(PART, 'selectedKey'));
  const sites = useSites(PART);
  const item = sites.item('row', {}, { item: { label: 'row' }, key: key as never });
  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setKey(() => incoming);
        }}
      >
        change
      </button>
      <p data-testid="parent">kept</p>
      <Boundary name="item">{item}</Boundary>
      {sites.item('neighbor', {}, { item: null, key: 'neighbor' })}
    </section>
  );
}

describe('runtime-invalid local list keys', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    { name: 'a null-prototype object', make: (): unknown => Object.create(null) },
    {
      name: 'a throwing primitive-conversion object',
      make: (): unknown => {
        return {
          [Symbol.toPrimitive]() {
            throw new Error('key conversion must remain inside the item');
          },
        };
      },
    },
    { name: 'a boolean', make: (): unknown => false },
    { name: 'null', make: (): unknown => null },
    { name: 'undefined', make: (): unknown => undefined },
    { name: 'NaN', make: (): unknown => NaN },
    { name: 'Infinity', make: (): unknown => Infinity },
    { name: 'a symbol', make: (): unknown => Symbol('key') },
  ])('contains $name in the nearest item boundary', ({ make }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      // React reports errors caught by the application's boundary.
    });
    render(
      <Boundary name="root">
        <LocalList incoming={make()} />
      </Boundary>,
    );

    expect(screen.getByTestId('row').textContent).toBe('kept');

    fireEvent.click(screen.getByRole('button', { name: 'change' }));

    expect(screen.queryByTestId('root-boundary')).toBeNull();
    expect(screen.getByTestId('parent').textContent).toBe('kept');
    expect(screen.getByTestId('neighbor').textContent).toBe('kept');
    expect(screen.getByTestId('item-boundary').textContent).toBe(
      'An item of the list row has no key of text or a number.',
    );
  });

  it.each([
    { key: 'kept', text: 'kept' },
    { key: 7, text: '7' },
    { key: -0, text: '0' },
    { key: 'constructor', text: 'constructor' },
    { key: '__proto__', text: '__proto__' },
  ])('keeps the valid key $text', ({ key, text }) => {
    render(
      <Boundary name="root">
        <LocalList incoming={key} />
      </Boundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'change' }));

    expect(screen.getByTestId('row').textContent).toBe(text);
    expect(screen.getByTestId('neighbor').textContent).toBe('kept');
    expect(screen.queryByTestId('item-boundary')).toBeNull();
    expect(screen.queryByTestId('root-boundary')).toBeNull();
  });
});
