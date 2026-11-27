import { describe, expect, it } from 'vitest';

import { rendered, SCOPE } from '../src/authority/tree.ts';
import { actionRef, REFERENCE } from '../src/program.ts';

/**
 * A prop is looked into without running a getter of it, so that one refused is refused unread. The
 * look for an action a compile made asks for its marker, `REFERENCE`, which only a data property of
 * the object itself stands for: an accessor under that symbol is no marker, and is not run.
 */

/** The props of the element a component rendered, as the tree keeps them. */
function propsOf(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return (rendered(SCOPE.h('div', props)) as { readonly props: Record<string, unknown> }).props;
}

const deleteTodo = actionRef('actions/todos', 'deleteTodo');

/** An object whose `REFERENCE` is a getter, which `ran` counts the runs of and which throws. */
function accessor(ran: { count: number }): Record<symbol, unknown> {
  return {
    get [REFERENCE](): boolean {
      ran.count += 1;
      throw new Error('executed');
    },
  };
}

describe('a prop that holds an accessor under the reference marker', () => {
  it('is refused unread as a prop of its own', () => {
    const ran = { count: 0 };

    expect(() => propsOf({ held: accessor(ran) })).toThrow('neither JSON');
    expect(ran.count).toBe(0);
  });

  it('is refused unread inside an object, whether or not an action stands beside it', () => {
    const ran = { count: 0 };

    expect(() => propsOf({ held: { inner: accessor(ran) } })).toThrow('neither JSON');
    expect(() => propsOf({ held: { go: deleteTodo, inner: accessor(ran) } })).toThrow(
      'neither JSON',
    );
    expect(() => propsOf({ held: [deleteTodo, accessor(ran)] })).toThrow('neither JSON');
    expect(ran.count).toBe(0);
  });

  it('leaves an action the compile made, which holds its marker as data, as it is', () => {
    const props = propsOf({ held: { go: deleteTodo.bind(null, 'p1') } });

    expect(props['held']).toStrictEqual({
      go: { bound: ['p1'], kind: 'action', module: 'actions/todos', name: 'deleteTodo' },
    });
  });
});
