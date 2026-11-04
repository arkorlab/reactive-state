import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native object enumeration and synchronous array mappers preserve selected result origins. */
const CASES = [
  {
    id: 'values-selected-error',
    source: 'function frames(error:Error){return Object.values({failure:error})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'values-numeric-key-error-first',
    source:
      'function frames(error:Error){return Object.values({later:{stack:"fixed"},2:error})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'values-numeric-key-data-first',
    source:
      'function frames(error:Error){return Object.values({failure:error,2:{stack:"fixed"}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-later-field-error',
    source:
      'function frames(error:Error){return Object.values({first:{stack:"fixed"},failure:error})[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'values-getter-error',
    source:
      'function frames(error:Error){return Object.values({get failure(){return error;}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'values-replaced-data',
    source:
      'function frames(error:Error){return Object.values({...{failure:error},failure:{stack:"fixed"}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-ordinary-data',
    source:
      'function frames(error:Error){return Object.values({failure:{stack:"fixed"}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-own-written-words',
    source:
      'function frames(error:Error){return Object.values({failure:new Error("fixed")})[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-local-object-shadow',
    source:
      'function frames(error:Error){const Object={values(_value:unknown){return[{stack:"fixed"}];}};return Object.values({failure:error})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-captured-error',
    source: 'function frames(error:Error){return[0].map(()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-returned-element',
    source: 'function frames(error:Error){return[error].map(value=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-selected-data-element',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].map(value=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-returned-data',
    source: 'function frames(error:Error){return[error].map(()=>({stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-own-written-words',
    source: 'function frames(error:Error){return[0].map(()=>new Error("fixed"))[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-own-method-data',
    source:
      'function frames(error:Error){const values=[0];values.map=()=>[{stack:"fixed"}] as never;return(values.map(()=>error)as {stack:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-sparse-hole-skips',
    source: 'function frames(error:Error){return(new Array<unknown>(1)).map(()=>error)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-empty-skips',
    source: 'function frames(error:Error){return([]as unknown[]).map(()=>error)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-async-result-is-promise',
    source: 'function frames(error:Error){return[0].map(async()=>error)[0]!.then;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-literal-hole-skips',
    source: 'function frames(error:Error){return[,].map(()=>error)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-borrowed-ignores-own',
    source:
      'function frames(error:Error){const values=[0];values.map=()=>[{stack:"fixed"}] as never;return Array.prototype.map.call(values,()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-conditional-captured-error',
    source:
      'function frames(error:Error){return[0].map(()=>error.name?error:{stack:"fixed"})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-typed-array-element',
    source:
      'function frames(error:Error){const values:Error[]=[error];return values.map(value=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'values-symbol-key-excluded',
    source:
      'function frames(error:Error){return Object.values({[Symbol.iterator]:error,failure:{stack:"fixed"}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-setter-only-undefined',
    source:
      'function frames(error:Error){return Object.values({set failure(value:Error){}})[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'values-getter-setter-pair',
    source:
      'function frames(error:Error){return Object.values({get failure(){return error;},set failure(value:Error){}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'named-map-reassigned-to-data',
    source:
      'function frames(error:Error){function project():any{return error;}project=()=>({stack:"fixed"});return[0].map(project)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native projected array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'projected-array.ts', source);
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

describe('native projected array shared helpers', () => {
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
