import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'null-prototype-data-error',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-prototype-data-error',
    source:
      'function frames(error:Error){return Object.create({},{failure:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'nested-data-error',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:{inner:error}}}).failure.inner.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-error-message',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:error}}).failure.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'local-error-stack',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:new Error("fixed")}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'local-error-message',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:new Error("fixed")}}).failure.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'ordinary-data-value',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'getter-error',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{get(){return error;}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'getter-data',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{get(){return {stack:"fixed"};}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'prototype-fallback-error',
    source: 'function frames(error:Error){return Object.create({failure:error},{}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unselected-descriptor-error',
    source:
      'function frames(error:Error){return Object.create(null,{failure:{value:"fixed"},other:{value:error}}).failure;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'literal-stack-hides-prototype',
    source:
      'function frames(error:Error){return Object.create(error,{stack:{value:"fixed"}}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-prototype-error',
    source: 'function frames(error:Error){return Object.create(error,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'local-object-shadow',
    source:
      'const Object={create(_prototype:unknown,_descriptors:unknown){return {failure:{stack:"fixed"}};}};function frames(error:Error){return Object.create(null,{failure:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'constant-result-alias',
    source:
      'function frames(error:Error){const result=Object.create(null,{failure:{value:error}});return result.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'constant-result-write-data',
    source:
      'function frames(error:Error){const result=Object.create(null,{failure:{value:error,writable:true}});result.failure={stack:"fixed"};return result.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'constant-result-write-error-assertion',
    source:
      'function frames(error:Error){const result=Object.create(null,{failure:{value:{stack:"fixed"},writable:true}});result.failure=error;return(result.failure as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'opaque-map-getter-error-assertion',
    source:
      'function frames(error:Error){return(Object.create(null,{get failure(){return{value:error};}}).failure as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'opaque-map-getter-data',
    source:
      'function frames(error:Error){return Object.create(null,{get failure(){return{value:{stack:"fixed"}};}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('native created descriptor values readers', () => {
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

describe('native created descriptor values admissions', () => {
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
