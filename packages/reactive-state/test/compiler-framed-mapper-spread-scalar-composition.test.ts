import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'spread-default-scalar-error',
    source:
      'function frames(error:Error){return[undefined].flatMap(...([(value:Error|undefined=error)=>value]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-replaced-scalar-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap(...([(value:{stack?:string})=>{const ignored=(value=error);return value;}]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-default-multiple-scalars',
    source:
      'function frames(error:Error){return[{stack:"fixed"},undefined].flatMap(...([(value:{stack?:string}|undefined=error)=>value]as const))[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-default-array-error',
    source:
      'function frames(error:Error){return[undefined].flatMap(...([(value:Error[]|undefined=[error])=>value]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-skipped-default-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap(...([(value:{stack?:string}|undefined=error)=>value]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-default-ignored-tail-data',
    source:
      'function frames(error:Error){return([undefined].flatMap as(...args:unknown[])=>Error[])(...([(value:Error|undefined=error)=>value,undefined,Object.assign(error,{stack:"fixed"})]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-default-callback-prefix-data',
    source:
      'function frames(error:Error){return[undefined].flatMap(...([(value:Error|undefined=error)=>{const changed=Object.assign(value,{stack:"fixed"});return value;}]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-flatmap-local-const-origin',
    source:
      'function frames(error:Error){return[0].flatMap(...([()=>{const result=error;return result;}]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('mapper spread scalar composition readers', () => {
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

describe('mapper spread scalar composition shared', () => {
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
