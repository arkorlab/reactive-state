import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function of the language's that reads a member by the key it is given, `Reflect.get`, reads it
 * as well where the code binds it: `Reflect.get.bind(null, fn, 'constructor')()` is `Reflect.get(fn,
 * 'constructor')` — `bind` keeps what it is given after the `this` it takes, and a call of what it
 * made is given what follows. The key reads at the call that gives it, once: where `bind` is given
 * it, `bind` is the read; where the call is, the call is. What the code does not show — a bound
 * function it holds by a name, a key past a spread, a key it computes — is not read.
 */

const CASES = [
  {
    reads: ["Reflect.get.bind(null, run, 'constructor')"],
    source: "return Reflect.get.bind(null, run, 'constructor')()(text)();",
    what: 'a key `bind` is given',
  },
  {
    reads: ["Reflect.get.bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null, run)('constructor')(text)();",
    what: 'a key the call of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind(null)(run, 'constructor')"],
    source: "return Reflect.get.bind(null)(run, 'constructor')(text)();",
    what: 'the function and the key the call of a bound reader is given',
  },
  {
    reads: ["Reflect.get.bind()(run, 'constructor')"],
    source: "return Reflect.get.bind()(run, 'constructor')(text)();",
    what: 'a bound reader given no `this`',
  },
  {
    reads: ["(Reflect.get.bind(null, run))('constructor')"],
    source: "return (Reflect.get.bind(null, run))('constructor')(text)();",
    what: 'a bound reader in parentheses, called',
  },
  {
    reads: ["Reflect.get.bind(null, run, 'constructor')"],
    source: "const get = Reflect.get.bind(null, run, 'constructor');\n  return get;",
    what: 'a reader bound to a key and held',
  },
  {
    reads: ["Object.getOwnPropertyDescriptor.bind(Object, run, 'constructor')"],
    source: "return Object.getOwnPropertyDescriptor.bind(Object, run, 'constructor')();",
    what: '`Object.getOwnPropertyDescriptor` bound',
  },
  {
    reads: ["Reflect.getOwnPropertyDescriptor.bind(Reflect, run)('constructor')"],
    source: "return Reflect.getOwnPropertyDescriptor.bind(Reflect, run)('constructor');",
    what: '`Reflect.getOwnPropertyDescriptor` bound, called',
  },
  {
    reads: ["(0, Reflect.get).bind(null, run, 'constructor')"],
    source: "return (0, Reflect.get).bind(null, run, 'constructor')()(text)();",
    what: 'a function read past a comma, bound',
  },
  {
    reads: ["globalThis.Reflect.get['bind'](null, run, 'constructor')"],
    source: "return globalThis.Reflect.get['bind'](null, run, 'constructor')()(text)();",
    what: '`bind` read by text in brackets, of the global object',
  },
  {
    reads: ["Reflect.get.bind(null, run, 'constructor', ...rest)"],
    source: "return Reflect.get.bind(null, run, 'constructor', ...rest)()(text)();",
    what: 'a key before a spread',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run, 'name')();",
    what: 'another key, bound',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run)('name');",
    what: 'another key, given to the call',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(run, 'constructor')();",
    what: "`'constructor'` as what is read, the `this` taken first",
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run, 'name')('constructor');",
    what: 'a key the call is given after the one `bind` was',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, ...rest, 'constructor')();",
    what: 'a key past a spread of what `bind` is given',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, ...rest)(run, 'constructor');",
    what: 'a call past a spread of what `bind` is given',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(...args)(run, 'constructor');",
    what: 'a `this` that a spread may be',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run)(...rest, 'constructor');",
    what: 'a key past a spread of what the call is given',
  },
  {
    reads: [],
    source: 'return Reflect.get.bind(null, run);',
    what: 'a bound reader of no key',
  },
  {
    reads: [],
    source: "return reader.get.bind(null, run, 'constructor')();",
    what: 'a function of the module',
  },
] as const;

describe('a key reader of the language bound through bind', () => {
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
