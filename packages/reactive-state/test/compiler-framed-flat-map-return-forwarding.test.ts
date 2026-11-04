import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'flatmap-literal-spread-error',
    source: 'function frames(error:Error){return[0].flatMap(()=>[...[error]])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-return-array-parameter',
    source: 'function frames(errors:Error[]){return[0].flatMap(()=>errors)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'flatmap-nested-spread-alias',
    source:
      'function frames(error:Error){const items=[error];return[0].flatMap(()=>[...items])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-hole-spread-selected-error',
    source: 'function frames(error:Error){return[0].flatMap(()=>[...[,error]])[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-hole-spread-selected-data',
    source: 'function frames(error:Error){return[0].flatMap(()=>[...[,error]])[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-literal-spread-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[{stack:"fixed"}]])[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-borrowed-spread-error',
    source:
      'function frames(error:Error){return(Array.prototype.flatMap.call as(receiver:number[],callback:()=>Error[])=>Error[])([0],()=>[...[error]])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-empty-input-data',
    source:
      'function frames(error:Error){return([]as number[]).flatMap(()=>[...[error]])[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-spread-prefix-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[{stack:"fixed"},...[error]])[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-spread-suffix-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[error],{stack:"fixed"}])[1]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-local-array-alias',
    source:
      'function frames(error:Error){return[0].flatMap(()=>{const items=[error];return[...items];})[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-local-whole-array-parameter-alias',
    source:
      'function frames(errors:Error[]){return[0].flatMap(()=>{const items=errors;return items;})[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'readonly-array-parameter-return',
    source: 'function frames(errors:readonly Error[]){return[0].flatMap(()=>errors)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'named-callback-spread-return',
    source:
      'function frames(error:Error){const mapper=()=>[...[error]];const same=mapper;return[0].flatMap(same)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'first-mapper-parameter-spread',
    source:
      'function frames(error:Error){return[error].flatMap((value:Error)=>[...[value]])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-source-data-position',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].flatMap(value=>[...[value]])[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-source-error-position',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].flatMap(value=>[...[value]])[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'earlier-owner-callback-bridge-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return[0].flatMap(()=>[...[value]])[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'earlier-callback-const-effect-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>{const prepared=Object.assign(error,{stack:"fixed"});return[...[error]];})[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'evaluated-ignored-tail-data',
    source:
      'function frames(error:Error){return([0].flatMap as(...args:unknown[])=>Error[])(()=>[...[error]],undefined,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-ignored-tail-positive',
    source:
      'function frames(error:Error){return([0].flatMap as(...args:unknown[])=>Error[])(()=>[...[error]],undefined,0)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-later-write-data',
    source:
      'function frames(error:Error){const values=[0].flatMap(()=>[...[error]]);Object.assign(error,{stack:"fixed"});return values[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-selected-index-effect-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[error]])[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'overridden-spread-iterator-data',
    source:
      'function frames(error:Error){const values=[error];values[Symbol.iterator]=()=>[{stack:"fixed"}as Error][Symbol.iterator]();return[0].flatMap(()=>[...values])[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-own-flatmap-data',
    source:
      'function frames(error:Error){const values={flatMap(_callback:()=>Error[]){return[{stack:"fixed"}];}};return values.flatMap(()=>[...[error]])[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'locally-written-error-words-data',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[new Error("ours")]])[0]!.message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'locally-made-error-stack',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[new Error("ours")]])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-outer-owner-error-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});function read(){return[0].flatMap(()=>[...[error]])[0]!.stack;}return read();}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nonliteral-array-empty-input-data',
    source: 'function frames(errors:Error[]){return([]as number[]).flatMap(()=>errors)[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'nested-array-is-not-a-flat-scalar',
    source:
      'function frames(error:Error){return([0].flatMap(()=>[...[[error]]])[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native flatMap expanded return words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'flat-map-returns.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared native flatMap expanded return admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
