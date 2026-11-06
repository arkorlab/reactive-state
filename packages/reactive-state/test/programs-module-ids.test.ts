import { describe, expect, it } from 'vitest';

import { registryOf } from '../src/authority/programs.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../src/program.ts';

/**
 * The ids `registryOf` takes of a component and of a module of server operations: a path in the
 * application, of no segment that holds a space, a control character — a whitespace one or not —
 * or a backslash.
 */

/** A program of `component` that a compile could write, of no state. */
function programOf(component: string): ComponentProgram {
  return {
    buildId: 'b_test',
    component,
    evaluate: () => null,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

/** Controls of C0, `DEL` and C1 that are no whitespace, which `\s` passes over, by code point. */
const CONTROLS = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f].map((point) => {
  return {
    control: String.fromCodePoint(point),
    point: `U+${point.toString(16).toUpperCase().padStart(4, '0')}`,
  };
});

describe('the ids of a registry', () => {
  it.each(CONTROLS)('refuses a component id that holds $point', ({ control }) => {
    expect(() => registryOf({ programs: [programOf(`todos/li${control}st`)] })).toThrow(
      'names its component (`component`) by its path in the application',
    );
  });

  it.each(CONTROLS)('refuses a module id that holds $point', ({ control }) => {
    expect(() => {
      return registryOf({
        operations: { [`actions/to${control}dos`]: {} },
        programs: [programOf('todos/list')],
      });
    }).toThrow('are not a module the authority can run');
  });

  it.each(['todos/list', 'todos/リスト', 'todos/list.v2', 'todos/@list'])(
    'keeps a component id of no control, no space and no backslash: %j',
    (component) => {
      expect(registryOf({ programs: [programOf(component)] }).programs.has(component)).toBe(true);
    },
  );
});
