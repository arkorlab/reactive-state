import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'params-get-error-name',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return params.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-getAll-error-name',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return params.getAll(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-has-error-name',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return params.has(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-has-error-value',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return params.has("fixed",error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-caught-reader',
    source:
      'function words(){try{JSON.parse("{");}catch(error){return new URLSearchParams("fixed=value").get(error as never);}}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'params-reader-constant-alias',
    source:
      'function words(error:Error){const Native=URLSearchParams;const first=new Native("fixed=value");const params=first;return params.getAll(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-borrowed-call',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return URLSearchParams.prototype.get.call(params,error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-borrowed-apply',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return URLSearchParams.prototype.getAll.apply(params,[error as never]);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-reflect-apply',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return Reflect.apply(URLSearchParams.prototype.has,params,["fixed",error]);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-borrowed-ignores-own',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");params.get=()=>"fixed";return URLSearchParams.prototype.get.call(params,error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-array-name',
    source:
      'function words(error:Error){return new URLSearchParams("fixed=value").get([error] as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-reader-local-words-pin',
    source:
      'function words(){return new URLSearchParams("fixed=value").get(new Error("fixed") as never);}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'params-reader-ordinary-name-pin',
    source: 'function words(){return new URLSearchParams("fixed=value").get("fixed");}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'params-reader-own-assignment-pin',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");params.get=()=>"fixed";return params.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-own-descriptor-pin',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");Object.defineProperty(params,"get",{value:()=>"fixed"});return params.get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-own-object-pin',
    source:
      'function words(error:Error){const params={get(_name:unknown){return"fixed";}};return params.get(error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-local-constructor-pin',
    source:
      'class URLSearchParams{constructor(_text:string){}get(_name:unknown){return"fixed";}}function words(error:Error){return new URLSearchParams("fixed=value").get(error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-ignored-tail-pin',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return(params.get as unknown as(...values:unknown[])=>string|null)("fixed",error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-has-ignored-tail-pin',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return(params.has as unknown as(...values:unknown[])=>boolean)("fixed","value",error);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-own-array-text-pin',
    source:
      'function words(error:Error){const name=Object.assign([error],{toString(){return"fixed";}});return new URLSearchParams("fixed=value").get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-reader-opaque-apply-ignored-tail-pin',
    source:
      'function words(error:Error){function packed():[string,Error]{return["fixed",error];}const params=new URLSearchParams("fixed=value");return Reflect.apply(URLSearchParams.prototype.get,params,packed());}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native parameter reader conversions readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'param-readers-observations.ts', source);
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

describe('native parameter reader conversions admissions', () => {
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
