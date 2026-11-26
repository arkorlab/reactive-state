import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'form-set-error-value',
    source:
      'function frames(error:Error){const data=new FormData();data.set("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-append-error-value',
    source:
      'function frames(error:Error){const data=new FormData();data.append("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-set-error-name',
    source:
      'function frames(error:Error){const data=new FormData();data.set(error as never,"fixed");return Array.from(data.keys())[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-append-caught-error',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){const data=new FormData();data.append("failure",error as never);return data.get("failure");}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'form-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=globalThis.FormData;const data=new Native();data.set("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-whole-receiver-alias',
    source:
      'function frames(error:Error){const original=new FormData();const data=original;data.set("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-borrowed-call',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.set.call(data,"failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-borrowed-apply',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.append.apply(data,["failure",error as never]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-reflect-apply',
    source:
      'function frames(error:Error){const data=new FormData();Reflect.apply(FormData.prototype.append,data,["failure",error]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-known-spread-call',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.set.call(...[data,"failure",error as never]as[FormData,string,never]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-native-borrow-ignores-own',
    source:
      'function frames(error:Error){const data=new FormData();data.append=()=>{};FormData.prototype.append.call(data,"failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-blob-filename-error',
    source:
      'function frames(error:Error){const data=new FormData();data.append("failure",new Blob(),error as never);return(data.get("failure")as File).name;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-blob-alias-filename-error',
    source:
      'function frames(error:Error){const data=new FormData();const blob=new Blob();data.set("failure",blob,error as never);return(data.get("failure")as File).name;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-set-data',
    source:
      'function frames(error:Error){const data=new FormData();data.set("failure","fixed");return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-append-data',
    source:
      'function frames(error:Error){const data=new FormData();data.append("failure","fixed");return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-local-made-words',
    source:
      'function frames(error:Error){const data=new FormData();data.set("failure",new Error("fixed")as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-local-shadow',
    source:
      'function frames(error:Error){class FormData{set(_name:string,_value:unknown){}get(_name:string){return"fixed";}}const data=new FormData();data.set("failure",error);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-own-append-data',
    source:
      'function frames(error:Error){const data=new FormData();data.append=()=>{};data.append("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-own-set-data',
    source:
      'function frames(error:Error){const data=new FormData();data.set=()=>{};data.set("failure",error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-blob-filename-data',
    source:
      'function frames(error:Error){const data=new FormData();data.append("failure",new Blob(),"fixed");return(data.get("failure")as File).name;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-string-third-not-converted',
    source:
      'function frames(error:Error){const data=new FormData();try{data.append("failure","fixed"as never,error as never);}catch{return"fixed";}return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-data-borrowed-apply',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.append.apply(data,["failure","fixed"as never]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-blob-overload-rejects-error-value',
    source:
      'function frames(error:Error){const data=new FormData();try{data.set("failure",error as never,"fixed");}catch{return"fixed";}return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-typed-blob-filename-error',
    source:
      'function frames(error:Error,blob:Blob){const data=new FormData();data.append("failure",blob,error as never);return(data.get("failure")as File).name;}',
    invocation: 'frames(new Error("ours"),new Blob())',
    reader: true,
    refused: true,
  },
  {
    id: 'form-typed-local-blob-shadow-data',
    source:
      'function frames(error:Error){class Blob{}const blob:Blob=new Blob();const data=new FormData();try{data.append("failure",blob as never,error as never);}catch{return"fixed";}return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('native FormData methods readers', () => {
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

describe('native FormData methods admissions', () => {
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
    await recordReasons(source, reasons);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

/** Focused comparison diagnostics retain the actual compiler refusal without changing expectations. */
async function recordReasons(source: string, reasons: readonly string[]): Promise<void> {
  const path = process.env['FORM_DATA_OBSERVATIONS'];
  if (path === undefined || path === '') return;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(path, `${JSON.stringify({ source, reasons })}\n`);
}
