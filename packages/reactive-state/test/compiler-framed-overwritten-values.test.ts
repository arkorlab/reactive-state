import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written source values retain their selected runtime meaning. */
const CASES = [
  {
    id: 'final-data',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');value={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'multiple-final-data',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');value={stack:'first'};value=new Error('y');value={stack:'last'};return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'data-alias-final',
    source:
      "function frames(){let value:{stack?:string}={};const data={stack:'fixed'};value=new Error('x');value=data;return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'following-empty-data',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');value={};return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'data-return-block',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');value={stack:'fixed'};const shown=value.stack;return shown??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'final-error',
    source:
      "function frames(){let value:{stack?:string}={};value={stack:'fixed'};value=new Error('x');return value.stack??'';}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'conditional-data-retains-error',
    source:
      "function frames(flag:boolean){let value:{stack?:string}={};value=new Error('x');if(flag)value={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames(true)',
    refused: true,
  },
  {
    id: 'logical-data-retains-error',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');value||={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'other-binding-data',
    source:
      "function frames(){let value:{stack?:string}={};let other:{stack?:string}={};value=new Error('x');other={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'read-before-data',
    source:
      "function frames(){let value:{stack?:string}={};value=new Error('x');const shown=value.stack;value={stack:'fixed'};return shown??'';}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'always-data',
    source:
      "function frames(){let value:{stack?:string}={};value={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'unselected-error',
    source:
      "function frames(){let value:{stack?:string}={};if(false)value=new Error('x');value={stack:'fixed'};return value.stack??'';}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'cross-owner-error',
    source:
      "function frames(){let value:{stack?:string}={};function replace(){value=new Error('x');}value={stack:'fixed'};replace();return value.stack??'';}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'repeated-later-error',
    source:
      "function frames(){let value:{stack?:string}={};let shown='';for(let step=0;step<2;step++){shown=value.stack??'';value=new Error('x');}return shown;}",
    invocation: 'frames()',
    refused: true,
  },
] as const;

describe('overwritten receiver values readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-write-error.ts', source);
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

describe('overwritten receiver values shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
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
