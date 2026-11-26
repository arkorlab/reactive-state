import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Recursive written patterns normalize whole-any members before alternatives. */
const CASES = [
  {
    id: 'reported-property-whole-any',
    source:
      'type Failure = {value:any|string} extends {value:number} ? Error:{stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'property-whole-any-reverse',
    source:
      'type Failure = {value:string|any} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'callable-result-whole-any',
    source:
      'type Failure = (()=>any|string) extends (()=>number) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'construct-result-whole-any',
    source:
      'type Failure = (new()=>any|string) extends (new()=>number) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'method-result-whole-any',
    source:
      'type Failure = {read():any|string} extends {read():number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'tuple-item-whole-any',
    source:
      'type Failure = [any|string] extends [number] ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'property-alias-actual-environment',
    source:
      'type Wrapped<T> = {value:T|string}; type Select<T> = Wrapped<T> extends {value:number} ? Error : {stack:string}; type Failure = Select<any>; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'nested-inferred-property-whole-any',
    source:
      'type Failure = {value:any|string} extends {value:infer Item} ? ({value:Item} extends {value:number} ? Error : {stack:string}) : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'never-target-keeps-data',
    source:
      'type Failure = {value:any|string} extends {value:never} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'ordinary-union-keeps-data',
    source:
      'type Failure = {value:number|string} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'unknown-checked-keeps-data',
    source:
      'type Failure = {value:unknown|string} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'any-target-keeps-relation',
    source:
      'type Failure = {value:unknown} extends {value:any|string} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'unknown-target-keeps-relation',
    source:
      'type Failure = {value:any|string} extends {value:unknown} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'explicit-any-prior-pin',
    source:
      'type Failure = {value:any} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'overloaded-result-prior-pin',
    source:
      'interface Source {read():any|string;read():number} type Failure = Source extends {read():number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'synthetic-await-placeholder-keeps-data',
    source:
      'type Thenable = {then(resolve:(value:number)=>void):void}; type Failure = {value:Awaited<Thenable>|string} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
] as const;

describe('nested whole-any pattern readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-any-patterns.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with nested whole-any patterns', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const unsettled = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(unsettled).toStrictEqual(refused ? [true] : []);
  });
});

/** Stack observations are read through the original native compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
