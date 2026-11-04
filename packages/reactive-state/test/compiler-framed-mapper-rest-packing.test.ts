import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native mapper rest bindings pack callback arguments before selected members are read. */
const CASES = [
  {
    id: 'reported-map-rest-array',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>values)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-array-alias',
    source:
      'function frames(error:Error){const mapper=(...values:unknown[])=>values;return ([error].map(mapper)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-first-member',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>values[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-computed-member',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>values["0"])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-input-member',
    source:
      'function frames(error:Error){return ([{failure:error}].map((...values:unknown[])=> (values[0] as {failure:unknown}).failure)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-member-alias',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{const held=values;return held[0];})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-destructured',
    source:
      'function frames(error:Error){return ([error].map((...[value]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-object-pattern',
    source:
      'function frames(error:Error){return ([error].map((...{0:value}:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-destructured-default',
    source:
      'function frames(error:Error){return ([undefined].map((...[value=error]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-first-present-default-data',
    source:
      'function frames(error:Error){return ([{stack:"fixed"}].map((...[value=error]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-first-default-input',
    source:
      'function frames(error:Error){return ([error].map((...[value={stack:"fixed"}]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-index-data',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>values[1])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-receiver-data',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>values[2])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-receiver-member',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=> (values[2] as unknown[])[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-after-value-rest-index-data',
    source:
      'function frames(error:Error){return ([error].map((value,...values:unknown[])=>values[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-after-value-rest-receiver-member',
    source:
      'function frames(error:Error){return ([error].map((value,...values:unknown[])=> (values[1] as unknown[])[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-after-index-rest-receiver-member',
    source:
      'function frames(error:Error){return ([error].map((value,index,...values:unknown[])=> (values[0] as unknown[])[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-after-value-rest-whole-data',
    source:
      'function frames(error:Error){return ([error].map((value,...values:unknown[])=>values)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-map-rest-first-member',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>values[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-rest-written-member',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>[values[0]])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-rest-whole-flattens-input',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>values)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-rest-whole-index-slot-data',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>values)[1] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'ordinary-positional-input',
    source: 'function frames(error:Error){return [error].map((value)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-destructured-input',
    source:
      'function frames(error:Error){return [{failure:error}].map(({failure})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-default-input',
    source:
      'function frames(error:Error){return ([undefined].map((value:Error=error)=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-data-map',
    source: 'function frames(error:Error){return [{stack:"fixed"}].map(value=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'ordinary-data-flat-map',
    source:
      'function frames(error:Error){return [{stack:"fixed"}].flatMap(value=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-selected-data-stays-data',
    source:
      'function frames(error:Error){return ([{stack:"fixed"}].map((...values:unknown[])=>values[0])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-container-first-member',
    source:
      'function frames(error:Error){return (([error].map((...values:unknown[])=>values)[0] as unknown[])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-container-index-data',
    source:
      'function frames(error:Error){return (([error].map((...values:unknown[])=>values)[0] as unknown[])[1] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-container-receiver-member',
    source:
      'function frames(error:Error){return ((([error].map((...values:unknown[])=>values)[0] as unknown[])[2] as unknown[])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-index-default-skipped',
    source:
      'function frames(error:Error){return ([error].map((...[,index=error]:unknown[])=>index)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-missing-default',
    source:
      'function frames(error:Error){return ([error].map((...[,,,missing=error]:unknown[])=>missing)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-nested-default',
    source:
      'function frames(error:Error){return ([{failure:undefined}].map((...[{failure=error}]:[{failure?:Error},number,{failure?:Error}[]])=>failure)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-reassigned-native-error',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{values=error as unknown as unknown[];return values;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-rest-reassigned-data-member',
    source:
      'function frames(error:Error){return (([error].map((...values:unknown[])=>{values=[{stack:"fixed"}];return values;})[0] as unknown[])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-rest-written-error-member',
    source:
      'function frames(error:Error){return ([0].map((...values:unknown[])=>{values=[error];return values[0];})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-rest-pattern-default',
    source:
      'function frames(error:Error){return ([undefined].flatMap((...[value=error]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-rest-pattern-present-data',
    source:
      'function frames(error:Error){return ([{stack:"fixed"}].flatMap((...[value=error]:unknown[])=>value)[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-map-rest-returned-receiver',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>values[2])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-map-conditional-rest-array',
    source:
      'function frames(error:Error){return ([error].flatMap((...values:unknown[])=>error.name?values:[])[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'peer-rest-slot-data-replacement',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{const ignored=(values[0]={stack:"fixed"});return values[0];})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'peer-rest-container-prototype-error',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{const ignored=Object.setPrototypeOf(values,error);return values;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'peer-rest-alias-prototype-error',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{const held=values;const ignored=Object.setPrototypeOf(held,error);return held;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'peer-rest-opaque-pack-exposure',
    source:
      'function install(values:unknown[],error:Error){Object.setPrototypeOf(values,error);}function frames(error:Error){return ([error].map((...values:unknown[])=>{const ignored=install(values,error);return values;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'peer-rest-dormant-function-pin',
    source:
      'function frames(error:Error){return ([error].map((...values:unknown[])=>{const ignored=()=>Object.setPrototypeOf(values,error);return values;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'peer-rest-whole-reassignment-from-data-pin',
    source:
      'function frames(error:Error){return ([0].map((...values:unknown[])=>{values=error as unknown as unknown[];return values;})[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
];

describe('mapper rest packing readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('mapper rest packing admissions', () => {
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
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
