import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A Proxy `get` trap that forwards the read answers the target's member of the read key. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reflect-get-forwarding',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(target,key,receiver){return Reflect.get(target,key,receiver);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-get-two-arguments',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(target,key){return Reflect.get(target,key);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'element-forwarding',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(target,key){return target[key as "x"];}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-reflect-get-trap',
    source: 'function frames(error:Error){return new Proxy({x:error},{get:Reflect.get}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'arrow-forwarding',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:(target,key)=>Reflect.get(target,key)}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'target-returning-trap',
    source:
      'function frames(error:Error){return new Proxy<Record<string,any>>({x:error},{get(target){return target;}}).x.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'forwarded-error-target-words',
    source:
      'function frames(error:Error){return new Proxy(error,{get(target,key,receiver){return Reflect.get(target,key,receiver);}}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-trap-error-target-words',
    source: 'function frames(error:Error){return new Proxy(error,{get:Reflect.get}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyed-mixed-forwarding',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(target,key){if(key==="y")return"fixed";return Reflect.get(target,key);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'revocable-forwarding',
    source:
      'function frames(error:Error){return Proxy.revocable({x:error},{get:Reflect.get}).proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-parameter-forwarding',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(this:unknown,target,key){return Reflect.get(target,key);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'forwarding-data-target',
    source:
      'function frames(error:Error){return new Proxy({x:{stack:"fixed"}},{get(target,key,receiver){return Reflect.get(target,key,receiver);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'forwarding-local-words',
    source:
      'function frames(error:Error){return new Proxy(new Error("fixed"),{get:Reflect.get}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-object-forwarding',
    source:
      'function frames(error:Error){const other={x:{stack:"fixed"}};return new Proxy({x:error},{get(_target,key){return Reflect.get(other,key);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-reflect-shadow',
    source:
      'function frames(error:Error){const Reflect={get:(_target:unknown,_key:unknown)=>({stack:"fixed"})};return new Proxy({x:error},{get(target,key){return Reflect.get(target,key);}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('forwarding get trap readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-get-forwarding.ts', source);
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

describe('shared forwarding get trap admissions', () => {
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
