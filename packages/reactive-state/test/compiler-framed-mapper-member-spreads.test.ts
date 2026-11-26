import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'raw-spread-input-member',
    source:
      'function frames(error:Error){return([{failure:error}].map(...([(value:{failure:unknown})=>value.failure]as const))[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-callback-tuple-alias',
    source:
      'function frames(error:Error){const mapper=(value:{failure:unknown})=>value.failure;const args=[mapper]as const;return([{failure:error}].map(...args)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-result-const-alias',
    source:
      'function frames(error:Error){return([{failure:error}].map(...([(value:{failure:unknown})=>{const selected=value.failure;return selected;}]as const))[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-flatmap-array-member',
    source:
      'function frames(error:Error){return([{failure:error}].flatMap(...([(value:{failure:unknown})=>[value.failure]]as const))[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-borrowed-input-member',
    source:
      'function frames(error:Error){return((Array.prototype.map.call as(receiver:{failure:unknown}[],callback:(value:{failure:unknown})=>unknown)=>unknown[])([{failure:error}],...([(value:{failure:unknown})=>value.failure]as const))[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-selected-field-data',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}},{failure:error}].map(...([(value:{failure:unknown})=>value.failure]as const))[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-member-ignored-mutation',
    source:
      'function frames(error:Error){return(([{failure:error}].map as(...args:unknown[])=>unknown[])(...([(value:{failure:unknown})=>value.failure,undefined,Object.assign(error,{stack:"fixed"})]as const))[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-spread-member-callback-mutation',
    source:
      'function frames(error:Error){return([{failure:error}].map(...([(value:{failure:unknown})=>{const changed=Object.assign(error,{stack:"fixed"});return value.failure;}]as const))[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'map-call-member-mapper',
    source:
      'function mappers():[(value:{failure:unknown})=>unknown]{return [(value)=>value.failure];}function frames(error:Error){return ([{failure:error}].map(...mappers())[0] as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-call-member-titled-pin',
    source:
      "function mappers():[(value:{failure:{stack?:string;title:string}})=>{stack?:string;title:string}]{return [(value)=>value.failure];}function frames(error:Error){void error;return [{failure:{stack:'fixed',title:'t'}}].map<{stack?:string;title:string}>(...mappers())[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('composed mapper member spread readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('composed mapper member spread shared', () => {
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
