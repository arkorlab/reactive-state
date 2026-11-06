// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { type Dispatch, type ReactNode, type SetStateAction, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClientPart } from '../src/program.ts';
import { localOf, useReactiveState } from '../src/react/state.ts';
import { toJson } from '../src/runtime/json.ts';

type Write = Dispatch<SetStateAction<readonly string[]>>;
const PART: ClientPart<ReactNode> = {
  instance: 'array-symbols',
  props: {},
  sites: {},
  slots: {},
  states: { items: { value: ['initial'] } },
};

/** A local state retains invalid values until a site attempts to send them as JSON. */
describe('local array updates with symbol metadata', () => {
  afterEach(cleanup);

  it.each(['metadata', 'iterator'] as const)(
    'retains the original invalid %s array without executing its iterator',
    (kind) => {
      const calls: string[] = [];
      const next = ['original'];
      Object.defineProperty(next, kind === 'metadata' ? Symbol('extra') : Symbol.iterator, {
        *value() {
          calls.push('iterate');
          yield 'changed';
        },
      });
      const observed: { value: readonly string[]; write?: Write } = { value: [] };
      render(
        <LocalArray
          observe={(value, write) => {
            observed.value = value;
            observed.write = write;
          }}
        />,
      );
      const write = renderedSetter(observed);

      act(() => {
        write(next);
      });

      expect(observed.value).toBe(next);
      expect(observed.value[0]).toBe('original');
      expect(calls).toStrictEqual([]);
    },
  );

  it('retains a sparse local input for a later site refusal without reading inherited indices', () => {
    const calls: string[] = [];
    const next = ['original'];
    next.length = 2;
    const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
    Object.defineProperty(prototype, '1', {
      get() {
        calls.push('get inherited index');
        return 'manufactured';
      },
    });
    Object.setPrototypeOf(next, prototype);
    const observed: { value: readonly string[]; write?: Write } = { value: [] };
    render(
      <LocalArray
        observe={(value, write) => {
          observed.value = value;
          observed.write = write;
        }}
      />,
    );
    const write = renderedSetter(observed);

    act(() => {
      write(next);
    });

    expect(observed.value).toBe(next);
    expect(Object.hasOwn(observed.value, 1)).toBe(false);
    expect(calls).toStrictEqual([]);
    expect(() => toJson(observed.value, 'The site')).toThrow('The site[1] is undefined');
    expect(calls).toStrictEqual([]);
  });

  it('still copies a valid local array as JSON', () => {
    const next = ['changed'];
    const observed: { value: readonly string[]; write?: Write } = { value: [] };
    render(
      <LocalArray
        observe={(value, write) => {
          observed.value = value;
          observed.write = write;
        }}
      />,
    );
    const write = renderedSetter(observed);

    act(() => {
      write(next);
    });

    expect(observed.value).toStrictEqual(next);
    expect(observed.value).not.toBe(next);
  });
});

/** The same localOf input and setter that generated Client Components use. */
function LocalArray({
  observe,
}: {
  readonly observe: (value: readonly string[], write: Write) => void;
}): ReactNode {
  const [value, write] = useReactiveState(localOf<readonly string[]>(PART, 'items'));
  useLayoutEffect(() => {
    observe(value, write);
  }, [observe, value, write]);
  return <p>{value[0]}</p>;
}

/** A setter exposed by the local component's committed render. */
function renderedSetter(observed: { readonly write?: Write }): Write {
  if (observed.write === undefined) {
    throw new Error('The local setter was not rendered.');
  }
  return observed.write;
}
