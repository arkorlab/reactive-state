import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function of the language's that reads a member by the key it is given, `Reflect.get`, reads it
 * however the code writes the call, as `Reflect.get(fn, 'constructor')` does: through `call`,
 * `apply` and `bind` — one of them given to another, `run.call.bind(Reflect.get)`,
 * or bound again, `Reflect.get.bind(null).bind(null, fn)` — and through `Reflect.apply`. The
 * methods of a function are those of any function, `fn.call`, `Reflect.get.call`. What each
 * of them is given after the `this` it takes reaches the reader in order, up to a spread, past which
 * where a value stands is for the code to tell. The key reads at the call that first gives it,
 * once: where a `bind` is given it, the `bind` is the read; where the call is, the call is. What the
 * code does not show — a function it holds by a name, an array it gives by a name, a key past a
 * spread — is not read.
 */

const CASES = [
  // `bind` of what `bind` made.
  {
    reads: ["Reflect.get.bind(null).bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run)('constructor')(text)();",
    what: 'a key the call of a reader bound twice is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).bind(null)('constructor')"],
    source: "return Reflect.get.bind(null, run).bind(null)('constructor')(text)();",
    what: 'a key given to the call of a reader bound again, given no arguments',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null)(run, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null)(run, 'constructor')(text)();",
    what: 'the function and the key given to the call of a reader bound twice',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null).bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null).bind(null).bind(null, run)('constructor')(text)();",
    what: 'a key the call of a reader bound three times is given',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run, 'constructor')()(text)();",
    what: 'a key the second `bind` is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).bind(null, 'constructor')"],
    source: "return Reflect.get.bind(null, run).bind(null, 'constructor')()(text)();",
    what: 'a key the second `bind` is given after the function',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run).call(null, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run).call(null, 'constructor')(text)();",
    what: 'a key the `call` of a reader bound twice is given',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run).apply(null, ['constructor'])"],
    source: "return Reflect.get.bind(null).bind(null, run).apply(null, ['constructor'])(text)();",
    what: 'a key the `apply` of a reader bound twice is given',
  },
  {
    reads: ["(0, Reflect.get.bind(null)).bind(null, run)('constructor')"],
    source: "return (0, Reflect.get.bind(null)).bind(null, run)('constructor')(text)();",
    what: 'a reader bound past a comma, then again',
  },
  // `call`, `apply` and `bind` given to a function: the methods of a function, bound or called.
  {
    reads: ["run.call.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get)(null, run, 'constructor')(text)();",
    what: '`call` of a function bound to the reader, called',
  },
  {
    reads: ["run.apply.bind(Reflect.get)(null, [run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`apply` bound to the reader, called',
  },
  {
    reads: ["run.bind.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return run.bind.bind(Reflect.get)(null, run, 'constructor')()(text)();",
    what: '`bind` bound to the reader, called',
  },
  {
    reads: ["Reflect.get.call.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return Reflect.get.call.bind(Reflect.get)(null, run, 'constructor')(text)();",
    what: '`call` of the reader bound to the reader',
  },
  {
    reads: ["Reflect.get.apply.bind(Reflect.get)(null, [run, 'constructor'])"],
    source: "return Reflect.get.apply.bind(Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`apply` of the reader bound to the reader',
  },
  {
    reads: ["run.call.bind(Reflect.get, null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get, null, run, 'constructor')()(text)();",
    what: 'a key `call` is bound to, with the reader',
  },
  {
    reads: ["run.call.bind(Reflect.get, null)(run, 'constructor')"],
    source: "return run.call.bind(Reflect.get, null)(run, 'constructor')(text)();",
    what: 'the key given to `call` bound to the reader and a `this`',
  },
  {
    reads: ["run.apply.bind(Reflect.get, null)([run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get, null)([run, 'constructor'])(text)();",
    what: 'the array given to `apply` bound to the reader and a `this`',
  },
  {
    reads: ["run.apply.bind(Reflect.get, null, [run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get, null, [run, 'constructor'])()(text)();",
    what: 'an array `apply` is bound to, with the reader and a `this`',
  },
  {
    reads: ["run.call.bind(Reflect.get).bind(null, null, run)('constructor')"],
    source: "return run.call.bind(Reflect.get).bind(null, null, run)('constructor')(text)();",
    what: '`call` bound to the reader, bound again',
  },
  {
    reads: ["run.call.bind(Reflect.get).call(null, null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get).call(null, null, run, 'constructor')(text)();",
    what: '`call` bound to the reader, borrowed',
  },
  {
    reads: ["run.apply.bind(Reflect.get).apply(null, [null, [run, 'constructor']])"],
    source: "return run.apply.bind(Reflect.get).apply(null, [null, [run, 'constructor']])(text)();",
    what: '`apply` bound to the reader, applied',
  },
  {
    reads: ["run.call.call(Reflect.get, null, run, 'constructor')"],
    source: "return run.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` called on the reader',
  },
  {
    reads: ["run.call.apply(Reflect.get, [null, run, 'constructor'])"],
    source: "return run.call.apply(Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` applied to the reader',
  },
  {
    reads: ["run.apply.call(Reflect.get, null, [run, 'constructor'])"],
    source: "return run.apply.call(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`apply` called on the reader',
  },
  {
    reads: ["run.apply.apply(Reflect.get, [null, [run, 'constructor']])"],
    source: "return run.apply.apply(Reflect.get, [null, [run, 'constructor']])(text)();",
    what: '`apply` applied to the reader',
  },
  {
    reads: ["run.bind.call(Reflect.get, null, run, 'constructor')"],
    source: "return run.bind.call(Reflect.get, null, run, 'constructor')()(text)();",
    what: '`bind` called on the reader, given a key',
  },
  {
    reads: ["run.bind.apply(Reflect.get, [null, run, 'constructor'])"],
    source: "return run.bind.apply(Reflect.get, [null, run, 'constructor'])()(text)();",
    what: '`bind` applied to the reader, given a key',
  },
  {
    reads: ["run.bind.call(Reflect.get, null, run)('constructor')"],
    source: "return run.bind.call(Reflect.get, null, run)('constructor')(text)();",
    what: 'a key the call of what `bind` made of the reader is given',
  },
  {
    reads: ["Reflect.get.call.call(Reflect.get, null, run, 'constructor')"],
    source: "return Reflect.get.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` of the reader, called on the reader',
  },
  {
    reads: ["(function () {}).call.call(Reflect.get, null, run, 'constructor')"],
    source: "return (function () {}).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` of another function, called on the reader',
  },
  // `Reflect.apply`.
  {
    reads: ["Reflect.apply(Reflect.get, null, [run, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, null, [run, 'constructor'])(text)();",
    what: 'the reader, applied by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(Reflect.get.bind(null, run), null, ['constructor'])"],
    source: "return Reflect.apply(Reflect.get.bind(null, run), null, ['constructor'])(text)();",
    what: 'a bound reader, applied by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(Reflect.get.call, Reflect.get, [null, run, 'constructor'])"],
    source:
      "return Reflect.apply(Reflect.get.call, Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` of the reader, applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(run.call, Reflect.get, [null, run, 'constructor'])"],
    source: "return Reflect.apply(run.call, Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(run.bind, Reflect.get, [null, run, 'constructor'])"],
    source: "return Reflect.apply(run.bind, Reflect.get, [null, run, 'constructor'])()(text)();",
    what: '`bind` applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["globalThis.Reflect.apply(Reflect.get, null, [run, 'constructor'])"],
    source: "return globalThis.Reflect.apply(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` read of the global object',
  },
  {
    reads: ["(0, Reflect.apply)(Reflect.get, null, [run, 'constructor'])"],
    source: "return (0, Reflect.apply)(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` read past a comma',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, <any>[run, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, null, <any>[run, 'constructor'])(text)();",
    what: 'an array in a cast in angle brackets, given to `Reflect.apply`',
  },
  // Optional chains and wrappers.
  {
    reads: ["Reflect.get?.bind(null, run)?.('constructor')"],
    source: "return Reflect.get?.bind(null, run)?.('constructor')?.(text)?.();",
    what: 'a reader bound and called through optional chains',
  },
  {
    reads: ["Reflect?.get.call?.(null, run, 'constructor')"],
    source: "return Reflect?.get.call?.(null, run, 'constructor')(text)();",
    what: 'a reader borrowed through optional chains',
  },
  {
    reads: ["Reflect.apply((0, Reflect.get), null, [run, 'constructor'])"],
    source: "return Reflect.apply((0, Reflect.get), null, [run, 'constructor'])(text)();",
    what: 'a reader given to `Reflect.apply` past a comma',
  },
  {
    reads: ["(<any>Reflect.get.bind(null)).bind(null, run)('constructor')"],
    source: "return (<any>Reflect.get.bind(null)).bind(null, run)('constructor')(text)();",
    what: 'a bound reader in a cast in angle brackets, bound again',
  },
  {
    reads: ["(Reflect.get.bind(null) as any).bind(null, run)('constructor')"],
    source: "return (Reflect.get.bind(null) as any).bind(null, run)('constructor')(text)();",
    what: 'a bound reader in a cast, bound again',
  },
  // Other readers.
  {
    reads: ["Object.getOwnPropertyDescriptor.bind(Object).bind(null, run)('constructor')"],
    source: "return Object.getOwnPropertyDescriptor.bind(Object).bind(null, run)('constructor');",
    what: '`Object.getOwnPropertyDescriptor` bound twice',
  },
  {
    reads: [
      "Reflect.getOwnPropertyDescriptor.apply.bind(Reflect.getOwnPropertyDescriptor)(Reflect, [run, 'constructor'])",
    ],
    source:
      "return Reflect.getOwnPropertyDescriptor.apply.bind(Reflect.getOwnPropertyDescriptor)(Reflect, [run, 'constructor']);",
    what: '`Reflect.getOwnPropertyDescriptor`, `apply` bound to it',
  },
  // A key written before a spread reads; one past it is for the code to tell.
  {
    reads: ["Reflect.get(run, 'constructor', ...rest)"],
    source: "return Reflect.get(run, 'constructor', ...rest)(text)();",
    what: 'a key written before a spread, given directly',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, [run, 'constructor', ...rest])"],
    source: "return Reflect.apply(Reflect.get, null, [run, 'constructor', ...rest])(text)();",
    what: 'a key before a spread, in the array `Reflect.apply` is given',
  },
  // What is not a read.
  {
    reads: [],
    source: "return Reflect.get(...[run, 'name'] as const, 'constructor');",
    what: 'a key past the spread of an array, given directly',
  },
  {
    reads: [],
    source: "return Reflect.get(...rest, 'constructor');",
    what: 'a key past a spread of a list given by a name, given directly',
  },
  {
    reads: [],
    source: "return Object.getOwnPropertyDescriptor(...args, 'constructor');",
    what: 'a key past a spread given to `Object.getOwnPropertyDescriptor`',
  },
  {
    reads: [],
    source: 'return Reflect.get(...args);',
    what: 'what a spread alone gives',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null).bind(null, run)('name');",
    what: 'another key, given to a reader bound twice',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run, 'name').bind(null)('constructor');",
    what: 'a key given after the one a bound reader already has',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run).bind(null, ...rest)('constructor');",
    what: 'a key past a spread of what `bind` is given the second time',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, ...rest).bind(null, run)('constructor');",
    what: 'a key past a spread of what `bind` is given the first time',
  },
  {
    reads: [],
    source: 'return Reflect.get.bind(null).bind(null, run);',
    what: 'a reader bound twice, called not at all',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(run, 'constructor').bind(null)();",
    what: "`'constructor'` as what is read, the `this` taken first, bound twice",
  },
  {
    reads: [],
    source: "return run.call.bind(Reflect.get)(null, run, 'name');",
    what: 'another key, given to `call` bound to the reader',
  },
  {
    reads: [],
    source: "return run.call.bind(Reflect.get)('constructor');",
    what: "`'constructor'` as the `this` `call` bound to the reader takes",
  },
  {
    reads: [],
    source: 'return run.apply.bind(Reflect.get)(null, args);',
    what: 'an array given to `apply` bound to the reader by a name',
  },
  {
    reads: [],
    source: "return run.call.call(Reflect.get, null, run, 'name');",
    what: 'another key, given to `call` called on the reader',
  },
  {
    reads: [],
    source: "return run.call.call(Reflect.get, 'constructor');",
    what: "`'constructor'` as the `this` of `call` called on the reader",
  },
  {
    reads: [],
    source: "return run.call.call(...args, null, run, 'constructor');",
    what: 'a function `call` is called on that a spread may be',
  },
  {
    reads: [],
    source: "return Reflect.apply(Reflect.get, null, [run, 'name']);",
    what: 'another key, given to `Reflect.apply`',
  },
  {
    reads: [],
    source: 'return Reflect.apply(Reflect.get, null, args);',
    what: 'an array given to `Reflect.apply` by a name',
  },
  {
    reads: [],
    source: "return Reflect.apply(Reflect.get, null, [...rest, 'constructor']);",
    what: 'a key past a spread in the array `Reflect.apply` is given',
  },
  {
    reads: [],
    source: "return Reflect.apply(...args, null, [run, 'constructor']);",
    what: 'a function `Reflect.apply` is given by a spread',
  },
  {
    reads: [],
    source: "return Reflect.apply(Reflect.get, null, ['constructor', run]);",
    what: "`'constructor'` as what is read, the first given",
  },
  {
    reads: [],
    source: "return Reflect.apply(fn, null, [run, 'constructor']);",
    what: 'a function `Reflect.apply` is given that is not a reader',
  },
  {
    reads: [],
    source: "return reader.get.bind(null).bind(null, run)('constructor');",
    what: 'a function of the module, bound twice',
  },
  {
    reads: [],
    source: "return run.call.bind(reader.get)(null, run, 'constructor');",
    what: 'a function of the module, `call` bound to it',
  },
  {
    reads: [],
    source: "return run.call.call(reader.get, null, run, 'constructor');",
    what: 'a function of the module, `call` called on it',
  },
] as const;

describe('a key reader of the language called through call, apply, bind and Reflect.apply', () => {
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
      'export function run(text: string, rest: unknown[], args: unknown[], fn: () => void): unknown {',
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
