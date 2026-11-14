import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function `bind` made of a key reader of the language's keeps what it was given, and what a call
 * of it is given is what follows — also where the call is borrowed, `call` or `apply`: `Reflect.get
 * .bind(null, fn).call(null, 'constructor')` is `Reflect.get(fn, 'constructor')`. The key reads at
 * the call that gives it, once: where `bind` is given it, `bind` is the read; where the borrowed call
 * is, that call is. What the code does not show — an array `apply` is given by a name, a key past a
 * spread — is not read.
 */

const CASES = [
  {
    reads: ["Reflect.get.bind(null, run).call(null, 'constructor')"],
    source: "return Reflect.get.bind(null, run).call(null, 'constructor')(text)();",
    what: 'a key the `call` of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).apply(null, ['constructor'])"],
    source: "return Reflect.get.bind(null, run).apply(null, ['constructor'])(text)();",
    what: 'a key the `apply` of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind(null).call(null, run, 'constructor')"],
    source: "return Reflect.get.bind(null).call(null, run, 'constructor')(text)();",
    what: 'the function and the key the `call` of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind(null).apply(null, [run, 'constructor'])"],
    source: "return Reflect.get.bind(null).apply(null, [run, 'constructor'])(text)();",
    what: 'the function and the key the `apply` of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind().call(null, run, 'constructor')"],
    source: "return Reflect.get.bind().call(null, run, 'constructor')(text)();",
    what: 'a bound reader given no `this`, called',
  },
  {
    reads: ["(0, Reflect.get.bind(null, run)).call(null, 'constructor')"],
    source: "return (0, Reflect.get.bind(null, run)).call(null, 'constructor')(text)();",
    what: 'a bound reader past a comma, borrowed',
  },
  {
    reads: ["(<any>Reflect.get.bind(null, run)).call(null, 'constructor')"],
    source: "return (<any>Reflect.get.bind(null, run)).call(null, 'constructor')(text)();",
    what: 'a bound reader in a cast in angle brackets, borrowed',
  },
  {
    reads: ["Reflect.get.bind(null, run)['call'](null, 'constructor')"],
    source: "return Reflect.get.bind(null, run)['call'](null, 'constructor')(text)();",
    what: '`call` read by text in brackets, of a bound reader',
  },
  {
    reads: ["Reflect.get.bind(null, run).apply(null, <any>['constructor'])"],
    source: "return Reflect.get.bind(null, run).apply(null, <any>['constructor'])(text)();",
    what: 'an array in a cast in angle brackets, applied to a bound reader',
  },
  {
    reads: ["Object.getOwnPropertyDescriptor.bind(Object, run).apply(null, ['constructor'])"],
    source:
      "return Object.getOwnPropertyDescriptor.bind(Object, run).apply(null, ['constructor']);",
    what: '`Object.getOwnPropertyDescriptor` bound, applied',
  },
  {
    reads: ["Reflect.get.bind(null, run).call(null, 'constructor', ...rest)"],
    source: "return Reflect.get.bind(null, run).call(null, 'constructor', ...rest)(text)();",
    what: 'a key before a spread of what the borrowed call is given',
  },
  {
    reads: ["Reflect.get.bind(null, run, 'constructor')"],
    source: "return Reflect.get.bind(null, run, 'constructor').call(null)(text)();",
    what: 'a key `bind` is given, the call borrowed',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run).call(null, 'name');",
    what: 'another key, given to a borrowed call',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run).apply(null, ['name']);",
    what: 'another key, applied',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run).call('constructor');",
    what: "`'constructor'` as the `this` a borrowed call takes",
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run, 'name').call(null, 'constructor');",
    what: 'a key the borrowed call is given after the one `bind` was',
  },
  {
    reads: ["Reflect.get.bind(null, ...rest).call(null, 'constructor')"],
    source: "return Reflect.get.bind(null, ...rest).call(null, 'constructor');",
    what: 'a borrowed call past a spread of what `bind` is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).call(...args, 'constructor')"],
    source: "return Reflect.get.bind(null, run).call(...args, 'constructor');",
    what: 'a key past a spread of what the borrowed call is given',
  },
  {
    reads: [],
    source: 'return Reflect.get.bind(null, run).apply(null, args);',
    what: 'an array a bound reader is applied to by a name',
  },
  {
    reads: ["Reflect.get.bind(null, run).apply(...args, ['constructor'])"],
    source: "return Reflect.get.bind(null, run).apply(...args, ['constructor']);",
    what: 'an array of `apply` that a spread may move',
  },
  {
    reads: [],
    source: "return reader.get.bind(null, run).call(null, 'constructor');",
    what: 'a function of the module',
  },
  {
    reads: [],
    source: 'return Reflect.get.bind(null, run).call;',
    what: 'a borrowed call that is not made',
  },
] as const;

describe('a key reader of the language bound, then borrowed through call or apply', () => {
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
    using parsed = api.createSourceFile('bound.ts', source);
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
