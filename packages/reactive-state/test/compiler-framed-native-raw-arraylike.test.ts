import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native raw array-like slots retain their consumed Error text without crossing opaque evaluations. */
const CASES = [
  {
    id: 'original-own-raw-slot',
    source: 'function frames(error:Error){return String.raw({raw:{0:error as never,length:1}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global-own-raw-slot',
    source:
      'function frames(error:Error){return globalThis.String.raw({raw:{0:error as never,length:1}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-own-raw-slot',
    source:
      'function frames(error:Error){return String.raw.call(null,{raw:{0:error as never,length:1}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'applied-own-raw-slot',
    source:
      'function frames(error:Error){return String.raw.apply(null,[{raw:{0:error as never,length:1}}]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quoted-own-slot',
    source: 'function frames(error:Error){return String.raw({raw:{"0":error as never,length:1}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-literal-slot',
    source: 'function frames(error:Error){return String.raw({raw:{[0]:error as never,length:1}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-raw-constant',
    source:
      'function frames(error:Error){const raw={0:error as never,length:1};return String.raw({raw});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-template-constant',
    source:
      'function frames(error:Error){const template={raw:{0:error as never,length:1}};return String.raw(template);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'primitive-prefix-slot',
    source:
      'function frames(error:Error){return String.raw({raw:{0:"",1:error as never,length:2}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fractional-length',
    source: 'function frames(error:Error){return String.raw({raw:{0:error as never,length:1.9}});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'numeric-text-length',
    source:
      'function frames(error:Error){return String.raw({raw:{0:error as never,length:"1"}}as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-native-result',
    source:
      'function frames(error:Error){const output=String.raw({raw:{0:error as never,length:1}});return output;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-length-ignores-substitution',
    source:
      'function frames(error:Error){return String.raw({raw:{0:error as never,length:0}},error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'negative-length-ignores-substitution',
    source:
      'function frames(error:Error){return String.raw({raw:{0:error as never,length:-1}},error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'out-of-range-error-slot',
    source:
      'function frames(error:Error){return String.raw({raw:{0:"fixed",1:error as never,length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'missing-first-slot',
    source:
      'function frames(error:Error){return String.raw({raw:{1:error as never,length:1}}as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'opaque-length-boundary',
    source:
      'function frames(error:Error,length:number){return String.raw({raw:{0:error as never,length}});}',
    refused: false,
    invocation: 'frames(new Error("ours"),0)',
  },
  {
    id: 'length-getter-boundary',
    source:
      'function frames(error:Error){return String.raw({raw:{0:error as never,get length(){Object.assign(error,{name:"",message:"fixed"});return 1;}}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'slot-getter-boundary',
    source:
      'function frames(error:Error){return String.raw({raw:{get 0(){Object.assign(error,{name:"",message:"fixed"});return error as never;},length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'earlier-conversion-boundary',
    source:
      'function frames(error:Error){const value={toString(){Object.assign(error,{name:"",message:"fixed"});return "";}};return String.raw({raw:{0:value as never,1:error as never,length:2}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-argument-effect-boundary',
    source:
      'function frames(error:Error){return String.raw({raw:{0:error as never,length:1}},(Object.assign(error,{name:"",message:"fixed"}),"ignored"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-error-method-boundary',
    source:
      'function frames(error:Error){Object.assign(error,{toString(){return "fixed";}});return String.raw({raw:{0:error as never,length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'raw-slot-write-boundary',
    source:
      'function frames(error:Error){const raw:{0:unknown,length:number}={0:error,length:1};raw[0]="fixed";return String.raw({raw:raw as never});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-native-shadow',
    source:
      'function frames(error:Error){const String={raw(_template:unknown){return "fixed";}};return String.raw({raw:{0:error,length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constructed-error-control',
    source:
      'function frames(_error:Error){return String.raw({raw:{0:new Error("fixed")as never,length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-origin-control',
    source: 'function frames(error:Error){return String.raw({raw:[error as never]});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-data-control',
    source: 'function frames(_error:Error){return String.raw({raw:["fixed"]});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-data-control',
    source: 'function frames(_error:Error){return String.raw({raw:{0:"fixed",length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'single-object-segment-ignores-substitution',
    source:
      'function frames(error:Error){return String.raw({raw:{0:"fixed",length:1}},error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'negative-key-remains-unconsumed',
    source:
      'function frames(error:Error){return String.raw({raw:{"-1":error as never,0:"fixed",length:1}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inherited-hole-getter-boundary',
    source:
      'function frames(error:Error){return String.raw({raw:{__proto__:{get 0(){Object.assign(error,{name:"",message:"fixed"});return "";}},1:error as never,length:2}}as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-raw-after-own-method-boundary',
    source:
      'function frames(error:Error){const raw={0:error as never,length:1};function collect(){return String.raw({raw});}Object.assign(error,{toString(){return "fixed";}});return collect();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-substitution-before-error-slot',
    source:
      'function frames(error:Error,earlier:unknown){return String.raw({raw:{0:"",1:error as never,length:2}},earlier as never);}',
    refused: false,
    invocation:
      '(()=>{const supplied=new Error("ours");return frames(supplied,{toString(){Object.assign(supplied,{name:"",message:"fixed"});return "";}});})()',
  },
  {
    id: 'unknown-substitution-array-before-error-slot',
    source:
      'function frames(error:Error,earlier:unknown){return String.raw({raw:{0:"",1:error as never,length:2}},[earlier]as never);}',
    refused: false,
    invocation:
      '(()=>{const supplied=new Error("ours");return frames(supplied,{toString(){Object.assign(supplied,{name:"",message:"fixed"});return "";}});})()',
  },
  {
    id: 'first-error-slot-before-unknown-substitution',
    source:
      'function frames(error:Error,earlier:unknown){return String.raw({raw:{0:error as never,1:"",length:2}},earlier as never);}',
    refused: true,
    invocation:
      '(()=>{const supplied=new Error("ours");return frames(supplied,{toString(){Object.assign(supplied,{name:"",message:"fixed"});return "";}});})()',
  },
  {
    id: 'quiet-primitive-substitution-before-error-slot',
    source:
      'function frames(error:Error){return String.raw({raw:{0:"",1:error as never,length:2}},"quiet"as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native raw arraylike readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared native raw arraylike text', () => {
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
