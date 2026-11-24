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
    id: 'inherited-map-error',
    source:
      'class FailureMap extends Map<string,Error>{}function frames(map:FailureMap){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",new Error("ours")]]))',
    refused: true,
  },
  {
    id: 'generic-map-base',
    source:
      'class Box<T> extends Map<string,T>{}function frames(map:Box<Error>){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",new Error("ours")]]))',
    refused: true,
  },
  {
    id: 'default-map-base',
    source:
      'class Box<T=Error> extends Map<string,T>{}function frames(map:Box){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",new Error("ours")]]))',
    refused: true,
  },
  {
    id: 'map-heritage-chain',
    source:
      'class Base<T> extends Map<string,T>{}class FailureMap extends Base<Error>{}function frames(map:FailureMap){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",new Error("ours")]]))',
    refused: true,
  },
  {
    id: 'map-data-base',
    source:
      'class Values extends Map<string,{stack:string}>{}function frames(map:Values){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",{stack:"fixed"}]]))',
    refused: false,
  },
  {
    id: 'map-type-shadow',
    source:
      'type Error={stack:string};class Values extends Map<string,Error>{}function frames(map:Values){return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",{stack:"fixed"}]]))',
    refused: false,
  },
  {
    id: 'map-value-shadow',
    source:
      'class Map<K,V>{get(key:K){void key;return {stack:"fixed"};}}class Values extends Map<string,Error>{}function frames(map:Values){return map.get("x").stack;}',
    invocation: 'frames(new Values())',
    refused: false,
  },
  {
    id: 'map-own-get-data',
    source:
      'class FailureMap extends Map<string,Error>{}function frames(map:FailureMap){map.get=()=>({stack:"fixed",name:"fixed",message:"fixed"});return map.get("x")!.stack;}',
    invocation: 'frames(new Map([["x",new Error("ours")]]))',
    refused: false,
  },
];

function record(id: string, reasons: readonly string[]): void {
  const file = process.env['NATIVE_RESULT_OBSERVATIONS'];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify({ id, reasons })}\n`);
}

describe('inherited-map-results readers', () => {
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

describe('shared inherited-map-results', () => {
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
