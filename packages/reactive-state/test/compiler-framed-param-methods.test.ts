import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'params-set-value',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set("x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-append-value',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.append("x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-set-key',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set(error as never,"fixed");return p.toString();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-delete-key',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.delete(error as never);return p.toString();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-delete-value',
    source:
      'function frames(error:Error){const p=new URLSearchParams("x=fixed");p.delete("x",error as never);return p.toString();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'headers-set-value',
    source:
      'function frames(error:Error){const p=new Headers();p.set("x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'headers-append-value',
    source:
      'function frames(error:Error){const p=new Headers();p.append("x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'headers-delete-name',
    source:
      'function frames(error:Error){const p=new Headers();p.delete(error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-borrowed-call',
    source:
      'function frames(error:Error){const p=new URLSearchParams();URLSearchParams.prototype.set.call(p,"x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'headers-borrowed-reflect',
    source:
      'function frames(error:Error){const p=new Headers();Reflect.apply(Headers.prototype.append,p,["x",error]);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-native-method-alias',
    source:
      'function frames(error:Error){const p=new URLSearchParams();const set=URLSearchParams.prototype.set;set.call(p,"x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-borrowed-apply',
    source:
      'function frames(error:Error){const p=new URLSearchParams();URLSearchParams.prototype.set.apply(p,["x",error as never]);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-constructor-alias',
    source:
      'const Native=URLSearchParams;function frames(error:Error){const p=new Native();p.set("x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'borrowed-native-ignores-own',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set=()=>{};URLSearchParams.prototype.set.call(p,"x",error as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'params-data',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set("x","fixed");return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'headers-data',
    source:
      'function frames(error:Error){const p=new Headers();p.append("x","fixed");return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'params-local-words',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set("x",new Error("fixed") as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'headers-local-words',
    source:
      'function frames(error:Error){const p=new Headers();p.append("x",new Error("fixed") as never);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'params-own-set-data',
    source:
      'function frames(error:Error){const p=new URLSearchParams();p.set=()=>{};p.set("x",error as never);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'headers-own-append-data',
    source:
      'function frames(error:Error){const p=new Headers();p.append=()=>{};p.append("x",error as never);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'local-constructor-shadow',
    source:
      'class URLSearchParams{set(_key:string,_value:unknown){}get(_key:string){return "fixed";}}function frames(error:Error){const p=new URLSearchParams();p.set("x",error);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'params-ignored-trailing',
    source:
      'function frames(error:Error){const p=new URLSearchParams();(p.set as (...args:unknown[])=>void)("x","fixed",error);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'headers-delete-ignored-value',
    source:
      'function frames(error:Error){const p=new Headers({x:"fixed"});(p.delete as (...args:unknown[])=>void)("x",error);return p.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-data-receiver',
    source:
      'function frames(error:Error,p:{set:(key:string,value:unknown)=>void}){p.set("x",error);return "fixed";}',
    invocation: 'frames(new Error("ours"),{set(){}})',
    reader: false,
    refused: false,
  },
];

describe('native parameter method readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('native parameter method admissions', () => {
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
