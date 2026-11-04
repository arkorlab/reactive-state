import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'form-reader-get',
    source:
      'function words(error:Error){const form=new FormData();return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-getAll',
    source:
      'function words(error:Error){const form=new FormData();return form.getAll(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-has',
    source:
      'function words(error:Error){const form=new FormData();return form.has(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-populated-get',
    source:
      'function words(error:Error){const form=new FormData();form.append("Error: ours","kept");return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-populated-getAll',
    source:
      'function words(error:Error){const form=new FormData();form.set("Error: ours","kept");return form.getAll(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-populated-has',
    source:
      'function words(error:Error){const form=new FormData();form.append("Error: ours","kept");form.delete("unrelated");return form.has(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-receiver-alias',
    source:
      'function words(error:Error){const form=new FormData();const alias=form;return alias.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-constructor-alias',
    source:
      'const Native=FormData;function words(error:Error){const form=new Native();return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-borrowed-call',
    source:
      'function words(error:Error){const form=new FormData();return FormData.prototype.get.call(form,error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-borrowed-apply',
    source:
      'function words(error:Error){const form=new FormData();return FormData.prototype.getAll.apply(form,[error as never]);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-reflect-apply',
    source:
      'function words(error:Error){const form=new FormData();return Reflect.apply(FormData.prototype.has,form,[error]);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-borrowed-ignores-own',
    source:
      'function words(error:Error){const form=new FormData();form.get=()=>"fixed";return FormData.prototype.get.call(form,error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-caught-name',
    source:
      'function words(){try{JSON.parse("{");}catch(error){const form=new FormData();return form.get(error as never);}}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'form-reader-name-array',
    source:
      'function words(error:Error){const form=new FormData();return form.get([error] as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'form-reader-ordinary-name',
    source: 'function words(error:Error){const form=new FormData();return form.get("fixed");}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-local-error-words',
    source:
      'function words(){const form=new FormData();return form.get(new Error("fixed") as never);}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'form-reader-has-ignored-value',
    source:
      'function words(error:Error){const form=new FormData();return(form.has as unknown as(...args:unknown[])=>boolean)("fixed",error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-getAll-ignored-tail',
    source:
      'function words(error:Error){const form=new FormData();return(form.getAll as unknown as(...args:unknown[])=>FormDataEntryValue[])("fixed",error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-own-callable',
    source:
      'function words(error:Error){const form=new FormData();form.get=()=>"fixed";return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-own-descriptor',
    source:
      'function words(error:Error){const form=new FormData();Object.defineProperty(form,"get",{value(){return"fixed";}});return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-local-constructor',
    source:
      'class FormData{get(_name:unknown){return"fixed";}}function words(error:Error){const form=new FormData();return form.get(error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-plain-object',
    source:
      'function words(error:Error){const form={get(_name:unknown){return"fixed";}};return form.get(error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-own-error-text',
    source:
      'function words(error:Error){const form=new FormData();Object.defineProperty(error,"toString",{value(){return"fixed";}});return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-own-array-text',
    source:
      'function words(error:Error){const form=new FormData();const name=Object.assign([error],{toString(){return"fixed";}});return form.get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-ignored-work-rewrite',
    source:
      'function words(error:Error){const form=new FormData();return(form.get as unknown as(...args:unknown[])=>FormDataEntryValue|null)(error,Object.assign(error,{message:"fixed",name:"Fixed"}));}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-opaque-applied-list',
    source:
      'function words(error:Error){const form=new FormData();function packed():[string,Error]{return["fixed",error];}return Reflect.apply(FormData.prototype.get,form,packed());}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'form-reader-mutator-own-append',
    source:
      'function words(error:Error){const form=new FormData();form.append=()=>{form.get=()=>"fixed";};form.append("name","value");return form.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native FormData reader name conversions readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'form-reader.ts', source);
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

describe('native FormData reader name conversions admissions', () => {
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
