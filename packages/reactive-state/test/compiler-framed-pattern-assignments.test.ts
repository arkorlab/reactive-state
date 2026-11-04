import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-visible error inputs retain their runtime observations and lexical identity. */
const CASES = [
  {
    id: 'object-assigned-error',
    source:
      "function frames(){let value:{stack?:string}={};({value}={value:new Error('ours')});return value.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'renamed-assigned-error',
    source:
      "function frames(){let value:{stack?:string}={};({entry:value}={entry:new Error('ours')});return value.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'array-assigned-error',
    source:
      "function frames(){let value:{stack?:string}={};[value]=[new Error('ours')];return value.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'nested-assigned-error',
    source:
      "function frames(){let value:{stack?:string}={};({entry:{value}}={entry:{value:new Error('ours')}});return value.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'typed-assignment-source',
    source:
      'function frames(box:{value:Error}){let value:{stack?:string}={};({value}=box);return value.stack;}',
    invocation: 'frames({value:new Error("ours")})',
    refused: true,
  },
  {
    id: 'assigned-plain-data',
    source:
      "function frames(){let value:{stack?:string}={};({value}={value:{stack:'fixed'}});return value.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'later-assignment-source',
    source:
      "function frames(){let value:{stack?:string}={};const result=value.stack;({value}={value:new Error('ours')});return result;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assignment-lexical-shadow',
    source:
      "function frames(){let value:{stack?:string}={};{let value:{stack?:string}={};({value}={value:new Error('ours')});}return value.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assigned-own-error-words',
    source:
      "function frames(){let value:{message?:string}={};({value}={value:new Error('ours')});return value.message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'unreachable-assignment-source',
    source:
      "function frames(){let value:{stack?:string}={};if(false){({value}={value:new Error('ours')});}return value.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'missing-assignment-default',
    source:
      "function frames(){let value:{stack?:string}={};({value=new Error('ours')}={});return value.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'present-assignment-default',
    source:
      "function frames(){let value:{stack?:string}={};({value=new Error('ours')}={value:{stack:'fixed'}});return value.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'declared-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};const {a=value.stack}=(value=new Error('ours'),{} as {a?:string});return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'declared-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;const {a=value.stack}=(other=new Error('ours'),{} as {a?:string});void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'declared-array-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};const [a=value.stack]=(value=new Error('ours'),[] as (string|undefined)[]);return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'declared-array-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;const [a=value.stack]=(other=new Error('ours'),[] as (string|undefined)[]);void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'declared-nested-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};const {inner:{a=value.stack}}=(value=new Error('ours'),{inner:{}} as {inner:{a?:string}});return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'declared-nested-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;const {inner:{a=value.stack}}=(other=new Error('ours'),{inner:{}} as {inner:{a?:string}});void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assigned-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let a;({a=value.stack}=(value=new Error('ours'),{} as {a?:string}));return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assigned-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;let a;({a=value.stack}=(other=new Error('ours'),{} as {a?:string}));void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assigned-array-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let a;[a=value.stack]=(value=new Error('ours'),[] as (string|undefined)[]);return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assigned-array-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;let a;[a=value.stack]=(other=new Error('ours'),[] as (string|undefined)[]);void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'iterated-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let result;for(const {a=value.stack} of (value=new Error('ours'),[{}] as {a?:string}[]))result=a;return result;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'iterated-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;let result;for(const {a=value.stack} of (other=new Error('ours'),[{}] as {a?:string}[]))result=a;void other;return result;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'enumerated-default-source-error',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let result;for(const {a=value.stack} in (value=new Error('ours'),{key:1}))result=a;return result;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'enumerated-default-source-data',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};let other:unknown;let result;for(const {a=value.stack} in (other=new Error('ours'),{key:1}))result=a;void other;return result;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'parameter-default-source-error',
    source:
      "function frames(value:{stack?:string}={stack:'fixed'},{a=value.stack}:{a?:string}=(value=new Error('ours'),{})){return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'parameter-default-source-data',
    source:
      "function frames(value:{stack?:string}={stack:'fixed'},other:unknown=undefined,{a=value.stack}:{a?:string}=(other=new Error('ours'),{})){void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'computed-key-source-error',
    source:
      "function frames(){let key:'message'|'stack'='message';const error=new Error('ours');const {[key]:a}=(key='stack',error) as unknown as Record<string,string>;return a;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'computed-key-source-data',
    source:
      "function frames(){let key:'message'|'stack'='message';let other='';const error=new Error('ours');const {[key]:a}=(other='stack',error) as unknown as Record<string,string>;void other;return a;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'argument-parameter-default-pin',
    source:
      "function frames(){let value:{stack?:string}={stack:'fixed'};function read(a=value.stack){return a;}return read((value=new Error('ours'),undefined));}",
    invocation: 'frames()',
    refused: true,
  },
];

describe('error pattern assignments readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared error pattern assignments', () => {
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
