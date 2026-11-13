import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handedGlobal } from '../src/compiler/handed-globals.ts';

/**
 * A pattern an assignment writes takes a global apart as one a declaration writes does, `({ abs } =
 * Math)` as `const { abs } = Math`: a member the compile reads by its name alone is handed on where
 * the key is that member's — whichever way it is written, and wherever the code computes it, or
 * takes the rest — and no other member is. An assignment is an expression, whose value is what it
 * takes apart: where that is used, `const copy = ({ abs } = Math)`, the global is handed on whole.
 */

/** The members of globals the compile reads by their names alone, as a shared module's checks do. */
const REACHED: ReadonlySet<string> = new Set(['Date.now', 'Math.random']);

/** What a pattern takes `Math` apart by, written as a declaration and as an assignment. */
const PATTERNS = [
  { hands: false, pattern: '{ abs }', what: 'another member by its name' },
  { hands: false, pattern: "{ ['abs']: abs }", what: 'another member by text' },
  { hands: false, pattern: '{ [`abs`]: abs }', what: 'another member by a template' },
  { hands: false, pattern: '{ abs: renamed }', what: 'another member renamed' },
  { hands: false, pattern: '{ abs = 1 }', what: 'another member with a default' },
  { hands: false, pattern: '{ abs: { name } }', what: 'another member taken apart in turn' },
  { hands: false, pattern: '{ abs, floor }', what: 'two other members' },
  { hands: true, pattern: '{ random }', what: 'the member by its name' },
  { hands: true, pattern: "{ ['random']: random }", what: 'the member by text' },
  { hands: true, pattern: '{ [`random`]: random }', what: 'the member by a template' },
  { hands: true, pattern: '{ random: renamed }', what: 'the member renamed' },
  { hands: true, pattern: '{ random = 0 }', what: 'the member with a default' },
  { hands: true, pattern: '{ abs, random }', what: 'the member beside another' },
  { hands: true, pattern: '{ [key]: taken }', what: 'a key it computes' },
  { hands: true, pattern: '{ abs, ...rest }', what: 'a rest beside another member' },
  { hands: true, pattern: '{ ...rest }', what: 'a rest alone' },
] as const;

/** What an assignment alone writes of a global, with the global it hands on or takes apart. */
const ASSIGNMENTS = [
  {
    global: 'Math',
    hands: false,
    source: '({ abs: target.abs } = Math);',
    what: 'a member to a member of an object',
  },
  {
    global: 'Math',
    hands: false,
    source: '({ abs: items[0] } = Math);',
    what: 'a member to an entry',
  },
  { global: 'Math', hands: false, source: '(({ abs } = Math));', what: 'a pattern in parentheses' },
  {
    global: 'Math',
    hands: false,
    source: '({ abs } = globalThis.Math);',
    what: 'a global read of the global object',
  },
  {
    global: 'Date',
    hands: false,
    source: '({ UTC } = Date);',
    what: 'another global, another member',
  },
  { global: 'Date', hands: true, source: '({ now } = Date);', what: 'another global, the member' },
  {
    global: 'Event',
    hands: false,
    source: '({ prototype } = Event);',
    what: 'a class that reads the time, a static',
  },
  {
    global: 'Math',
    hands: true,
    source: 'const copy = ({ abs } = Math);',
    what: 'the value of the assignment held',
  },
  {
    global: 'Math',
    hands: true,
    source: 'items.push(({ abs } = Math));',
    what: 'the value of the assignment handed on',
  },
  {
    global: 'Math',
    hands: true,
    source: 'items[0] = ({ abs } = Math);',
    what: 'the value of the assignment assigned',
  },
  {
    global: 'Math',
    hands: true,
    source: '({ abs } = Math).random();',
    what: 'the value of the assignment read of',
  },
  {
    global: 'Math',
    hands: true,
    source: 'items.push(...[({ abs } = Math)]);',
    what: 'the value of the assignment in an array',
  },
  { global: 'Math', hands: true, source: '[abs] = Math;', what: 'an array pattern' },
  { global: 'Math', hands: true, source: '({ abs } = [Math]);', what: 'the global in an array' },
  {
    global: 'Math',
    hands: true,
    source: '({ abs: { random } } = { abs: Math });',
    what: 'the global in an object',
  },
  {
    global: 'Math',
    hands: true,
    source: 'for ({ abs } of [Math]) {}',
    what: 'a loop over an array of it',
  },
  { global: 'Math', hands: true, source: 'for ({ abs } of Math) {}', what: 'a loop over it' },
  {
    global: 'Math',
    hands: true,
    source: '({ abs = Math } = Math);',
    what: 'the global as a default',
  },
  {
    global: 'Math',
    hands: true,
    source: '({ abs: renamed = Math } = Math);',
    what: 'the global as a default of a rename',
  },
  {
    global: 'Math',
    hands: true,
    source: '({ abs = leak(Math) } = Math);',
    what: 'the global handed on in a default',
  },
  { global: 'Math', hands: true, source: 'target = Math;', what: 'the global assigned' },
] as const;

describe('a global taken apart by a pattern an assignment writes', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `handedGlobal` says of any node of `source`, a statement, for `global`: whether it hands it on. */
  function handsOn(source: string): boolean {
    using parsed = api.createSourceFile('handed.ts', `${source}\n`);
    let handed = false;
    const visit = (node: Node): void => {
      handed ||= handedGlobal(node, REACHED) !== undefined;
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    return handed;
  }

  it.each(PATTERNS)('declared, takes $what', ({ hands, pattern }) => {
    expect(handsOn(`const ${pattern} = Math;`)).toBe(hands);
  });

  it.each(PATTERNS)('assigned, takes $what', ({ hands, pattern }) => {
    expect(handsOn(`(${pattern} = Math);`)).toBe(hands);
  });

  it.each(ASSIGNMENTS)('reads $what', ({ hands, source }) => {
    expect(handsOn(source)).toBe(hands);
  });
});
