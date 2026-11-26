import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Immediately selected mapper holders retain their own literal data member path. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly actualRefused?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'historical-holder-default-selected-error',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'holder-default-selected-data',
    source:
      'function frames(){return[undefined].flatMap((value:{failure:{stack:string}}|undefined={failure:{stack:"fixed"}})=>value)[0]!.failure.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'map-holder-default-selected-error',
    source:
      'function frames(error:Error){return[undefined].map((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-computed-holder-key',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!["failure"].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'lexical-constant-holder-key',
    source:
      'function frames(error:Error){const key="failure";return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]![key].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'deeper-literal-member-path',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{outer:{failure:Error}}|undefined={outer:{failure:error}})=>value)[0]!.outer.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-return-array-default',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>[value])[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-literal-holder-result',
    source: 'function frames(error:Error){return[0].map(()=>({failure:error}))[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-literal-array-holder-result',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[{failure:error}])[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-literal-scalar-holder-result',
    source:
      'function frames(error:Error){return[0].flatMap(()=>({failure:error}))[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-present-holder-input',
    source:
      'function frames(error:Error){return[{failure:error}].map(value=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-present-holder-input',
    source:
      'function frames(error:Error){return[{failure:error}].flatMap(value=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-default-literal-array-holder',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}[]|undefined=[{failure:error}])=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-default-nested-array-holder',
    source:
      'function frames(error:Error){return[undefined].map((value:[{failure:Error}]|undefined=[{failure:error}])=>value)[0]![0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flatmap-literal-nested-array-holder',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[[{failure:error}]])[0]![0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'present-data-skips-flatmap-error-default',
    source:
      'function frames(error:Error){return[{failure:{stack:"fixed"}}].flatMap((value:{failure:{stack?:string}}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'present-data-skips-map-error-default',
    source:
      'function frames(error:Error){return[{failure:{stack:"fixed"}}].map((value:{failure:{stack?:string}}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-error-default-message',
    source:
      'function frames(){return[undefined].flatMap((value:{failure:Error}|undefined={failure:new Error("fixed")})=>value)[0]!.failure.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'own-flatmap-data-implementation',
    source:
      'function frames(error:Error){const input=Object.assign([undefined],{flatMap(){return[{failure:{stack:"fixed"}}]}});return input.flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    actualRefused: true,
  },
  {
    id: 'getter-fixes-selected-error-stack',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={get failure(){Object.assign(error,{stack:"fixed"});return error;}})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'default-initializer-effect-before-read',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:(Object.assign(error,{stack:"fixed"}),error)})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-thisarg-effect-before-read',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value,(Object.assign(error,{stack:"fixed"}),0))[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'callback-prefix-effect-before-read',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>{Object.assign(error,{stack:"fixed"});return value;})[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'owner-prefix-effect-before-read',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-output-index-effect',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[(Object.assign(error,{stack:"fixed"}),0)]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-holder-field-effect',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]![(Object.assign(error,{stack:"fixed"}),"failure")].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-observation-key-effect',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure[(Object.assign(error,{stack:"fixed"}),"stack")];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'captured-prepare-effect-before-read',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return[undefined].flatMap((item:{failure:Error}|undefined={failure:value})=>item)[0]!.failure.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'saved-result-followed-by-source-write',
    source:
      'function frames(error:Error){const output=[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value);Object.assign(error,{stack:"fixed"});return output[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-data-keeps-ordinary-field',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:{stack:string}}|undefined={get failure(){return{stack:"fixed"}},ignored:error}as{failure:{stack:string}})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-spread-replaces-error-field',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:{stack?:string}}|undefined={failure:error,...({failure:{stack:"fixed"}}as{})})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-hole-is-skipped-before-default',
    source:
      'function frames(error:Error){return[,undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[0]!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'excluded-output-slot-skips-default',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{failure:Error}|undefined={failure:error})=>value)[1]?.failure.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nested-array-is-not-element-text',
    source:
      'function frames(error:Error){return[undefined].map((value:Error[]|undefined=[error])=>value)[0]!.length;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('nested mapper member readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-mapper-member.ts', source);
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

describe('shared nested mapper member admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, actualRefused = refused }) => {
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
    const expected = actualRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
