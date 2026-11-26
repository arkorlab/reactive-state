import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written native arguments retain their exact selected element behavior. */
const CASES = [
  {
    id: 'reported-NaN-key',
    source: 'function frames(error:Error){return new Map([[NaN,error]]).get(NaN)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'Number-NaN-key',
    source:
      'function frames(error:Error){return new Map([[Number.NaN,error]]).get(Number.NaN)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-NaN-key',
    source:
      'function frames(error:Error){return new Map([[0/0,error]]).get(Infinity-Infinity)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'last-NaN-Error-replaces-data',
    source:
      'function frames(error:Error){return (new Map<number,unknown>([[NaN,{stack:"fixed"}],[Number.NaN,error]]).get(0/0) as {stack:string}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-call-NaN-key',
    source:
      'function frames(error:Error){return (Map.prototype.get.call(new Map([[NaN,error]]),NaN) as {stack:string}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply-NaN-key',
    source:
      'function frames(error:Error){return (Map.prototype.get.apply(new Map([[NaN,error]]),[NaN]) as {stack:string}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-NaN-key',
    source:
      'function frames(error:Error){return (Reflect.apply(Map.prototype.get,new Map([[NaN,error]]),[NaN]) as {stack:string}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'last-NaN-data-replaces-Error',
    source:
      'function frames(error:Error){return (new Map<number,unknown>([[NaN,error],[Number.NaN,{stack:"fixed"}]]).get(0/0) as {stack:string}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'NaN-string-is-distinct',
    source:
      'function frames(error:Error){return (new Map<number|string,unknown>([[NaN,error],["NaN",{stack:"fixed"}]]).get("NaN") as {stack:string}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'signed-zero-keys-remain-equal',
    source: 'function frames(error:Error){return new Map([[-0,error]]).get(0)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unrelated-finite-key-keeps-data',
    source:
      'function frames(error:Error){return (new Map<number,unknown>([[NaN,error],[1,{stack:"fixed"}]]).get(1) as {stack:string}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constructed-Error-words-remain-local',
    source:
      'function frames(_error:Error){return new Map([[NaN,new Error("ours")]]).get(NaN)!.message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-get-keeps-fixed-result',
    source:
      'function frames(error:Error){const map=new Map([[NaN,error]]);map.get=()=>({stack:"fixed"}) as Error;return map.get(NaN)!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-key-keeps-possible-Error',
    source:
      'function frames(error:Error,key:number){return new Map([[NaN,error]]).get(key)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"),NaN)',
  },
] as const;

describe('map SameValueZero keys readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared Map SameValueZero keys text', () => {
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
