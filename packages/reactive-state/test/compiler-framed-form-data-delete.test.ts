import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'form-delete-error-name',
    source:
      'function frames(error:Error){const data=new FormData();data.delete(error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-delete-receiver-alias',
    source:
      'function frames(error:Error){const original=new FormData();const data=original;data.delete(error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-delete-borrowed-call',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.delete.call(data,error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-delete-borrowed-apply',
    source:
      'function frames(error:Error){const data=new FormData();FormData.prototype.delete.apply(data,[error as never]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-delete-reflect-apply',
    source:
      'function frames(error:Error){const data=new FormData();Reflect.apply(FormData.prototype.delete,data,[error]);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'form-delete-own-method-data',
    source:
      'function frames(error:Error){const data=new FormData();data.delete=()=>{};data.delete(error as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-delete-local-shadow',
    source:
      'function frames(error:Error){class FormData{delete(_name:unknown){}get(_name:string){return"fixed";}}const data=new FormData();data.delete(error);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-delete-ignored-second',
    source:
      'function frames(error:Error){const data=new FormData();(data.delete as(...args:unknown[])=>void)("fixed",error);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-delete-data-name',
    source:
      'function frames(error:Error){const data=new FormData();data.delete("fixed");return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'form-delete-local-made-words',
    source:
      'function frames(error:Error){const data=new FormData();data.delete(new Error("fixed")as never);return data.get("failure");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('native FormData delete readers', () => {
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

describe('native FormData delete admissions', () => {
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
