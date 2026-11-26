import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Local generic, callable, accessor and tuple selections keep their source-written results. */
const CASES = [
  {
    group: 'references',
    id: 'reference-interface-error',
    definitions: 'interface Box<T>{value:T}type Failure=Box<Error> extends Box<infer U>?U:never;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'references',
    id: 'reference-interface-data',
    definitions:
      'interface Box<T>{value:T}type Failure=Box<{stack:string}> extends Box<infer U>?U:never;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'references',
    id: 'reference-class-error',
    definitions: 'class Box<T>{value!:T}type Failure=Box<Error> extends Box<infer U>?U:never;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'references',
    id: 'reference-default-error',
    definitions: 'interface Box<T=Error>{value:T}type Failure=Box extends Box<infer U>?U:never;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'references',
    id: 'reference-distinct-declaration-data',
    definitions:
      'interface Box<T>{value:T}interface Other<T>{other:T}type Failure=Other<Error> extends Box<infer U>?U:{stack:string};',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-call-error',
    definitions: 'type Result<T>=T extends {():infer R}?R:never;type Failure=Result<{():Error}>;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-call-data',
    definitions:
      'type Result<T>=T extends {():infer R}?R:never;type Failure=Result<{():{stack:string}}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-construct-error',
    definitions:
      'type Result<T>=T extends {new():infer R}?R:never;type Failure=Result<{new():Error}>;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-construct-data',
    definitions:
      'type Result<T>=T extends {new():infer R}?R:never;type Failure=Result<{new():{stack:string}}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-required-arity-data',
    definitions:
      'type Result<T>=T extends {(value?:string):infer R}?R:{stack:string};type Failure=Result<{(value:number):Error}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-overload-last-error',
    definitions:
      'type Result<T>=T extends {():infer R}?R:never;type Failure=Result<{():{stack:string};():Error}>;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'callable',
    id: 'anonymous-overload-last-data',
    definitions:
      'type Result<T>=T extends {():infer R}?R:never;type Failure=Result<{():Error;():{stack:string}}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'accessors',
    id: 'accessor-setter-first-error',
    definitions:
      'type Result<T>=T extends {value:infer R}?R:never;type Failure=Result<{set value(next:{stack?:string});get value():Error}>;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'accessors',
    id: 'accessor-getter-first-error',
    definitions:
      'type Result<T>=T extends {value:infer R}?R:never;type Failure=Result<{get value():Error;set value(next:{stack?:string})}>;',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'accessors',
    id: 'accessor-setter-first-data',
    definitions:
      'type Result<T>=T extends {value:infer R}?R:never;type Failure=Result<{set value(next:Error);get value():{stack:string}}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'accessors',
    id: 'accessor-getter-first-data',
    definitions:
      'type Result<T>=T extends {value:infer R}?R:never;type Failure=Result<{get value():{stack:string};set value(next:Error)}>;',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'tuples',
    id: 'tuple-fixed-prefix-error',
    definitions: 'type Failure=[Error,...string[]][0];',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'tuples',
    id: 'tuple-fixed-prefix-data',
    definitions: 'type Failure=[{stack:string},...Error[]][0];',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
  {
    group: 'tuples',
    id: 'tuple-finite-rest-suffix-error',
    definitions: 'type Failure=[...[string,string],Error][2];',
    refused: true,
    argument: 'new Error("ours") as Failure',
  },
  {
    group: 'tuples',
    id: 'tuple-finite-rest-suffix-data',
    definitions: 'type Failure=[...[Error,Error],{stack:string}][2];',
    refused: false,
    argument: '{stack:"fixed"} as Failure',
  },
];

describe('written type pattern edge readers', () => {
  it.each(CASES)('$id', ({ definitions, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'type-pattern-edges.ts',
      `${definitions}function read(error:Failure){return error.stack;}`,
    );
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared written type pattern edges', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ definitions, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        definitions,
        'function read(error:Failure){return error.stack;}',
        `export function normalizeFilter(value:string):TodoFilter{return String(read(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
