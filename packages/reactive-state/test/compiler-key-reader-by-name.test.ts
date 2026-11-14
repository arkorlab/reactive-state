import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function of the language's that reads a member by the key it is given (`Reflect.get`,
 * `Object.getOwnPropertyDescriptor`, `Reflect.getOwnPropertyDescriptor`) is read by name: a call that
 * writes the text `'constructor'` among its arguments, and holds one of the three in its callee or in
 * an argument — called, borrowed, bound, handed to `Reflect.apply`, put in a list — reads what made a
 * function, wherever the text stands among the arguments. A key the code does not write, a key that
 * is another text, and a reader the call does not hold are not read: a reader kept under a name of
 * the code's own is not followed.
 */
const CASES = [
  { id: 'direct-call-refused', source: "return Reflect.get(fn, 'constructor');", refused: true },
  {
    id: 'descriptor-of-the-key-refused',
    source: "return Object.getOwnPropertyDescriptor(fn, 'constructor');",
    refused: true,
  },
  {
    id: 'reflect-descriptor-refused',
    source: "return Reflect.getOwnPropertyDescriptor(fn, 'constructor');",
    refused: true,
  },
  {
    id: 'template-text-refused',
    source: 'return Reflect.get(fn, `constructor`);',
    refused: true,
  },
  {
    id: 'key-in-brackets-of-a-global-object-refused',
    source: "return globalThis['Reflect']['get'](fn, 'constructor');",
    refused: true,
  },
  {
    id: 'borrowed-call-with-the-text-as-the-this-refused',
    source: "return Reflect.get.call(fn, 'constructor');",
    refused: true,
  },
  {
    id: 'applied-with-the-text-as-the-receiver-refused',
    source: "return Reflect.get.apply(fn, ['constructor']);",
    refused: true,
  },
  {
    id: 'bound-with-the-text-first-refused',
    source: "return Reflect.get.bind(fn, 'constructor');",
    refused: true,
  },
  {
    id: 'bound-then-called-with-another-key-first-refused',
    source: "return Reflect.get.bind(null, fn, 'name')('constructor');",
    refused: true,
  },
  {
    id: 'reflect-apply-with-the-text-first-refused',
    source: "return Reflect.apply(Reflect.get, null, ['constructor', fn]);",
    refused: true,
  },
  {
    id: 'call-called-on-the-reader-refused',
    source: "return fn.call.call(Reflect.get, 'constructor');",
    refused: true,
  },
  {
    id: 'reader-in-a-list-mapped-refused',
    source: "return [Reflect.get].map((read) => read(fn, 'constructor'));",
    refused: true,
  },
  {
    id: 'readers-in-a-list-mapped-refused',
    source:
      "return [Reflect.get, Object.getOwnPropertyDescriptor].map((read) => read(fn, 'constructor'));",
    refused: true,
  },
  {
    id: 'reader-in-a-list-spread-into-a-call-refused',
    source: "return ((...list: any[]) => list)(...[Reflect.get], 'constructor');",
    refused: true,
  },
  {
    id: 'reader-in-a-comma-and-a-cast-refused',
    source: "return ((0, Reflect.get) as any)(fn, 'constructor');",
    refused: true,
  },
  {
    id: 'text-past-a-spread-refused',
    source: "return Reflect.get(fn, ...args, 'constructor');",
    refused: true,
  },
  { id: 'another-key-pin', source: "return Reflect.get(fn, 'name');", refused: false },
  {
    id: 'key-the-code-does-not-write-pin',
    source: 'return Reflect.get(fn, text);',
    refused: false,
  },
  {
    id: 'descriptor-of-another-key-pin',
    source: "return Object.getOwnPropertyDescriptor(fn, 'name');",
    refused: false,
  },
  {
    id: 'borrowed-call-of-another-key-pin',
    source: "return Reflect.get.call(null, fn, 'name');",
    refused: false,
  },
  {
    id: 'borrowed-call-of-a-key-the-code-does-not-write-pin',
    source: 'return Reflect.get.call(null, fn, text);',
    refused: false,
  },
  {
    id: 'bound-call-of-a-key-the-code-does-not-write-pin',
    source: 'return Reflect.get.bind(null, fn)(text);',
    refused: false,
  },
  {
    id: 'list-of-readers-mapped-with-another-key-pin',
    source: "return [Reflect.get].map((read) => read(fn, 'name'));",
    refused: false,
  },
  {
    id: 'the-text-beside-a-function-of-the-module-pin',
    source: "return reader.get(fn, 'constructor');",
    refused: false,
  },
  {
    id: 'the-text-handed-to-a-function-of-the-module-pin',
    source: "return run.call.call(reader.get, null, fn, 'constructor');",
    refused: false,
  },
  {
    id: 'a-reader-of-another-global-pin',
    source: "return Reflect.has(fn, 'constructor');",
    refused: false,
  },
] as const;

describe('a key reader of the language, read by name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether any node of the function `run`, whose body is `body`, reads what made code. */
  function refuses(body: string): boolean {
    const source = [
      'const reader = { get: (target: unknown, key: string) => key };',
      'export function run(text: string, args: unknown[], fn: () => void): unknown {',
      `  ${body}`,
      '}',
      '',
    ].join('\n');
    using parsed = api.createSourceFile('by-name.ts', source);
    let found = false;
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      found ||= readsCodeGlobal(node);
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('$id', ({ source, refused }) => {
    expect(refuses(source)).toBe(refused);
  });
});
