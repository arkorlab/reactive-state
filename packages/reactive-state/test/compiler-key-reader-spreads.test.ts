import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A spread among the arguments a reader of the language's is given lays them out as the language
 * runs them: of an array written, the elements it writes, so that a key is where they put it; of a
 * list the code gives by a name, as many arguments as the list has, which the code does not show —
 * each length it may have is read, so that a key written past it is read where it may be the key,
 * and not where the arguments before it are too many for it to be. A list kept by a name, and the
 * function it holds, are not followed.
 */

const CASES = [
  // A spread of an array written: the elements it writes, in order.
  {
    reads: ["Reflect.get(...[run, 'constructor'])"],
    source: "return Reflect.get(...[run, 'constructor'])(text)();",
    what: 'a key an array written, spread, gives',
  },
  {
    reads: ["Reflect.get(...[run], 'constructor')"],
    source: "return Reflect.get(...[run], 'constructor')(text)();",
    what: 'a key past an array of one, spread',
  },
  {
    reads: ["Reflect.get(...[], run, 'constructor')"],
    source: "return Reflect.get(...[], run, 'constructor')(text)();",
    what: 'a key past an empty array, spread',
  },
  {
    reads: ["Reflect.get(...<any>[run, 'constructor'])"],
    source: "return Reflect.get(...<any>[run, 'constructor'])(text)();",
    what: 'a key an array in a cast in angle brackets, spread, gives',
  },
  {
    reads: ["Reflect.get(...[...[run], 'constructor'])"],
    source: "return Reflect.get(...[...[run], 'constructor'])(text)();",
    what: 'a key an array written in an array written, spread, gives',
  },
  {
    reads: ["Reflect.get.call(null, ...[run, 'constructor'])"],
    source: "return Reflect.get.call(null, ...[run, 'constructor'])(text)();",
    what: 'a key an array written, spread, gives to a borrowed call',
  },
  {
    reads: ["Reflect.get.apply(null, [...[run, 'constructor']])"],
    source: "return Reflect.get.apply(null, [...[run, 'constructor']])(text)();",
    what: 'a key an array written, spread, gives to the array of `apply`',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, [...[run, 'constructor']])"],
    source: "return Reflect.apply(Reflect.get, null, [...[run, 'constructor']])(text)();",
    what: 'a key an array written, spread, gives to `Reflect.apply`',
  },
  {
    reads: ["Reflect.get.bind(null, ...[run, 'constructor'])"],
    source: "return Reflect.get.bind(null, ...[run, 'constructor'])()(text)();",
    what: 'a key an array written, spread, gives to `bind`',
  },
  {
    reads: [],
    source: "return Reflect.get(...[run, 'name'], 'constructor');",
    what: 'a key past an array of two, spread',
  },
  {
    reads: [],
    source: "return Reflect.get(...[...[run, 'name']], 'constructor');",
    what: 'a key past an array written in an array written, spread',
  },
  {
    reads: [],
    source: "return Reflect.get.call(null, ...[run, 'name'], 'constructor');",
    what: 'a key past an array of two, spread, given to a borrowed call',
  },
  // A spread of a list given by a name: any length, so a key written past it is read where it may be the key.
  {
    reads: ["Reflect.get(...rest, 'constructor')"],
    source: "return Reflect.get(...rest, 'constructor')(text)();",
    what: 'a key past a spread, as the one it may be',
  },
  {
    reads: ["Reflect.get(run, ...rest, 'constructor')"],
    source: "return Reflect.get(run, ...rest, 'constructor')(text)();",
    what: 'a key past a function and a spread',
  },
  {
    reads: ["Reflect.get(...rest, ...args, 'constructor')"],
    source: "return Reflect.get(...rest, ...args, 'constructor')(text)();",
    what: 'a key past two spreads',
  },
  {
    reads: ["Reflect.get(...rest, 'constructor', ...args)"],
    source: "return Reflect.get(...rest, 'constructor', ...args)(text)();",
    what: 'a key between two spreads',
  },
  {
    reads: ["Reflect.get.call(null, run, ...rest, 'constructor')"],
    source: "return Reflect.get.call(null, run, ...rest, 'constructor')(text)();",
    what: 'a key past a function and a spread, given to a borrowed call',
  },
  {
    reads: ["Reflect.get.apply(null, [run, ...rest, 'constructor'])"],
    source: "return Reflect.get.apply(null, [run, ...rest, 'constructor'])(text)();",
    what: 'a key past a function and a spread, in the array of `apply`',
  },
  {
    reads: ["Reflect.get.apply(...args, [...rest, 'constructor'])"],
    source: "return Reflect.get.apply(...args, [...rest, 'constructor'])(text)();",
    what: 'a key past a spread in an array, which a spread may give to `apply` as the `this`',
  },
  {
    reads: ["Reflect.apply(Reflect.get, ...rest, [run, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, ...rest, [run, 'constructor'])(text)();",
    what: 'an array a spread may move, given to `Reflect.apply`',
  },
  {
    reads: ["Reflect.get.bind(null, ...rest).bind(null, 'constructor')"],
    source: "return Reflect.get.bind(null, ...rest).bind(null, 'constructor')()(text)();",
    what: 'a key `bind` gives past a spread `bind` was given',
  },
  {
    reads: ["Reflect.get(run, ...rest, ...[...args], 'constructor')"],
    source: "return Reflect.get(run, ...rest, ...[...args], 'constructor')(text)();",
    what: 'a key past a spread in an array written, spread',
  },
  {
    reads: [],
    source: "return Reflect.get(run, 'name', ...rest, 'constructor');",
    what: 'a key past two functions and a spread',
  },
  {
    reads: [],
    source: "return Reflect.get(...rest, run, 'name', 'constructor');",
    what: 'a key past a spread and two functions',
  },
  {
    reads: [],
    source: "return Reflect.get.call(null, run, 'name', ...rest, 'constructor');",
    what: 'a key past two functions and a spread, given to a borrowed call',
  },
  {
    reads: [],
    source: "return Reflect.get.apply(null, [run, 'name', ...rest, 'constructor']);",
    what: 'a key past two functions and a spread, in the array of `apply`',
  },
  {
    reads: [],
    source: 'return Reflect.get(...rest);',
    what: 'what a spread alone gives',
  },
  {
    reads: [],
    source: "return Reflect.get(run, 'name', 'constructor', ...rest);",
    what: 'what a key past the key, before a spread, is',
  },
  {
    reads: ["Reflect.get(...rest, ...args, ...fn, ...obj, ...text, 'constructor')"],
    source: "return Reflect.get(...rest, ...args, ...fn, ...obj, ...text, 'constructor')(text)();",
    what: 'a key past more spreads than are laid out, written with a reader',
  },
  {
    reads: [],
    source: "return reader.get(...rest, ...args, ...fn, ...obj, ...text, 'constructor');",
    what: 'a key past more spreads than are laid out, written with no reader',
  },
  {
    reads: [],
    source: "return reader.get(...rest, 'constructor');",
    what: 'a key past a spread, given to a function of the module',
  },
  {
    reads: [],
    source: "return run(...rest, 'constructor');",
    what: 'a key past a spread, given to a function of no reader',
  },
  {
    reads: [],
    source: "return Reflect.apply(...rest, null, [run, 'constructor']);",
    what: 'a function `Reflect.apply` is given by a spread',
  },
  {
    reads: [],
    source: "const keys = [run, 'constructor'];\n  return Reflect.get(...keys);",
    what: 'a list kept by a name, spread',
  },
] as const;

describe('a spread among the arguments a reader of the language is given', () => {
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
      'const obj: any = {};',
      'export function run(text: string, rest: any[], args: any[], fn: any): unknown {',
      `  ${body}`,
      '}',
      '',
    ].join('\n');
    using parsed = api.createSourceFile('chains.ts', source);
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
