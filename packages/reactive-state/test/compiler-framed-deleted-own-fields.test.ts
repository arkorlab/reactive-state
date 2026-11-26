import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A delete, an unread-key delete or a hand-off that may remove an own field reopens the prototype's
 * member for the reads it may reach.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-delete-own-field',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};delete o.x;return (o as {x?:{stack?:string}}).x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-delete-own-field',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};Reflect.deleteProperty(o,'x');return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unread-key-delete',
    source:
      "function frames(error:Error,key:string){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};delete (o as Record<string,unknown>)[key];return o.x?.stack;}",
    invocation: 'frames(new Error("ours"),"x")',
    refused: true,
  },
  {
    id: 'handed-off-holder',
    source:
      "function frames(error:Error,consume:(value:object)=>void){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};consume(o);return o.x?.stack;}",
    invocation: 'frames(new Error("ours"),(value)=>{delete (value as {x?:unknown}).x;})',
    refused: true,
  },
  {
    id: 'method-receiver-handoff',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'},drop(){delete (this as {x?:unknown}).x;}} as unknown as {x?:{stack?:string};drop():void};o.drop();return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'closure-delete',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};const drop=()=>{delete o.x;};drop();return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-delete',
    source:
      "function frames(error:Error){const o={inner:{__proto__:{x:error},x:{stack:'fixed'}}} as unknown as {inner:{x?:{stack?:string}}};delete o.inner.x;return (o.inner as {x?:{stack?:string}}).x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'created-overwrite-delete',
    source:
      "function frames(error:Error){const o=Object.create({x:error}) as {x?:{stack?:string}};o.x={stack:'fixed'};delete o.x;return (o as {x?:{stack?:string}}).x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-delete',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};const alias=o;delete alias.x;return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-prototype-delete',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={x:{stack:'fixed'}};Object.setPrototypeOf(o,{x:error});delete o.x;return (o as {x?:{stack?:string}}).x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-field-no-delete',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'delete-other-field',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'},y:1} as unknown as {x?:{stack?:string};y?:number};delete o.y;return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'delete-without-prototype',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={x:{stack:'fixed'}};delete o.x;return String((o as {x?:{stack?:string}}).x?.stack)+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-handoff',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};JSON.stringify(o);return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'delete-after-read',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};const stack=o.x?.stack;delete o.x;return stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'delete-other-holder',
    source:
      "function frames(error:Error){const o={__proto__:{x:error},x:{stack:'fixed'}} as unknown as {x?:{stack?:string}};const other:{x?:{stack?:string}}={x:{stack:'fixed'}};delete other.x;return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'created-overwrite-kept',
    source:
      "function frames(error:Error){const o=Object.create({x:error}) as {x?:{stack?:string}};o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('deleted own field readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'deleted-own-fields.ts', source);
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

describe('shared deleted own field admissions', () => {
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
