import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A possibly changed saved record keeps what may still be in it, and what was written into it. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-other-field-write',
    source:
      'function frames(error:Error){const options={x:error as never,y:"a"};options.y="b";return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reported-changed-copy-spread',
    source:
      'function frames(error:Error){const copy={y:"a"};copy.y="b";return new URLSearchParams({...copy,x:error as never}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-other-field-write',
    source:
      'function frames(error:Error){const options={x:error as never,y:"a"};options.y="b";return new Headers(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-error-field',
    source:
      'function frames(error:Error){const options:Record<string,string>={x:"a"};options.x=error as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assigned-error-field',
    source:
      'function frames(error:Error){const options:Record<string,string>={x:"a"};Object.assign(options,{y:error as never});return new URLSearchParams(options).get("y");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'closure-written-error',
    source:
      'function frames(error:Error){const options:Record<string,string>={x:"a"};function prepare(){options.y=error as never;}prepare();return new URLSearchParams(options).get("y");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'branch-overwrite-keeps-error',
    source:
      'function frames(error:Error,flag:boolean){const options={x:error as never};if(flag)options.x="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'changed-source-spread-error',
    source:
      'function frames(error:Error){const copy:Record<string,string>={x:error as never};copy.y="b";return new URLSearchParams({...copy}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-key-written-error',
    source:
      'function frames(error:Error,key:string){const options:Record<string,string>={x:"a"};options[key]=error as never;return new URLSearchParams(options).get(key);}',
    invocation: 'frames(new Error("ours"),"x")',
    refused: true,
  },
  {
    id: 'captured-overwrite-keeps-error',
    source:
      'function frames(error:Error){const options={x:error as never};function prepare(){options.x="fixed" as never;}prepare();return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'handed-record-keeps-error',
    source:
      'function frames(error:Error){const options={x:error as never};function replace(value:typeof options){value.x="fixed" as never;}replace(options);return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'other-field-write-data',
    source:
      'function frames(error:Error){const options={x:"fixed",y:"a"};options.y="b";return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'definite-overwrite-data',
    source:
      'function frames(error:Error){const options={x:error as never,y:"a"};options.x="fixed" as never;options.y="b";return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'definite-reassignment-data',
    source:
      'function frames(error:Error){let options={x:error as never};options={x:"fixed" as never};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-overwrite-snapshot-data',
    source:
      'function frames(error:Error){const original={x:error as never};original.x="fixed" as never;return new URLSearchParams({...original}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-spread-replaces-data',
    source:
      'function frames(error:Error){const original:Record<string,string>={x:error as never};original.x="fixed";return new URLSearchParams({x:error as never,...original}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'record-default-source-write',
    source:
      'function frames(error:Error){const options:Record<string,string>={x:"a"};const {a=new URLSearchParams(options).get("x")}=(options.x=error as never,{} as {a?:string|null});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'record-default-source-other',
    source:
      'function frames(error:Error){const options:Record<string,string>={x:"a"};const other:Record<string,string>={};const {a=new URLSearchParams(options).get("x")}=(other.x=error as never,{} as {a?:string|null});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('changed record readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'record-changes.ts', source);
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

describe('shared changed record admissions', () => {
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
