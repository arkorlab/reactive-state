import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'known-undefined-optional-receiver',
    source:
      'function frames(error:Error){let result:string|undefined;const values=undefined as unknown as Error[]|undefined;values?.forEach(...([(value:{stack?:string})=>{result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-prepare-captured-bridge',
    source:
      'function frames(error:Error){let result:string|undefined;function collect(values:Error[],prepare:()=>void){prepare();values.forEach(...([(value:{stack?:string})=>{result=value.stack;}]as const));}collect([error],()=>{Object.assign(error,{stack:"fixed"});});return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'class-field-before-constructor-callback',
    source:
      'function frames(error:Error){let result:string|undefined;class Worker{before=Object.assign(error,{stack:"fixed"});constructor(){[error].forEach(...([(value:{stack?:string})=>{result=value.stack;}]as const));}}new Worker();return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'known-undefined-own-optional-method',
    source:
      'function frames(error:Error){let result:string|undefined;const values=[error];Object.defineProperty(values,"forEach",{value:undefined});values.forEach?.(...([(value:{stack?:string})=>{result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native callback argument-spread boundaries readers', () => {
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

describe('native callback argument-spread boundaries shared', () => {
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
