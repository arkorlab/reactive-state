import { describe, expect, it } from 'vitest';

import { rendered, SCOPE } from '../src/authority/tree.ts';
import { componentRef } from '../src/program.ts';

/** An element rendered of one list of children, as the tree keeps it. */
interface Lists {
  readonly children: readonly (readonly unknown[])[];
}

/** A list of children whose own `map` is the application's: what it answers is no child. */
function overridden(): { readonly list: readonly string[]; readonly calls: () => number } {
  let calls = 0;
  const list = Object.assign(['a', 'b'], {
    map: () => {
      calls += 1;
      return [() => 'ran'];
    },
  });
  return { calls: () => calls, list };
}

describe('a list of children', () => {
  it('is read by its positions, as React reads one, and not through a `map` it holds', () => {
    const { calls, list } = overridden();

    const element = rendered(SCOPE.h('div', null, list));
    const instance = SCOPE.h(componentRef('test/child'), null, list);

    expect(element).toMatchObject({ children: [['a', 'b']] });
    expect(instance).toMatchObject({ children: ['a', 'b'] });
    expect(calls()).toBe(0);
  });

  it('is read into an array of the language’s own, making none of its kind', () => {
    let made = 0;
    class Listed extends Array<string> {
      constructor(...items: string[]) {
        super(...items);
        made += 1;
      }
    }
    const list = Listed.from(['a']);
    made = 0;

    const { children } = rendered(SCOPE.h('div', null, list)) as Lists;
    const [kept] = children;

    expect(children).toStrictEqual([['a']]);
    expect(Object.getPrototypeOf(kept)).toBe(Array.prototype);
    expect(made).toBe(0);
  });

  it('keeps a hole of a list a hole, as `map` kept it', () => {
    const list: string[] = [];
    list[1] = 'a';

    const { children } = rendered(SCOPE.h('div', null, list)) as Lists;
    const [kept] = children;

    expect(kept).toHaveLength(2);
    expect(Object.hasOwn(kept ?? [], 0)).toBe(false);
    expect(kept?.[1]).toBe('a');
  });

  it('is read as long as it was as it was first read, though reading a position adds one', () => {
    let reads = 0;
    const list: unknown[] = [];
    const append = (index: number): void => {
      Object.defineProperty(list, index, {
        configurable: true,
        enumerable: true,
        get: () => {
          reads += 1;
          // Read again past its first length, it would grow as long as it is read, a thousand times.
          if (reads < 1000) {
            append(index + 1);
          }
          return 'a';
        },
      });
    };
    append(0);

    const { children } = rendered(SCOPE.h('div', null, list)) as Lists;

    expect(children).toStrictEqual([['a']]);
    expect(reads).toBe(1);
  });

  it('reads the length of a Proxy list once, as `map` read it, its traps answering one pass', () => {
    let reads = 0;
    const list = new Proxy(['a', 'b'], {
      get(target, key, receiver): unknown {
        if (key === 'length') {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const { children } = rendered(SCOPE.h('div', null, list)) as Lists;

    expect(children).toStrictEqual([['a', 'b']]);
    expect(reads).toBe(1);
  });
});
