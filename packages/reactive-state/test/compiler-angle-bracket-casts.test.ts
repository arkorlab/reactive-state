import { isVariableStatement, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { globalPathOf, isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A cast in angle brackets, `<any>globalThis`, is a cast as `globalThis as any` is: it hands on the
 * value it is written of, and a read of a global through it is the global's read. A module of `.ts`
 * may write one, though a `.tsx` may not; `unwrapped` leaves it, so the reads of a global look
 * through it themselves — the path of a global, a key written as text, `<string>'eval'`.
 */

const PATHS = [
  {
    path: ['eval'],
    source: '(<any>globalThis).eval',
    what: 'a member of the global object, cast',
  },
  {
    path: ['eval'],
    source: "(<any>globalThis)['eval']",
    what: 'a member of the global object by text, cast',
  },
  {
    path: ['Function'],
    source: '(<typeof globalThis>self).Function',
    what: 'a member of another global object, cast',
  },
  { path: ['Math', 'random'], source: '(<any>Math).random', what: 'a member of a global, cast' },
  { path: ['Math', 'random'], source: '<any>Math.random', what: "a cast over a global's member" },
  {
    path: ['eval'],
    source: '<any>(<any>globalThis).eval',
    what: 'a cast over a member of a cast',
  },
  { path: ['Reflect', 'get'], source: '(0, <any>Reflect.get)', what: 'a cast after a comma' },
  { path: ['eval'], source: "globalThis[<string>'eval']", what: 'a key cast' },
  {
    path: ['eval'],
    source: "globalThis[<string>('eval' as string)]",
    what: 'a key cast over an `as`',
  },
  { path: ['Math', 'random'], source: '(Math as any).random', what: 'a global, cast with `as`' },
  { path: undefined, source: '(<any>local).random', what: 'a name of the module, cast' },
  { path: undefined, source: 'globalThis[<string>key]', what: 'a key the code computes, cast' },
] as const;

const READS = [
  {
    reads: ['(<any>globalThis).eval'],
    source: 'return (<any>globalThis).eval(text);',
    what: 'eval of the global object, cast',
  },
  {
    reads: ["(<any>globalThis)['Function']"],
    source: "return (<any>globalThis)['Function'](text)();",
    what: 'Function of the global object by text, cast',
  },
  {
    reads: ['(<any>process).binding'],
    source: "return (<any>process).binding('fs');",
    what: "a loader of Node's `process`, cast",
  },
  {
    reads: ['(<any>globalThis).process.binding'],
    source: "return (<any>globalThis).process.binding('fs');",
    what: 'a loader of `process` of the global object, cast',
  },
  {
    reads: ["(<any>Reflect).get(run, 'constructor')"],
    source: "return (<any>Reflect).get(run, 'constructor')(text)();",
    what: 'what made a function, by a read of the language, cast',
  },
  {
    reads: ["(<any>Reflect.get)(run, 'constructor')"],
    source: "return (<any>Reflect.get)(run, 'constructor')(text)();",
    what: 'what made a function, by a read cast',
  },
  {
    reads: ["Reflect.get(run, <string>'constructor')"],
    source: "return Reflect.get(run, <string>'constructor')(text)();",
    what: 'what made a function, by a key cast',
  },
  {
    reads: ["run[<'constructor'>'constructor']"],
    source: "return run[<'constructor'>'constructor'](text)();",
    what: 'what made a function, by a member in brackets, cast',
  },
  {
    reads: ["[<string>'constructor']: made"],
    source: "const { [<string>'constructor']: made } = run;\n  return made(text)();",
    what: 'what made a function, by a pattern of a key cast',
  },
  {
    reads: ['globalThis'],
    source: 'return globalThis[<string>text];',
    what: 'the global object, by a key the code computes, cast',
  },
  {
    reads: [],
    source: 'return (<any>globalThis).crypto.subtle;',
    what: 'a member of the global object, cast, by a name',
  },
  {
    reads: [],
    source: "return globalThis[<string>'crypto'];",
    what: 'a member of the global object by text, a key cast',
  },
  {
    reads: [],
    source: "return typeof (<any>globalThis).eval === 'function';",
    what: 'a test of a global, cast',
  },
  {
    reads: [],
    source: 'return (<any>globalThis).Math.random();',
    what: 'a global that makes no code, cast',
  },
  {
    reads: [],
    source: "return (<any>Reflect).get(run, 'name');",
    what: 'a read of another key of the language, cast',
  },
  { reads: [], source: 'return (<any>text).eval(text);', what: 'a name of the function, cast' },
] as const;

describe('a global read through a cast in angle brackets', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `globalPathOf` reads of `source`, what a constant is declared of, past its parentheses. */
  function pathOf(source: string): readonly string[] | undefined {
    using parsed = api.createSourceFile('casts.ts', `const local = 1;\nconst value = ${source};\n`);
    const statement = parsed.sourceFile.statements[1];
    const initializer =
      statement !== undefined && isVariableStatement(statement)
        ? statement.declarationList.declarations[0]?.initializer
        : undefined;
    if (initializer === undefined) {
      throw new Error(`No constant is declared of ${source}.`);
    }
    return globalPathOf(unwrapped(initializer));
  }

  /** The text of each node of `run`, a function whose body is `body`, that reads what makes code. */
  function codeReadsIn(body: string): readonly string[] {
    const source = `export function run(text: string): unknown {\n  ${body}\n}\n`;
    using parsed = api.createSourceFile('casts.ts', source);
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

  it.each(PATHS)('reads the path of $what', ({ path, source }) => {
    expect(pathOf(source)).toStrictEqual(path);
  });

  it.each(READS)('reads $what', ({ reads, source }) => {
    expect(codeReadsIn(source)).toStrictEqual(reads);
  });
});
