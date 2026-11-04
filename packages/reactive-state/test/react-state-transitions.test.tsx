// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, StrictMode, Suspense, use } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientPart, Json } from '../src/program.ts';
import { type Live, LiveContext, localOf, stateOf, useReactiveState } from '../src/react/state.ts';
import type { ViewController } from '../src/runtime/view.ts';
import { frameAt } from './support/page.ts';

/** How often the page wrote a value as the text it sends: what comparing two values alike costs. */
const compared = vi.hoisted(() => ({ calls: 0 }));

vi.mock(import('../src/runtime/json.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    canonicalJson: (value: Parameters<typeof original.canonicalJson>[0]) => {
      compared.calls += 1;
      return original.canonicalJson(value);
    },
  };
});

const FIELD = 'records:one:title';
const LIVE: Live = {
  frame: frameAt(1, { [FIELD]: 'field value' }),
  session: 'session:transition',
  store: null,
  sites: null,
  send: () => Promise.reject(new Error('A local transition must send no persistent update.')),
};
const FIELD_PART: ClientPart<ReactNode> = {
  instance: 'same-instance',
  props: {},
  sites: {},
  slots: {},
  states: { selected: { field: FIELD, binding: 'binding:one', set: 'set_selected' } },
};

function local(value: Json): ClientPart<ReactNode> {
  return { ...FIELD_PART, states: { selected: { value } } };
}

/** The mixed stateOf input and compiled setter that a generated Client Component uses. */
function Probe({ part }: { readonly part: ClientPart<ReactNode> }): ReactNode {
  const [value, write] = useReactiveState(
    stateOf<string | number | boolean | null>(part, 'selected'),
  );
  return (
    <>
      <output data-testid="value">{String(value)}</output>
      <button
        type="button"
        onClick={() => {
          write('edited');
        }}
      >
        edit
      </button>
      <button
        type="button"
        onClick={() => {
          write.compiled('append', {}, (current) => `${String(current)}!`);
        }}
      >
        compiled
      </button>
    </>
  );
}

function shown(part: ClientPart<ReactNode>, strict = false): ReactNode {
  const child = (
    <LiveContext.Provider value={LIVE}>
      <Probe part={part} />
    </LiveContext.Provider>
  );
  return strict ? <StrictMode>{child}</StrictMode> : child;
}

/** Raw useReactiveState inputs retain React's initializer and undefined-state semantics too. */
function RawProbe({ input }: { readonly input: unknown }): ReactNode {
  const [value] = useReactiveState(input);
  return <output data-testid="raw">{String(value)}</output>;
}

function raw(input: unknown): ReactNode {
  return (
    <LiveContext.Provider value={LIVE}>
      <RawProbe input={input} />
    </LiveContext.Provider>
  );
}

