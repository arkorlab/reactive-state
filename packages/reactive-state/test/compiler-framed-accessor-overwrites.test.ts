import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A write replaces what a member held only where no accessor takes it: a setter leaves its getter,
 * so an assignment or `Object.assign` keeps the getter's origin; a definition replaces it.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-setter-query',
    source:
      "function frames(error:Error){const options={get x(){return error;},set x(value:unknown){}};options.x='fixed';return new URLSearchParams(options as never).get('x');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-member-read',
    source:
      "function frames(error:Error){const options={get x():{stack?:string}{return error;},set x(value:{stack?:string}){}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-setter-member',
    source:
      "function frames(error:Error){const options={get x():{stack?:string}{return error;},set x(value:{stack?:string}){}};Object.assign(options,{x:{stack:'fixed'}});return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-setter-query',
    source:
      "function frames(error:Error){const options={get x(){return error;},set x(value:unknown){}};Object.assign(options,{x:'fixed'});return new URLSearchParams(options as never).get('x');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-setter-member',
    source:
      "function frames(error:Error){const box={inner:{get x():{stack?:string}{return error;},set x(value:{stack?:string}){}}};box.inner.x={stack:'fixed'};return box.inner.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replaced-intermediate-setter',
    source:
      "function frames(error:Error){const box:{inner:{x:{stack?:string}}}={inner:{x:error}};box.inner={get x():{stack?:string}{return error;},set x(value:{stack?:string}){}};box.inner.x={stack:'fixed'};return box.inner.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'created-prototype-setter',
    source:
      "function frames(error:Error){const options=Object.create({get x():{stack?:string}{return error;},set x(value:{stack?:string}){}}) as {x:{stack?:string}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-accessor-name',
    source:
      "function frames(error:Error,key:'x'){const options={get [key]():{stack?:string}{return error;},set [key](value:{stack?:string}){}} as {x:{stack?:string}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"),\'x\')',
    refused: true,
  },
  {
    id: 'created-descriptor-accessor',
    source:
      "function frames(error:Error){const options=Object.create(null,{x:{get(){return error;},set(value:unknown){}}}) as {x:{stack?:string}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-member-overwrite',
    source:
      "function frames(error:Error){const options:{x:{stack?:string}}={x:error};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-accessor-overwrite',
    source:
      "function frames(error:Error){const options={x:error as {stack?:string},get y(){return 'y';},set y(value:string){}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'defined-over-accessor',
    source:
      "function frames(error:Error){const options={get x():{stack?:string}{return error;},set x(value:{stack?:string}){}};Object.defineProperty(options,'x',{value:{stack:'fixed'}});return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nested-plain-overwrite',
    source:
      "function frames(error:Error){const box={inner:{x:error as {stack?:string}}};box.inner.x={stack:'fixed'};return box.inner.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-prototype-overwrite',
    source:
      "function frames(error:Error){const options=Object.create(null) as {x:{stack?:string}};options.x=error;options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'plain-query-overwrite',
    source:
      "function frames(error:Error){const options:Record<string,unknown>={x:error};options.x='fixed';return new URLSearchParams(options as never).get('x');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'created-descriptor-data',
    source:
      "function frames(error:Error){const options=Object.create(null,{x:{value:error,writable:true}}) as {x:{stack?:string}};options.x={stack:'fixed'};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('accessor-intercepted overwrite readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'accessor-overwrites.ts', source);
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

describe('shared accessor-intercepted overwrite admissions', () => {
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
