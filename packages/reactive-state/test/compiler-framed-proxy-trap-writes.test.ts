import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A get trap's writes of its own target or key parameters follow into its forwarded read: a written
 * replacement stands beside or for the original, and a write the compile cannot read may be anything.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){key='failure';return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'element-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){key='failure';return (target as Record<string|symbol,unknown>)[key];}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){if(key==='safe')key='failure';return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'closure-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){const swap=()=>{key='failure';};swap();return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){[key]=['failure'];return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){key=key==='safe'?'failure':key;return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'loop-key-assignment',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){for(key in target){if(key==='failure')break;}return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'target-replacement',
    source:
      "function frames(error:Error){const other={safe:error};return (new Proxy({safe:{stack:'fixed'}},{get(target,key){target=other as never;return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-forward',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'key-assignment-to-data',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},spare:{stack:'fixed'},failure:error},{get(target,key){key='spare';return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'definite-target-replacement',
    source:
      "function frames(error:Error){return (new Proxy({safe:error},{get(target,key){target={safe:{stack:'fixed'}} as never;return Reflect.get(target,key);}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-local-write',
    source:
      "function frames(error:Error){return (new Proxy({safe:{stack:'fixed'},failure:error},{get(target,key){let other=key;other='failure';return Reflect.get(target,key)??other;}}) as {safe:{stack?:string}}).safe.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('proxy trap parameter write readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-trap-writes.ts', source);
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

describe('shared proxy trap parameter write admissions', () => {
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