describe('a state that moves between a field binding and a local value', () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    { name: 'text', value: 'draft', strict: false },
    { name: 'zero in StrictMode', value: 0, strict: true },
    { name: 'null in StrictMode', value: null, strict: true },
    { name: 'false in StrictMode', value: false, strict: true },
  ])('uses the first local $name after mounting as a field', ({ value, strict }) => {
    const { rerender } = render(shown(FIELD_PART, strict));

    expect(screen.getByTestId('value').textContent).toBe('field value');

    rerender(shown(local(value), strict));

    expect(screen.getByTestId('value').textContent).toBe(String(value));
  });

  it('preserves local writes and compiled updates across later values and field round trips', () => {
    const { rerender } = render(shown(FIELD_PART));

    rerender(shown(local('draft')));

    expect(screen.getByTestId('value').textContent).toBe('draft');

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'compiled' }));
    rerender(shown(local('replacement')));

    expect(screen.getByTestId('value').textContent).toBe('edited!');

    rerender(shown(FIELD_PART));

    expect(screen.getByTestId('value').textContent).toBe('field value');

    rerender(shown(local('another initial value')));
    fireEvent.click(screen.getByRole('button', { name: 'compiled' }));

    expect(screen.getByTestId('value').textContent).toBe('edited!!');
    expect(LIVE.frame.fields[FIELD]).toBe('field value');
  });

  it('preserves a state that first mounted locally across the same field round trip', () => {
    const { rerender } = render(shown(local('local first'), true));

    fireEvent.click(screen.getByRole('button', { name: 'compiled' }));
    rerender(shown(local('ignored replacement'), true));

    expect(screen.getByTestId('value').textContent).toBe('local first!');

    rerender(shown(FIELD_PART, true));

    expect(screen.getByTestId('value').textContent).toBe('field value');

    rerender(shown(local('ignored after field'), true));

    expect(screen.getByTestId('value').textContent).toBe('local first!');
  });

  it('does not confuse an initialized undefined raw state with an uninitialized local cell', () => {
    const { rerender } = render(raw(undefined));

    rerender(raw('later raw initial value'));

    expect(screen.getByTestId('raw').textContent).toBe('undefined');
  });

  it('runs a raw lazy initializer on the first local render and retains its value thereafter', () => {
    const initialize = vi.fn(() => 'lazy draft');
    const replacement = vi.fn(() => 'ignored lazy value');
    const { rerender } = render(raw(stateOf(FIELD_PART, 'selected')));

    expect(screen.getByTestId('raw').textContent).toBe('field value');
    expect(initialize).not.toHaveBeenCalled();

    rerender(raw(initialize));

    expect(screen.getByTestId('raw').textContent).toBe('lazy draft');
    expect(initialize).toHaveBeenCalledTimes(1);

    rerender(raw(replacement));

    expect(screen.getByTestId('raw').textContent).toBe('lazy draft');
    expect(replacement).not.toHaveBeenCalled();
  });
});

/** A local state the authority started, as a component that reads it alone shows it. */
function ReadAlone({ part }: { readonly part: ClientPart<ReactNode> }): ReactNode {
  const [value] = useReactiveState(localOf<Json>(part, 'selected'));
  return <output data-testid="read">{JSON.stringify(value)}</output>;
}

/** A local state the authority started, read alone, beside the page's own text typed into it. */
function Typing({ part }: { readonly part: ClientPart<ReactNode> }): ReactNode {
  const [value] = useReactiveState(localOf<Json>(part, 'selected'));
  const [typed, setTyped] = useReactiveState('');
  return (
    <>
      <output data-testid="read">{JSON.stringify(value)}</output>
      <input
        aria-label="typed"
        value={typed}
        onChange={(event) => {
          setTyped(event.currentTarget.value);
        }}
      />
    </>
  );
}

/** What a render waits for that never comes: it never commits. */
const NEVER = new Promise<never>(() => {
  // Never settled.
});

/** A local state set as its component first renders, which then waits on what never comes. */
function SetsThenWaits({ part }: { readonly part: ClientPart<ReactNode> }): ReactNode {
  const [, setValue] = useReactiveState(localOf<Json>(part, 'selected'));
  const [seeded, setSeeded] = useReactiveState(false);
  if (!seeded) {
    setSeeded(true);
    setValue('seeded');
  }
  return use(NEVER);
}

/** A local state the page sets, whose render waits on what never comes where told to (`waits`). */
function SetsAndWaits({
  part,
  waits,
}: {
  readonly part: ClientPart<ReactNode>;
  readonly waits: boolean;
}): ReactNode {
  const [value, setValue] = useReactiveState(localOf<Json>(part, 'selected'));
  if (waits) {
    use(NEVER);
  }
  return (
    <button
      type="button"
      onClick={() => {
        setValue('set');
      }}
    >
      {JSON.stringify(value)}
    </button>
  );
}

