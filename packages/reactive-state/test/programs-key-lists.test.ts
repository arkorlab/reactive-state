import { describe, expect, it } from 'vitest';

import { registryOf } from '../src/authority/programs.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../src/program.ts';

/**
 * The lists of keys a program names — the states it has a setter for (`writable`), and those each
 * update registers for — which `registryOf` takes as a compile writes them: a key at each index, as
 * text, and none twice. A hole is no key, though `every` passes over one.
 */

/** A program of the component `todos/list`, which a compile could write, but for what is given. */
function programOf(given: Partial<ComponentProgram>): ComponentProgram {
  return {
    buildId: 'b_test',
    component: 'todos/list',
    evaluate: () => null,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: ['title'],
    ...given,
  };
}

/** `keys` with no element at `index`, its length kept. */
function holed(keys: readonly string[], index: number): string[] {
  const list = [...keys];
  Reflect.deleteProperty(list, String(index));
  return list;
}

describe('the key lists of a program', () => {
  it.each([
    { at: 'start', keys: holed(['title', 'done'], 0) },
    { at: 'end', keys: holed(['title', 'done'], 1) },
    { at: 'middle', keys: holed(['title', 'done', 'due'], 1) },
  ])('refuses the states it writes with a hole at the $at', ({ keys }) => {
    expect(() => registryOf({ programs: [programOf({ writable: keys })] })).toThrow(
      'is not one a compile writes',
    );
  });

  it('refuses an update registered for keys with a hole', () => {
    const updaters = { setTitle: { kind: 'set', keys: holed(['title', 'done'], 1) } } as const;

    expect(() => registryOf({ programs: [programOf({ updaters })] })).toThrow(
      "registers setTitle, which is neither an `apply` nor a `set` of its states' keys",
    );
  });

  it('keeps lists of a key at each index, and refuses one that names a key twice', () => {
    const updaters = { setTitle: { kind: 'set', keys: ['title'] } } as const;
    const registry = registryOf({
      programs: [programOf({ updaters, writable: ['title', 'done'] })],
    });

    expect(registry.programs.get('todos/list')?.writable).toStrictEqual(['title', 'done']);
    expect(() => registryOf({ programs: [programOf({ writable: ['title', 'title'] })] })).toThrow(
      'is not one a compile writes',
    );
  });
});
