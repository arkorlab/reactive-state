import { describe, expect, it } from 'vitest';

import { SCOPE } from '../src/authority/tree.ts';
import { componentRef } from '../src/program.ts';

/** How often the values below reach themselves again before they reach nothing. */
const AGAIN = 10_000;

/** A reactive component's instance, as the tree keeps it: its props of JSON, and those of nodes. */
interface Parts {
  readonly nodes: Readonly<Record<string, unknown>>;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * What holds itself by each of `keys`, counting each time one is read: read past `AGAIN` times in
 * all, each reaches nothing, so that a walk that looks into it once per way of reaching it ends.
 */
function holdingItself<T extends Record<string, unknown> | unknown[]>(
  value: T,
  keys: readonly string[],
): { readonly value: T; readonly reads: () => number } {
  let reads = 0;
  const get = (): unknown => {
    reads += 1;
    return reads <= AGAIN ? value : null;
  };
  for (const key of keys) {
    Object.defineProperty(value, key, { enumerable: true, get });
  }
  return { reads: () => reads, value };
}

describe('a prop that holds itself', () => {
  it('of a reactive component is looked into once for a node, however often it reaches itself', () => {
    const { reads, value } = holdingItself({}, ['a', 'b']);

    expect(() => SCOPE.h(componentRef('test/child'), { value })).toThrow('is not JSON');
    // Each entry read once to look for a node, and once more to look for a reference.
    expect(reads()).toBe(4);
  });

  it('of an element is looked into once for a node, however often it reaches itself', () => {
    const { reads, value } = holdingItself<unknown[]>([], ['0', '1']);

    expect(() => SCOPE.h('div', { value })).toThrow('neither JSON, an element, nor an action');
    expect(reads()).toBe(2);
  });
});

describe('a prop that holds one object at two depths', () => {
  it('of a reactive component is looked into again where it is reached shallower, for a node', () => {
    const shared = [[SCOPE.h('span', null, 'ok')]];
    let deep: unknown = shared;
    // Reached first through 62 lists, as deep as one may be looked into but for its own list.
    for (let level = 0; level < 62; level += 1) {
      deep = [deep];
    }

    const instance = SCOPE.h(componentRef('test/child'), { value: [deep, shared] }) as Parts;

    expect(Object.keys(instance.nodes)).toStrictEqual(['value']);
    expect(instance.props).toStrictEqual({});
  });
});
