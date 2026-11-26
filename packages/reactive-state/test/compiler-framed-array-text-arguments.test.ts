import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Ordinary native string arguments retain nested array word conversions and own text methods. */
const CASES = [
  {
    id: 'concat-array',
    source: "function frames(error:Error){return 'x'.concat([error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-nested-array',
    source: "function frames(error:Error){return 'x'.concat([[error]] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-constant-array',
    source:
      "function frames(error:Error){const values=[error];return 'x'.concat(values as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-array-parameter',
    source: "function frames(values:readonly Error[]){return 'x'.concat(values as never);}",
    refused: true,
    invocation: 'frames([new Error("native-marker")])',
  },
  {
    id: 'concat-native-call',
    source:
      "function frames(error:Error){return String.prototype.concat.call('x',[error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'search-first-array',
    source:
      "function frames(error:Error){return 'Error: native-marker'.startsWith([error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'search-split-array',
    source:
      "function frames(error:Error){return 'Error: native-marker'.split([error] as never).length;}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'replacement-search-array',
    source:
      "function frames(error:Error){return 'Error: native-marker'.replace([error] as never,'fixed');}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'replacement-value-array',
    source: "function frames(error:Error){return 'x'.replace('x',[error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'replacement-all-array',
    source: "function frames(error:Error){return 'xx'.replaceAll('x',[[error]] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'replacement-native-call-array',
    source:
      "function frames(error:Error){return (String.prototype.replace as (search:string,replacement:string)=>string).call('x','x',[error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'uri-array',
    source: 'function frames(error:Error){return encodeURIComponent([error] as never);}',
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-direct-error-pin',
    source: "function frames(error:Error){return 'x'.concat(error as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-spread-array-pin',
    source:
      "function frames(error:Error){return 'x'.concat(...([[error]] as unknown as string[]));}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'concat-native-apply-pin',
    source:
      "function frames(error:Error){return String.prototype.concat.apply('x',[[error] as never]);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ordinary-array',
    source: "function frames(error:Error){return 'x'.concat(['fixed'] as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'empty-array',
    source: "function frames(error:Error){return 'x'.concat([] as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'locally-written-array-words',
    source: "function frames(error:Error){return 'x'.concat([new Error('ours')] as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'own-array-toString',
    source:
      "function frames(error:Error){const values=[error];values.toString=()=> 'fixed';return 'x'.concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'own-array-join',
    source:
      "function frames(error:Error){const values=[error];values.join=()=> 'fixed';return 'x'.concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-search-tail',
    source:
      "function frames(error:Error){return ('x'.includes as (...values:unknown[])=>boolean)('x',0,[error]);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'own-concat',
    source:
      "function frames(error:Error){const own={concat(_value:unknown){return 'fixed';}};return own.concat([error]);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'tail-overrides-array-toString',
    source:
      "function frames(error:Error){const values=[error];return 'x'.concat(values as never,(values.toString=()=> 'fixed',''));}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'tail-overrides-array-join',
    source:
      "function frames(error:Error){const values=[error];return 'x'.concat(values as never,(values.join=()=> 'fixed',''));}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'tail-rewrites-Error-words',
    source:
      "function frames(error:Error){const values=[error];return 'x'.concat(values as never,(Object.assign(error,{name:'Fixed',message:'fixed'}),''));}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-search-tail-rewrites-words',
    source:
      "function frames(error:Error){const values=[error];return ('Fixed: fixed'.includes as (...args:unknown[])=>boolean)(values,0,(Object.assign(error,{name:'Fixed',message:'fixed'}),0));}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-replacement-tail-overrides-words',
    source:
      "function frames(error:Error){const values=[error];return ('x'.replace as (...args:unknown[])=>string)('x',values,(values.toString=()=> 'fixed',''));}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'computed-callee-overrides-array-words',
    source:
      "function frames(error:Error){const values=[error];return 'x'[(values.toString=()=> 'fixed','concat')](values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'receiver-evaluation-overrides-array-words',
    source:
      "function frames(error:Error){const values=[error];return String((values.toString=()=> 'fixed','x')).concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'earlier-conversion-overrides-array-words',
    source:
      "function frames(error:Error){const values=[error];const first={toString(){values.toString=()=> 'fixed';return '';}};return 'x'.concat(first as never,values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'array-element-conversion-rewrites-words',
    source:
      "function frames(error:Error){const values=[{toString(){Object.assign(error,{name:'Fixed',message:'fixed'});return '';}},error];return 'x'.concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'receiver-getter-overrides-array-words',
    source:
      "function frames(error:Error){const values=[error];const box={get text():string{values.toString=()=> 'fixed';return 'x';}};return box.text.concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'borrowed-receiver-conversion-overrides-words',
    source:
      "function frames(error:Error){const values=[error];const receiver={toString(){values.toString=()=> 'fixed';return 'x';}};return String.prototype.concat.call(receiver,values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'legacy-apply-tail-opaque-pin',
    source:
      "function frames(error:Error){const values=[error];return (Reflect.apply as (...args:unknown[])=>string)(String.prototype.concat,'x',[values],(values.toString=()=> 'fixed',''));}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'earlier-owner-rewrites-Error-words',
    source:
      "function frames(error:Error){Object.assign(error,{name:'Fixed',message:'fixed'});return 'x'.concat([error] as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'parameter-default-rewrites-Error-words',
    source:
      "function frames(error:Error,_done=(Object.assign(error,{name:'Fixed',message:'fixed'}),0)){return 'x'.concat([error] as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'typed-array-prior-application-work',
    source:
      "function frames(values:Error[]){function settle(value:Error[]){value.toString=()=> 'fixed';}settle(values);return 'x'.concat(values as never);}",
    refused: false,
    invocation: 'frames([new Error("native-marker")])',
  },
  {
    id: 'earlier-own-method-assignment-pin',
    source:
      "function frames(error:Error){const values=[error];values.toString=()=> 'fixed';return 'x'.concat(values as never);}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'borrowed-null-receiver-is-not-converted',
    source:
      'function frames(error:Error){return String.prototype.concat.call(null,[error] as never);}',
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'clean-search-tail-keeps-array-words',
    source:
      "function frames(error:Error){return ('Error: native-marker'.startsWith as (...args:unknown[])=>boolean)([error],0,[]);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'earlier-primitive-array-keeps-array-words',
    source:
      "function frames(error:Error){return 'x'.concat(['prefix'] as never,[error] as never);}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'typed-array-constant-alias-keeps-words',
    source:
      "function frames(values:readonly Error[]){const saved=values;return 'x'.concat(saved as never);}",
    refused: true,
    invocation: 'frames([new Error("native-marker")])',
  },
  {
    id: 'borrowed-URI-array-keeps-words',
    source: 'function frames(error:Error){return encodeURIComponent.call(null,[error] as never);}',
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-tail-nonconstructor-prototype',
    source:
      "function frames(error:Error){return ('x'.startsWith as (...args:unknown[])=>boolean)([error],0,new (String.prototype as unknown as new()=>unknown)());}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-tail-nonconstructor-method',
    source:
      "function frames(error:Error){return ('x'.startsWith as (...args:unknown[])=>boolean)([error],0,new (String.prototype.concat as unknown as new()=>unknown)());}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-tail-nonconstructor-reflect',
    source:
      "function frames(error:Error){return ('x'.startsWith as (...args:unknown[])=>boolean)([error],0,new (Reflect.apply as unknown as new()=>unknown)());}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-tail-nonconstructor-URI',
    source:
      "function frames(error:Error){return ('x'.startsWith as (...args:unknown[])=>boolean)([error],0,new (encodeURIComponent as unknown as new()=>unknown)());}",
    refused: false,
    invocation: 'frames(new Error("native-marker"))',
  },
  {
    id: 'ignored-tail-native-String-alias-keeps-words',
    source:
      "function frames(error:Error){const Native=String;return ('Error: native-marker'.startsWith as (...args:unknown[])=>boolean)([error],0,new Native('fixed'));}",
    refused: true,
    invocation: 'frames(new Error("native-marker"))',
  },
] as const;

describe('array text argument readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-text-arguments.ts', source);
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

describe('shared array text arguments', () => {
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
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
