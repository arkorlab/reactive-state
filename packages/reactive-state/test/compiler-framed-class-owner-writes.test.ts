import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Separate constructor and setter owners conservatively retain captured writes without invocation-order inference. */
const CASES = [
  {
    id: 'constructor-later-write',
    source:
      "function frames(){let value:{stack?:string}={};class Reader{shown:string|undefined;constructor(){this.shown=value.stack;}}value=new Error('ours');return new Reader().shown;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'setter-later-write',
    source:
      "function frames(){let value:{stack?:string}={};let shown:string|undefined;class Reader{set read(next:number){shown=value.stack;}}value=new Error('ours');const reader=new Reader();reader.read=1;return shown;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'constructor-earlier-error',
    source:
      "function frames(){let value:{stack?:string}=new Error('ours');class Reader{shown:string|undefined;constructor(){this.shown=value.stack;}}return new Reader().shown;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'setter-earlier-error',
    source:
      "function frames(){let value:{stack?:string}=new Error('ours');let shown:string|undefined;class Reader{set read(next:number){shown=value.stack;}}const reader=new Reader();reader.read=1;return shown;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'constructor-written-data',
    source:
      "function frames(){let value:{stack?:string}={};class Reader{shown:string|undefined;constructor(){this.shown=value.stack;}}value={stack:'fixed'};return new Reader().shown;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'setter-written-data',
    source:
      "function frames(){let value:{stack?:string}={};let shown:string|undefined;class Reader{set read(next:number){shown=value.stack;}}value={stack:'fixed'};const reader=new Reader();reader.read=1;return shown;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'constructor-invoked-before-write',
    source:
      "function frames(){let value:{stack?:string}={};class Reader{shown:string|undefined;constructor(){this.shown=value.stack;}}const shown=new Reader().shown;value=new Error('ours');return shown;}",
    invocation: 'frames()',
    refused: true,
  },
];

describe('class owner error readers', () => {
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

describe('shared class owner errors', () => {
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
