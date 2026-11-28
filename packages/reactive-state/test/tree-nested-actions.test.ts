import { describe, expect, it } from 'vitest';

import { rendered, SCOPE } from '../src/authority/tree.ts';
import { actionRef, componentRef, type RenderedAction } from '../src/program.ts';

/** The props of the element a component rendered, as the tree keeps them. */
function propsOf(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return (rendered(SCOPE.h('div', props)) as { readonly props: Record<string, unknown> }).props;
}

/** The action `deleteTodo` bound to `bound`, as the tree carries it. */
function carried(bound: readonly string[] = []): RenderedAction {
  return { bound, kind: 'action', module: 'actions/todos', name: 'deleteTodo' };
}

/** `items`, an array whose prototype holds `iterator` as its `Symbol.iterator`. */
function withIterator(items: unknown[], iterator: () => Iterator<unknown>): unknown[] {
  const prototype = Object.create(Array.prototype) as unknown[];
  Object.defineProperty(prototype, Symbol.iterator, { value: iterator });
  return Object.setPrototypeOf(items, prototype) as unknown[];
}

const deleteTodo = actionRef('actions/todos', 'deleteTodo');

/** `deleteTodo` under `levels` objects, each of one key. */
function nest(levels: number): unknown {
  let wrapped: unknown = deleteTodo;
  for (let level = 0; level < levels; level += 1) {
    wrapped = { d: wrapped };
  }
  return wrapped;
}

const completeProject = actionRef('actions/todos', 'completeProject');

describe('a server operation nested in a prop of an element', () => {
  it('is carried as the action it is, inside an object', () => {
    const props = propsOf({ commands: { remove: deleteTodo.bind(null, 'p1'), label: 'x' } });

    expect(props['commands']).toStrictEqual({ label: 'x', remove: carried(['p1']) });
  });

  it('is carried inside an array, and inside an array of an object', () => {
    const props = propsOf({ list: [deleteTodo, 3, { again: deleteTodo.bind(null, 'p1', 't1') }] });

    expect(props['list']).toStrictEqual([carried(), 3, { again: carried(['p1', 't1']) }]);
  });

  it('is carried two levels down, through objects and arrays alike', () => {
    const props = propsOf({
      deep: { rows: [{ cells: { go: [completeProject.bind(null, 'p2')] } }] },
    });

    expect(props['deep']).toStrictEqual({
      rows: [
        {
          cells: {
            go: [
              { bound: ['p2'], kind: 'action', module: 'actions/todos', name: 'completeProject' },
            ],
          },
        },
      ],
    });
  });

  it('is carried once for each place of several in one prop, the same operation at two places too', () => {
    const props = propsOf({
      commands: {
        first: deleteTodo.bind(null, 'p1'),
        second: completeProject,
        third: deleteTodo.bind(null, 'p1'),
      },
    });
    const { first, second, third } = props['commands'] as Record<string, RenderedAction>;

    expect([first?.name, second?.name, third?.name]).toStrictEqual([
      'deleteTodo',
      'completeProject',
      'deleteTodo',
    ]);
    expect(first).toStrictEqual(third);
    expect(first).not.toBe(third);
  });

  it('keeps a hole of the array it is in as `null`, as JSON carries it', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is what is carried
    const props = propsOf({ list: [deleteTodo, , 'x'] });

    expect(props['list']).toStrictEqual([carried(), null, 'x']);
  });

  it('is refused inside what is no plain object or array, which cannot be carried', () => {
    class Holder {
      readonly remove = deleteTodo;
    }

    expect(() => propsOf({ held: new Map([['remove', deleteTodo]]) })).toThrow('neither JSON');
    expect(() => propsOf({ held: new Holder() })).toThrow('neither JSON');
    expect(() => propsOf({ held: new Set([deleteTodo]) })).toThrow('neither JSON');
  });

  it('is refused beside what is no JSON: a function, an element, a symbol key, a cycle', () => {
    const cycle: Record<string, unknown> = { remove: deleteTodo };
    cycle['self'] = cycle;

    expect(() => propsOf({ held: { remove: deleteTodo, call: () => 1 } })).toThrow('neither JSON');
    expect(() => propsOf({ held: { remove: deleteTodo, node: SCOPE.h('b', null) } })).toThrow(
      'reads as something rendered',
    );
    expect(() => propsOf({ held: { remove: deleteTodo, [Symbol('k')]: 1 } })).toThrow(
      'neither JSON',
    );
    expect(() => propsOf({ held: cycle })).toThrow('neither JSON');
  });

  it('is refused bound to what is no JSON', () => {
    expect(() => propsOf({ held: { remove: deleteTodo.bind(null, 1n as never) } })).toThrow(
      'not JSON',
    );
  });

  it('is refused beside JSON shaped as an action, which reads as the action', () => {
    const shaped = { bound: [], kind: 'action', module: 'm', name: 'n' };

    expect(() => propsOf({ held: { remove: deleteTodo, shaped } })).toThrow(
      'reads as something rendered',
    );
  });

  it('reads the arrays it is in by their own elements, whatever iterator their prototype holds', () => {
    const shaped = { bound: [], kind: 'action', module: 'm', name: 'n' };
    const throwing = withIterator([deleteTodo], () => {
      throw new Error('iterated');
    });
    const empty = withIterator([deleteTodo, shaped], () => [][Symbol.iterator]());

    expect(propsOf({ list: throwing })['list']).toStrictEqual([carried()]);
    expect(() => propsOf({ list: empty })).toThrow('reads as something rendered');
  });

  it('is named by the node it is rendered in, which tells the host what to walk, and no other prop is', () => {
    const named = rendered(
      SCOPE.h('div', { commands: { go: deleteTodo }, plain: { rows: [1] }, top: deleteTodo }),
    ) as { readonly nested?: readonly string[] };
    const plain = rendered(SCOPE.h('div', { plain: { rows: [1] }, top: deleteTodo })) as {
      readonly nested?: readonly string[];
    };

    expect(named.nested).toStrictEqual(['commands']);
    expect(Object.hasOwn(plain, 'nested')).toBe(false);
  });

  it('is taken at depth 63 and refused at depth 64, whether or not another stands shallower', () => {
    expect(() => propsOf({ held: { d: nest(62) } })).not.toThrow();
    expect(() => propsOf({ held: { d: nest(63) } })).toThrow('neither JSON');
    expect(() => propsOf({ held: { a: deleteTodo, d: nest(63) } })).toThrow('neither JSON');
  });

  it('runs no getter of the prop that holds it, which is refused unread', () => {
    let ran = 0;
    const getter = {
      get x(): number {
        ran += 1;
        return 1;
      },
    };

    expect(() => propsOf({ held: getter })).toThrow('neither JSON');
    expect(() => propsOf({ held: { go: deleteTodo, inner: getter } })).toThrow('neither JSON');
    expect(ran).toBe(0);
  });

  it('is refused plainly, beside an element, in the props of a reactive component', () => {
    expect(() =>
      SCOPE.h(componentRef('test/child'), { value: [deleteTodo, SCOPE.h('b', null)] }),
    ).toThrow('no child is');
  });
});
