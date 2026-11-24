import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'assign-selected-error-original',
    source:
      'function frames(error:Error){return Object.assign({}, {failure:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'assign-later-data-overwrites-error',
    source:
      'function frames(error:Error){return Object.assign({}, {failure:error},{failure:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'assign-later-error-overwrites-data',
    source:
      'function frames(error:Error){return Object.assign({}, {failure:{stack:"fixed"}},{failure:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'assign-nested-selected-error',
    source:
      'function frames(error:Error){return Object.assign({}, {box:{failure:error}}).box.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'assign-getter-value-copied',
    source:
      'function frames(error:Error){return Object.assign({}, {get failure(){return error;}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'assign-local-shadow-data',
    source:
      'function frames(error:Error){const Object={assign(...values:unknown[]){return{failure:{stack:"fixed"}};}};return Object.assign({}, {failure:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'assign-local-made-words',
    source:
      'function frames(error:Error){return Object.assign({}, {failure:new Error("fixed")}).failure.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bind-captured-error-original',
    source:
      'function id(value:Error){return value;}function frames(error:Error){return id.bind(null,error)().stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bind-invocation-error-argument',
    source:
      'function id(value:Error){return value;}function frames(error:Error){return id.bind(null)(error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bind-bound-data-before-extra-error',
    source:
      'function id(value:{stack:string}){return value;}function frames(error:Error){return(id.bind(null,{stack:"fixed"})as(...extra:unknown[])=>{stack:string})(error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bind-local-data-factory',
    source:
      'function id(value:Error){return{stack:"fixed"};}function frames(error:Error){return id.bind(null,error)().stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bind-own-method-returns-data',
    source:
      'function id(value:Error){return value;}Object.assign(id,{bind:(...unused:unknown[])=>()=>({stack:"fixed"})});function frames(error:Error){return id.bind(null,error)().stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bind-mutated-callee-data',
    source:
      'let id:(value:Error)=>Error|{stack:string}=(value)=>value;id=()=>({stack:"fixed"});function frames(error:Error){return id.bind(null,error)().stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bind-local-made-words',
    source:
      'function id(value:Error){return value;}function frames(error:Error){return id.bind(null,new Error("fixed"))().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'assign-literal-argument-spread-error',
    source:
      'function frames(error:Error){return Object.assign({}, ...[{failure:{stack:"fixed"}},{failure:error}]).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'assign-literal-argument-spread-data',
    source:
      'function frames(error:Error){return Object.assign({}, ...[{failure:error},{failure:{stack:"fixed"}}]).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
];

describe('object and bound factory readers', () => {
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

describe('shared object and bound factory results', () => {
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
