import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * The array `apply` is given is read past the casts that wrap it, in angle brackets as well as with
 * `as`: `Reflect.get.apply(null, <any>[run, 'constructor'])` reads the key of the array it is
 * given, as `Reflect.get.apply(null, [run, 'constructor'] as any)` does. A cast does not give the
 * array a name, nor move a spread before it.
 */

const CASES = [
  {
    reads: ["Reflect.get.apply(null, [run, 'constructor'] as any)"],
    source: "return Reflect.get.apply(null, [run, 'constructor'] as any)(text)();",
    what: 'an array in an `as` cast',
  },
  {
    reads: ["Reflect.get.apply(null, <any>[run, 'constructor'])"],
    source: "return Reflect.get.apply(null, <any>[run, 'constructor'])(text)();",
    what: 'an array in an angle-bracket cast',
  },
  {
    reads: ["Reflect.get.apply(null, (<any>[run, 'constructor']))"],
    source: "return Reflect.get.apply(null, (<any>[run, 'constructor']))(text)();",
    what: 'an angle-bracket cast in parentheses',
  },
  {
    reads: ["Reflect.get.apply(null, <any>([run, 'constructor'] as const))"],
    source: "return Reflect.get.apply(null, <any>([run, 'constructor'] as const))(text)();",
    what: 'an `as` cast within an angle-bracket cast',
  },
  {
    reads: ["Reflect.get.apply(null, (<any>[run, 'constructor']) satisfies unknown[])"],
    source:
      "return Reflect.get.apply(null, (<any>[run, 'constructor']) satisfies unknown[])(text)();",
    what: 'an angle-bracket cast within `satisfies`',
  },
  {
    reads: ["Reflect.get.apply(null, <unknown[]>(<any>[run, 'constructor']))"],
    source: "return Reflect.get.apply(null, <unknown[]>(<any>[run, 'constructor']))(text)();",
    what: 'angle-bracket casts one in another',
  },
  {
    reads: ["Reflect.get.apply(null, <any>[run, 'constructor']!)"],
    source: "return Reflect.get.apply(null, <any>[run, 'constructor']!)(text)();",
    what: 'a `!` within an angle-bracket cast',
  },
  {
    reads: [],
    source: "return Reflect.get.apply(null, <any>[run, 'name']);",
    what: 'another key, in an angle-bracket cast',
  },
  {
    reads: [],
    source: 'return Reflect.get.apply(null, <any>args);',
    what: 'an array it is given by a name, in an angle-bracket cast',
  },
  {
    reads: ["Reflect.get.apply(null, <any>[...rest, 'constructor'])"],
    source: "return Reflect.get.apply(null, <any>[...rest, 'constructor']);",
    what: 'an array in an angle-bracket cast, of which a spread hides the key',
  },
  {
    reads: ["Reflect.get.apply(...args, <any>[run, 'constructor'])"],
    source: "return Reflect.get.apply(...args, <any>[run, 'constructor']);",
    what: 'an array in an angle-bracket cast, after a spread that may be the `this`',
  },
  {
    reads: ["Reflect.get.apply(null, <any>[run, 'constructor'], ...rest)"],
    source: "return Reflect.get.apply(null, <any>[run, 'constructor'], ...rest)(text)();",
    what: 'an array in an angle-bracket cast, before a spread',
  },
] as const;

describe('the array of a key reader borrowed through apply, past its casts', () => {
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
