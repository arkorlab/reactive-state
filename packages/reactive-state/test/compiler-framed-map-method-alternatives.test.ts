import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const CASES = [
  {
    id: 'unknown-data-branch',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);if(flag)values.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'cross-owner-data-branch',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);function install(){values.get=()=>({stack:"data"}as Error);}if(flag)install();return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'known-false-data-branch',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);if(false)values.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'known-true-data-branch',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);if(true)values.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: false,
  },
  {
    id: 'unconditional-data-method',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);values.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: false,
  },
  {
    id: 'own-error-result',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,unknown>([["failure",{stack:"data"}]]);values.get=()=>error;return(values.get("failure")as Error).stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'different-map-method',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);const other=new Map<string,Error>([["failure",error]]);other.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'custom-function-alias',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,Error>([["failure",error]]);const get=()=>({stack:"data"}as Error);values.get=get;return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: false,
  },
  {
    id: 'own-get-default-source',
    source:
      'function frames(error:Error){const values=new Map<string,{stack?:string}>([["x",{stack:"fixed"}]]);const {a=values.get("x")!.stack}=(values.get=(()=>error) as never,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-get-default-source-other',
    source:
      'function frames(error:Error){const values=new Map<string,{stack?:string}>([["x",{stack:"fixed"}]]);const other=new Map<string,{stack?:string}>();const {a=values.get("x")!.stack}=(other.get=(()=>error) as never,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
] as const;

describe('native Map alternatives readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-writes.ts', source);
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

describe('native Map alternatives shared modules', () => {
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
    const refusal = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [refusal] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
