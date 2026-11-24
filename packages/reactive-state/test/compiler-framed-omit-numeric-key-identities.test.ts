import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Omit distinguishes the type identities of numeric and string keys before runtime selection. */
const CASES = [
  {
    id: 'numeric-zero-survives-string-literal',
    source:
      'type Failure=Omit<{0:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'numeric-zero-survives-string-domain',
    source:
      'type Failure=Omit<{0:Error},string>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'computed-numeric-survives-string',
    source:
      'type Failure=Omit<{[0]:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'hex-numeric-survives-decimal-string',
    source:
      'type Failure=Omit<{0xA:Error},"10">;function frames(value:Failure){return value[10].stack;}',
    invocation: 'frames({[10]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[10],Error>>;',
  },
  {
    id: 'negative-numeric-survives-string',
    source:
      'type Failure=Omit<{[-1]:Error},"-1">;function frames(value:Failure){return value[-1].stack;}',
    invocation: 'frames({[-1]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[-1],Error>>;',
  },
  {
    id: 'string-zero-survives-numeric-literal',
    source:
      'type Failure=Omit<{"0":Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'string-zero-survives-number-domain',
    source:
      'type Failure=Omit<{"0":Error},number>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'computed-string-survives-numeric',
    source:
      'type Failure=Omit<{["0"]:Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'aliased-string-key-survives-numeric',
    source:
      'type Key="0";type Failure=Omit<{0:Error},Key>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'numeric-const-name-survives-string',
    source:
      'const KEY=0;type Failure=Omit<{[KEY]:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'string-const-name-survives-number',
    source:
      'const KEY="0";type Failure=Omit<{[KEY]:Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'numeric-index-survives-string',
    source:
      'type Failure=Omit<{[key:number]:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'array-index-survives-string-domain',
    source:
      'type Failure=Omit<readonly Error[],string>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'record-numeric-key-survives-string',
    source:
      'type Failure=Omit<Record<0,Error>,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'record-string-key-survives-number',
    source:
      'type Failure=Omit<Record<"0",Error>,0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'record-number-domain-survives-string',
    source:
      'type Failure=Omit<Record<number,Error>,string>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'never-keeps-numeric-error-pin',
    source:
      'type Failure=Omit<{0:Error},never>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'unrelated-omission-keeps-error-pin',
    source:
      'type Failure=Omit<{0:Error;other:string},"other">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'ordinary-data-survives-numeric-key-pin',
    source:
      'type Failure=Omit<{"0":{stack:string}},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({[0]:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'generic-default-key-retains-error',
    source:
      'type Drop<T={0:Error},K extends PropertyKey="0">=Omit<T,K>;type Failure=Drop;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'generic-actual-key-retains-error',
    source:
      'type Drop<T,K extends PropertyKey>=Omit<T,K>;type Failure=Drop<{0:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'interface-numeric-key-retains-error',
    source:
      'interface Box{0:Error}type Failure=Omit<Box,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'inherited-numeric-key-retains-error',
    source:
      'interface Parent{0:Error}interface Box extends Parent{}type Failure=Omit<Box,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'nested-omit-retains-numeric-error',
    source:
      'type Failure=Omit<Omit<{0:Error;other:string},"other">,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'numeric-key-omitted-by-number-pin',
    source:
      'type Removed=Omit<{0:Error},0>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'string-key-omitted-by-string-pin',
    source:
      'type Removed=Omit<{"0":Error},"0">;type Failure=Removed&{"0":{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'both-key-kinds-omitted-pin',
    source:
      'type Removed=Omit<{0:Error},0|"0">;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'string-const-omitted-by-string-pin',
    source:
      'const KEY="0";type Removed=Omit<{[KEY]:Error},"0">;type Failure=Removed&{"0":{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'local-omit-shadow-data-pin',
    source:
      'type Omit<T,K>={0:{stack:string}};type Failure=Omit<{0:Error},"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'domain-numeric-index-literal-exclusion',
    source:
      'type Failure=Omit<{[key:number]:Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-array-literal-exclusion',
    source:
      'type Failure=Omit<readonly Error[],0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-record-number-literal-exclusion',
    source:
      'type Failure=Omit<Record<number,Error>,0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-record-string-literal-exclusion',
    source:
      'type Failure=Omit<Record<string,Error>,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-explicit-member-with-number-index',
    source:
      'type Failure=Omit<{[key:number]:Error;0:Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-inherited-index-with-explicit-member',
    source:
      'interface Base{[key:number]:Error}interface Box extends Base{0:Error}type Failure=Omit<Box,0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-inherited-member-with-explicit-index',
    source:
      'interface Base{0:Error}interface Box extends Base{[key:number]:Error}type Failure=Omit<Box,0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-tuple-string-position-keeps-number-index',
    source:
      'type Failure=Omit<readonly [Error],"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'domain-pick-finite-numeric-key-is-removed',
    source:
      'type Removed=Omit<Pick<Record<number,Error>,0>,0>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'domain-record-broad-number-domain-is-removed',
    source:
      'type Removed=Omit<Record<number,Error>,number>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'domain-record-finite-numeric-key-is-removed',
    source:
      'type Removed=Omit<Record<0,Error>,0>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'domain-numeric-index-domain-is-removed',
    source:
      'type Removed=Omit<{[key:number]:Error},number>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<keyof Removed,never>>;',
  },
  {
    id: 'transparent-identity-mapped-matching-key',
    source:
      'type Copy<T>={[P in keyof T]:T[P]};type Removed=Omit<Copy<{0:Error}>,0>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'transparent-readonly-array-matching-number-domain',
    source:
      'type Removed=Omit<readonly Error[],number>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames(Object.assign([],{0:{stack:"fixed"}}))',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'transparent-readonly-tuple-matching-both-domains',
    source:
      'type Removed=Omit<readonly [Error],string|number>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames(Object.assign([],{0:{stack:"fixed"}}))',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'transparent-generic-index-literal-is-retained',
    source:
      'type Num<T>=number;type Failure=Omit<{[k:Num<string>]:Error;0:Error},0>;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
  {
    id: 'transparent-generic-index-matching-domain',
    source:
      'type Num<T>=number;type Removed=Omit<{[k:Num<string>]:Error;0:Error},number>;type Failure=Removed&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:{stack:"fixed"}})',
    refused: false,
    nativeExpected: 'fixed',
    semantic: 'type Retained=Assert<Equal<Failure[0],{stack:string}>>;',
  },
  {
    id: 'transparent-identity-mapped-wrong-string-key',
    source:
      'type Copy<T>={[P in keyof T]:T[P]};type Failure=Omit<Copy<{0:Error}>,"0">;function frames(value:Failure){return value[0].stack;}',
    invocation: 'frames({0:new Error("ours")})',
    refused: true,
    nativeExpected: 'stack',
    semantic: 'type Retained=Assert<Equal<Failure[0],Error>>;',
  },
] as const;

describe('numeric Omit readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'numeric-omit.ts', source);
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

describe('shared numeric Omit results', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
