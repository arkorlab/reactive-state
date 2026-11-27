import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'json-local-error-stack',
    source: 'function frames(){return JSON.stringify(new Error("fixed"),["stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-supplied-error-words',
    source: 'function frames(error:Error){return JSON.stringify(error,["message"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-caught-error-words',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return JSON.stringify(error,["message"]);}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-property-list-alias',
    source: 'function frames(error:Error){const keys=["stack"];return JSON.stringify(error,keys);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-engine-frame-file-name',
    source: 'function frames(error:Error){return JSON.stringify(error,["fileName"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-nested-array-error',
    source: 'function frames(error:Error){return JSON.stringify([error],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-nested-object-error',
    source:
      'function frames(error:Error){return JSON.stringify({failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-property-list-index-write',
    source:
      'function frames(error:Error){const keys=["name"];keys[0]="stack";return JSON.stringify(error,keys);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-default-nonenumerable-pin',
    source: 'function frames(){return JSON.stringify(new Error("fixed"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-empty-property-list-pin',
    source: 'function frames(){return JSON.stringify(new Error("fixed"),[]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-ordinary-name-pin',
    source: 'function frames(error:Error){return JSON.stringify(error,["name"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-local-written-words-pin',
    source: 'function frames(){return JSON.stringify(new Error("fixed"),["message"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-fixed-data-pin',
    source: 'function frames(){return JSON.stringify({stack:"fixed"},["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-callback-result-pin',
    source: 'function frames(error:Error){return JSON.stringify(error,()=>"fixed");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-own-to-json-pin',
    source:
      'function frames(){return JSON.stringify(Object.assign(new Error("fixed"),{toJSON(){return{stack:"fixed"};}}),["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-own-to-json-prior-define-pin',
    source:
      'function frames(){const error=new Error("fixed");Object.defineProperty(error,"toJSON",{value:()=>({stack:"fixed"})});return JSON.stringify(error,["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-ignored-nonarray-replacer-pin',
    source:
      'function frames(){return JSON.stringify(new Error("fixed"),{0:"stack",length:1} as never);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-unselected-nested-error-pin',
    source: 'function frames(error:Error){return JSON.stringify({failure:error},["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-overwritten-nested-value-pin',
    source:
      'function frames(error:Error){return JSON.stringify({...{failure:error},failure:{stack:"fixed"}},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-overwritten-property-list-pin',
    source:
      'function frames(error:Error){const keys=["stack"];keys[0]="name";return JSON.stringify(error,keys);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-local-json-shadow-pin',
    source:
      'const JSON={stringify(_value:unknown,_keys:unknown){return"fixed";}};function frames(error:Error){return JSON.stringify(error,["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-own-to-json-returns-error',
    source:
      'function frames(){return JSON.stringify(Object.assign(new Error("fixed"),{toJSON(){return new Error("nested");}}),["stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-nested-to-json-returns-error',
    source:
      'function frames(){return JSON.stringify({child:{toJSON(){return new Error("nested");}}},["child","stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-own-stack-getter-returns-error',
    source:
      'function frames(){return JSON.stringify(Object.defineProperty(new Error("fixed"),"stack",{get(){return new Error("nested");}}),["stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-prior-stack-getter-returns-error',
    source:
      'function frames(){const error=new Error("fixed");Object.defineProperty(error,"stack",{get(){return new Error("nested");}});return JSON.stringify(error,["stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-string-box-property-list',
    source:
      'function frames(){return (JSON.stringify as unknown as(value:unknown,replacer:readonly unknown[])=>string|undefined)(new Error("fixed"),[new String("stack")]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-native-call-wrapper',
    source: 'function frames(error:Error){return JSON.stringify.call(null,error,["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-own-to-json-once-pin',
    source:
      'function frames(){return JSON.stringify({toJSON(){return{toJSON(){return new Error("unused");},stack:"fixed"};}},["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-own-stack-data-pin',
    source:
      'function frames(){return JSON.stringify(Object.defineProperty(new Error("fixed"),"stack",{value:"fixed"}),["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-own-stack-getter-data-pin',
    source:
      'function frames(){return JSON.stringify(Object.defineProperty(new Error("fixed"),"stack",{get(){return"fixed";}}),["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-prior-stack-data-pin',
    source:
      'function frames(){const error=new Error("fixed");Object.defineProperty(error,"stack",{value:"fixed"});return JSON.stringify(error,["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-number-box-property-list-pin',
    source:
      'function frames(){return (JSON.stringify as unknown as(value:unknown,replacer:readonly unknown[])=>string|undefined)(new Error("fixed"),[new Number("stack")]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-literal-getter-data-pin',
    source: 'function frames(){return JSON.stringify({get stack(){return"fixed";}},["stack"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-key-lexical-shadow-pin',
    source:
      'const keys=["stack"];function frames(error:Error){const keys=["name"];return JSON.stringify(error,keys);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-key-call-mutation-pin',
    source:
      'function frames(error:Error){const keys=["stack"];const receiver={setTime(_value:number){keys[0]="name";return 0;}};receiver.setTime(NaN);return JSON.stringify(error,keys);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-stack-getter-do-condition',
    source:
      'function frames(){const error=new Error("fixed");let text="";let i=0;do{text=JSON.stringify(error,["stack"]);}while((Object.defineProperty(error,"stack",{get(){return new Error("nested");},configurable:true}),i++<1));return text;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-stack-getter-comma',
    source:
      'function frames(){const error=new Error("fixed");return (Object.defineProperty(error,"stack",{get(){return new Error("nested");},configurable:true}),JSON.stringify(error,["stack"]));}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-stack-getter-branch',
    source:
      'function frames(flag=true){const error=new Error("fixed");if(flag)Object.defineProperty(error,"stack",{get(){return new Error("nested");},configurable:true});return JSON.stringify(error,["stack"]);}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-stack-getter-loop-body',
    source:
      'function frames(){const error=new Error("fixed");let text="";for(let i=0;i<2;i++){text=JSON.stringify(error,["stack"]);Object.defineProperty(error,"stack",{get(){return new Error("nested");},configurable:true});}return text;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'json-stack-getter-do-condition-data',
    source:
      'function frames(){const error=new Error("fixed");let text="";let i=0;do{text=JSON.stringify(error,["message"]);}while((Object.defineProperty(error,"stack",{get(){return "fixed";},configurable:true}),i++<1));return text;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-stack-getter-comma-data',
    source:
      'function frames(){const error=new Error("fixed");return (Object.defineProperty(error,"stack",{get(){return "fixed";},configurable:true}),JSON.stringify(error,["message"]));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-stack-getter-branch-data',
    source:
      'function frames(flag=true){const error=new Error("fixed");if(flag)Object.defineProperty(error,"stack",{get(){return "fixed";},configurable:true});return JSON.stringify(error,["message"]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-stack-getter-loop-body-data',
    source:
      'function frames(){const error=new Error("fixed");let text="";for(let i=0;i<2;i++){text=JSON.stringify(error,["message"]);Object.defineProperty(error,"stack",{get(){return "fixed";},configurable:true});}return text;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'json-keys-loop-condition-use',
    source:
      'function frames(error:Error){const keys=["stack"];let result:unknown;let i=0;do{result=JSON.stringify(error,keys);}while((void keys,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-keys-loop-condition-data',
    source:
      'function frames(error:Error){let result:unknown;let i=0;do{result=JSON.stringify(error,["name"]);}while((void error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'json-keys-default-use',
    source:
      'function frames(error:Error){const keys=["stack"];let text="";const {a=keys.length}=(text=JSON.stringify(error,keys),{} as {a?:number});return text+a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'json-keys-default-data',
    source:
      'function frames(){const keys=["stack"];let text="";const {a=keys.length}=(text=JSON.stringify({value:1},keys),{} as {a?:number});return text+a;}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('json property-list error observations readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'json-observations.ts', source);
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

describe('json property-list error observations admissions', () => {
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
