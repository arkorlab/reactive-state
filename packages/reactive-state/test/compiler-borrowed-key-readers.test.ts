import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function of the language's that reads a member by the key it is given, `Reflect.get`, reads it
 * as well where the code borrows it: `Reflect.get.call(null, fn, 'constructor')`, `.apply(null, [fn,
 * 'constructor'])` — `call` and `apply` hand on what they are given after the `this` they take, and
 * the key written there reaches what made the function as written beside the function it reads.
 * What the code does not show — an array `apply` is given by a name, a key it computes — is not read.
 */

const CASES = [
  {
    reads: ["Reflect.get.call(null, run, 'constructor')"],
    source: "return Reflect.get.call(null, run, 'constructor')(text)();",
    what: "`Reflect.get` called with a `this`, the key `'constructor'`",
  },
  {
    reads: ["Reflect.get.apply(null, [run, 'constructor'])"],
    source: "return Reflect.get.apply(null, [run, 'constructor'])(text)();",
    what: '`Reflect.get` applied to an array of its arguments',
  },
  {
    reads: ["Reflect.getOwnPropertyDescriptor.call(Reflect, run, 'constructor')"],
    source: "return Reflect.getOwnPropertyDescriptor.call(Reflect, run, 'constructor');",
    what: '`Reflect.getOwnPropertyDescriptor` called',
  },
  {
    reads: ["Object.getOwnPropertyDescriptor.apply(Object, [run, 'constructor'])"],
    source: "return Object.getOwnPropertyDescriptor.apply(Object, [run, 'constructor']);",
    what: '`Object.getOwnPropertyDescriptor` applied',
  },
  {
    reads: ["(0, Reflect.get).call(null, run, 'constructor')"],
    source: "return (0, Reflect.get).call(null, run, 'constructor')(text)();",
    what: 'a function read past a comma, called',
  },
  {
    reads: ["globalThis.Reflect.get['call'](null, run, 'constructor')"],
    source: "return globalThis.Reflect.get['call'](null, run, 'constructor')(text)();",
    what: '`call` read by text in brackets, of the global object',
  },
  {
    reads: [],
    source: "return Reflect.get.call(null, run, 'name');",
    what: 'another key, called',
  },
  {
    reads: [],
    source: "return Reflect.get.apply(null, [run, 'name']);",
    what: 'another key, applied',
  },
  {
    reads: [],
    source: "return Reflect.get.call(run, 'constructor');",
    what: "`'constructor'` as what is read, the `this` taken first",
  },
  {
    reads: [],
    source: "return Reflect.get.apply(run, ['constructor']);",
    what: "`'constructor'` as what is read, applied",
  },
  {
    reads: [],
    source: "return Reflect.get.apply(null, [...rest, 'constructor']);",
    what: 'an array of which a spread hides the key',
  },
  {
    reads: [],
    source: 'return Reflect.get.apply(null, args);',
    what: 'an array it is given by a name',
  },
  {
    reads: [],
    source: "return reader.get.call(null, run, 'constructor');",
    what: 'a function of the module',
  },
  {
    reads: [],
    source: "return Reflect.get.call(null, ...[run, 'name'] as const, 'constructor');",
    what: "`'constructor'` as the receiver, after a spread of the arguments",
  },
  {
    reads: [],
    source: "return Reflect.get.call(null, ...rest, 'constructor');",
    what: 'a key past a spread of an array it is given by a name',
  },
  {
    reads: [],
    source: "return Reflect.get.call(...args, run, 'constructor');",
    what: 'a `this` that a spread may be',
  },
  {
    reads: [],
    source: "return Reflect.get.apply(...[null, [run, 'name']], [run, 'constructor']);",
    what: 'an array of `apply` that a spread of the arguments before it moves',
  },
  {
    reads: [],
    source: "return Reflect.get.apply(...args, [run, 'constructor']);",
    what: 'a `this` of `apply` that a spread may be',
  },
  {
    reads: ["Reflect.get.apply(null, [run, 'constructor'], ...rest)"],
    source: "return Reflect.get.apply(null, [run, 'constructor'], ...rest)(text)();",
    what: 'an array of `apply` before a spread',
  },
  {
    reads: ["Reflect.get.call(null, run, 'constructor', ...rest)"],
    source: "return Reflect.get.call(null, run, 'constructor', ...rest)(text)();",
    what: 'a key before a spread',
  },
] as const;

describe('a key reader of the language borrowed through call or apply', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The text of each node of the function `run`, whose body is `body`, that reads what made code. */
  function codeReadsIn(body: string): readonly string[] {
    const source = [
      'const reader = { get: (target: unknown, key: string) => key };',
      'export function run(text: string, rest: unknown[], args: unknown[]): unknown {',
      `  ${body}`,
      '}',
      '',
    ].join('\n');
    using parsed = api.createSourceFile('borrowed.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (readsCodeGlobal(node)) {
        reads.push(source.slice(node.getStart(sourceFile), node.end));
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(CASES)('reads $what', ({ reads, source }) => {
    expect(codeReadsIn(source)).toStrictEqual(reads);
  });
});
