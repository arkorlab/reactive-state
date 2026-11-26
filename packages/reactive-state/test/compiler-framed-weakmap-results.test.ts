import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native result sources retain selected Error identity and locally written data. */
const CASES = [
  {
    id: 'weakmap-literal-error',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,Error>([[key,error]]).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weakmap-typed-error',
    source:
      'function frames(map:WeakMap<object,Error>,key:object){return map.get(key)!.stack;}function observe(error:Error){const key={};return frames(new WeakMap([[key,error]]),key);}',
    invocation: 'observe(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weakmap-constructor-alias',
    source:
      'function frames(error:Error){const Store=WeakMap;const key={};return new Store<object,Error>([[key,error]]).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weakmap-generic-base',
    source:
      'class Store<T> extends WeakMap<object,T>{}function frames(map:Store<Error>,key:object){return map.get(key)!.stack;}function observe(error:Error){const key={};return frames(new WeakMap([[key,error]]),key);}',
    invocation: 'observe(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weakmap-literal-data',
    source:
      'function frames(){const key={};return new WeakMap([[key,{stack:"fixed"}]]).get(key)!.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'weakmap-typed-data',
    source:
      'function frames(map:WeakMap<object,{stack:string}>,key:object){return map.get(key)!.stack;}function observe(){const key={};return frames(new WeakMap([[key,{stack:"fixed"}]]),key);}',
    invocation: 'observe()',
    refused: false,
  },
  {
    id: 'weakmap-shadow',
    source:
      'class WeakMap<K,V>{get(key:K){void key;return {stack:"fixed"};}}function frames(map:WeakMap<object,Error>){return map.get({}).stack;}',
    invocation: 'frames(new WeakMap())',
    refused: false,
  },
  {
    id: 'weakmap-own-get-data',
    source:
      'function frames(error:Error){const key={};const map=new WeakMap<object,Error>([[key,error]]);map.get=()=>({stack:"fixed",name:"fixed",message:"fixed"});return map.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'weakmap-local-words',
    source:
      'function frames(){const key={};return new WeakMap([[key,new Error("ours")]]).get(key)!.message;}',
    invocation: 'frames()',
    refused: false,
  },
];

function record(id: string, reasons: readonly string[]): void {
  const file = process.env['WEAKMAP_OBSERVATIONS'];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify({ id, reasons })}\n`);
}

describe('native WeakMap results readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-iteration.ts', source);
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

describe('shared native WeakMap results', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    record(id, reasons);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