/** A local state the authority started, whose setter each render hands out (`setters`). */
function Exposed({
  part,
  setters,
}: {
  readonly part: ClientPart<ReactNode>;
  readonly setters: ((next: Json) => void)[];
}): ReactNode {
  const [value, setValue] = useReactiveState(localOf<Json>(part, 'selected'));
  setters.push(setValue);
  return <output data-testid="exposed">{JSON.stringify(value)}</output>;
}

describe('a local state the authority started, until the page sets it', () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    { name: 'text', first: 'first', later: 'later' },
    { name: 'a list', first: ['one'], later: ['one', 'two'] },
    { name: 'null', first: 'something', later: null },
    { name: 'zero in StrictMode', first: 1, later: 0, strict: true },
  ])('follows each value the authority renders of $name', ({ first, later, strict = false }) => {
    const { rerender } = render(shown(local(first), strict));

    expect(screen.getByTestId('value').textContent).toBe(String(first));

    rerender(shown(local(later), strict));

    expect(screen.getByTestId('value').textContent).toBe(String(later));
  });

  it('follows the authority when the component reads the state alone', () => {
    const { rerender } = render(<ReadAlone part={local(['one'])} />);

    rerender(<ReadAlone part={local(['one', 'two'])} />);

    expect(screen.getByTestId('read').textContent).toBe('["one","two"]');
  });

  it('updates the value it followed to, and keeps the update after', () => {
    const { rerender } = render(shown(local('first')));

    rerender(shown(local('later')));
    fireEvent.click(screen.getByRole('button', { name: 'compiled' }));

    expect(screen.getByTestId('value').textContent).toBe('later!');

    rerender(shown(local('ignored once set')));

    expect(screen.getByTestId('value').textContent).toBe('later!');
  });

  it('keeps what the page wrote, even what the authority renders next', () => {
    const { rerender } = render(shown(local('first')));

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    rerender(shown(local('edited')));
    rerender(shown(local('later')));

    expect(screen.getByTestId('value').textContent).toBe('edited');
  });

  it('follows the latest local value across a field round trip it was never set in', () => {
    const { rerender } = render(shown(local('first')));

    rerender(shown(FIELD_PART));

    expect(screen.getByTestId('value').textContent).toBe('field value');

    rerender(shown(local('after the field')));

    expect(screen.getByTestId('value').textContent).toBe('after the field');
  });

  it('keeps the object it holds where the authority renders one alike', () => {
    const seen: unknown[] = [];
    function Holder({ part }: { readonly part: ClientPart<ReactNode> }): ReactNode {
      const [value] = useReactiveState(localOf<Json>(part, 'selected'));
      seen.push(value);
      return null;
    }
    const { rerender } = render(<Holder part={local({ a: 1, b: [2] })} />);

    rerender(<Holder part={local({ a: 1, b: [2] })} />);

    expect(seen.at(-1)).toBe(seen[0]);
  });

  it('compares an object alike once, however often the component renders after', () => {
    const { rerender } = render(<Typing part={local({ a: 1, b: [2] })} />);
    rerender(<Typing part={local({ a: 1, b: [2] })} />);
    const before = compared.calls;

    for (const typed of ['a', 'ab', 'abc']) {
      fireEvent.change(screen.getByLabelText('typed'), { target: { value: typed } });
    }

    expect(screen.getByTestId('read').textContent).toBe('{"a":1,"b":[2]}');
    expect(compared.calls).toBe(before);
  });

  it("tells the root's sites of a state the page set, where its part stands now", () => {
    const keep = vi.fn<ViewController<ReactNode>['keep']>();
    const live: Live = { ...LIVE, sites: { keep } as unknown as ViewController<ReactNode> };
    const at = (instance: string): ReactNode => {
      return (
        <LiveContext.Provider value={live}>
          <Probe part={{ ...local('draft'), instance, reads: ['selected'] }} />
        </LiveContext.Provider>
      );
    };
    const { rerender } = render(at('first-place'));

    expect(keep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    expect(keep).toHaveBeenCalledWith('first-place', 'selected');

    rerender(at('second-place'));

    expect(keep).toHaveBeenCalledWith('second-place', 'selected', { value: 'edited' });
    expect(screen.getByTestId('value').textContent).toBe('edited');
  });

  it('tells no value of a set state no site of its part reads', () => {
    const keep = vi.fn<ViewController<ReactNode>['keep']>();
    const live: Live = { ...LIVE, sites: { keep } as unknown as ViewController<ReactNode> };
    render(
      <LiveContext.Provider value={live}>
        <Probe part={{ ...local('draft'), instance: 'place', reads: [] }} />
      </LiveContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    expect(keep).toHaveBeenCalledWith('place', 'selected', {});

    const valued = keep.mock.calls.filter((call) => call[2] !== undefined && 'value' in call[2]);

    expect(valued).toStrictEqual([]);
  });

  it('tells nothing of a setter called once its part is no longer rendered', () => {
    const keep = vi.fn<ViewController<ReactNode>['keep']>();
    const live: Live = { ...LIVE, sites: { keep } as unknown as ViewController<ReactNode> };
    const setters: ((next: Json) => void)[] = [];
    const { unmount } = render(
      <LiveContext.Provider value={live}>
        <Exposed part={{ ...local('draft'), instance: 'place' }} setters={setters} />
      </LiveContext.Provider>,
    );
    unmount();

    setters.at(-1)?.('set after');

    expect(keep).not.toHaveBeenCalled();
  });

  it("tells the root's sites of a state set as its component first renders, which never commits", () => {
    const keep = vi.fn<ViewController<ReactNode>['keep']>();
    const live: Live = { ...LIVE, sites: { keep } as unknown as ViewController<ReactNode> };

    render(
      <LiveContext.Provider value={live}>
        <Suspense fallback={<p>waiting</p>}>
          <SetsThenWaits part={{ ...local('draft'), instance: 'place' }} />
        </Suspense>
      </LiveContext.Provider>,
    );

    expect(keep).toHaveBeenCalledWith('place', 'selected');
  });

  it("tells the root's sites of a set state where its part moves, though that render waits and never commits", () => {
    const keep = vi.fn<ViewController<ReactNode>['keep']>();
    const live: Live = { ...LIVE, sites: { keep } as unknown as ViewController<ReactNode> };
    const at = (instance: string, waits: boolean): ReactNode => {
      return (
        <LiveContext.Provider value={live}>
          <Suspense fallback={<p>waiting</p>}>
            <SetsAndWaits
              part={{ ...local('draft'), instance, reads: ['selected'] }}
              waits={waits}
            />
          </Suspense>
        </LiveContext.Provider>
      );
    };
    const { rerender } = render(at('first-place', false));
    fireEvent.click(screen.getByRole('button'));

    rerender(at('moved-place', true));

    // Told as the render renders, which waits: until a render of the part commits there.
    expect(keep).toHaveBeenCalledWith('moved-place', 'selected', {
      lasting: false,
      value: 'set',
    });
  });

  it('keeps one setter while its part moves and its root is followed anew', () => {
    const setters: ((next: Json) => void)[] = [];
    const at = (instance: string, sites: Readonly<Record<string, unknown>>): ReactNode => {
      return (
        <LiveContext.Provider
          value={{ ...LIVE, sites: sites as unknown as ViewController<ReactNode> }}
        >
          <Exposed part={{ ...local('draft'), instance }} setters={setters} />
        </LiveContext.Provider>
      );
    };
    const { rerender } = render(at('first-place', { keep: vi.fn() }));

    rerender(at('second-place', { keep: vi.fn() }));

    expect(new Set(setters).size).toBe(1);
  });

  it("keeps a page's own state as React does", () => {
    const { rerender } = render(raw('first raw value'));

    rerender(raw('later raw value'));

    expect(screen.getByTestId('raw').textContent).toBe('first raw value');
  });
});
