import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A member a literal's own fields do not define is read from the prototype its `__proto__` entry
 * sets, and a prototype code sets on what a variable holds is read past that object.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'proto-data-member',
    source:
      'function frames(error:Error){const options={__proto__:{x:error}} as unknown as {x:{stack?:string}};return options.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-getter-member',
    source:
      'function frames(error:Error){const options={__proto__:{get x():{stack?:string}{return error;}}} as unknown as {x:{stack?:string}};return options.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'direct-proto-literal',
    source:
      'function frames(error:Error){return ({__proto__:{x:error}} as unknown as {x:{stack?:string}}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-held-identifier',
    source:
      'function frames(error:Error){const base={x:error};const options={__proto__:base} as unknown as {x:{stack?:string}};return options.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-proto-member',
    source:
      'function frames(error:Error){const options={inner:{__proto__:{x:error}}} as unknown as {inner:{x:{stack?:string}}};return options.inner.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quoted-proto-member',
    source:
      "function frames(error:Error){const options={'__proto__':{x:error}} as unknown as {x:{stack?:string}};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-prototype-statement',
    source:
      'function frames(error:Error){const proto={x:error};const options:{x?:{stack?:string}}={};Object.setPrototypeOf(options,proto);return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-set-prototype',
    source:
      'function frames(error:Error){const proto={x:error};const options:{x?:{stack?:string}}={};Reflect.setPrototypeOf(options,proto);return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-assignment',
    source:
      'function frames(error:Error){const proto={x:error};const options:{x?:{stack?:string}}={};(options as {__proto__?:unknown}).__proto__=proto;return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-prototype-getter',
    source:
      'function frames(error:Error){const options:{x?:{stack?:string}}={};Object.setPrototypeOf(options,{get x(){return error;}});return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-set-prototype',
    source:
      'function frames(error:Error){const options:{x?:{stack?:string}}={};const alias=options;Object.setPrototypeOf(alias,{x:error});return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-member-shadows-proto',
    source:
      "function frames(error:Error){const options={x:{stack:'fixed'},__proto__:{x:error}} as unknown as {x:{stack?:string}};return options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-proto-data',
    source:
      "function frames(error:Error){const options={__proto__:null,x:{stack:'fixed'}} as unknown as {x:{stack?:string}};return String(error===undefined)+options.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-proto-field',
    source:
      "function frames(error:Error){const options={['__proto__']:{x:error}} as unknown as {x?:{stack?:string}};return options.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shorthand-proto-field',
    source:
      'function frames(error:Error){const __proto__={x:error};const options={__proto__} as unknown as {x?:{stack?:string}};return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'query-record-proto',
    source:
      'function frames(error:Error){const options={__proto__:{x:error}};return new URLSearchParams(options as never).toString();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-holder-prototype',
    source:
      'function frames(error:Error){const options:{x?:{stack?:string}}={};const other={};Object.setPrototypeOf(other,{x:error});return options.x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('inherited prototype member readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-members.ts', source);
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

describe('shared inherited prototype member admissions', () => {
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
