import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native any-valued string index requirements preserve interface identity and actual bindings. */
const CASES = [
  {
    id: 'reported-interface-string-any',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'reverse-string-any-data',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?{stack:string}:Error;',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: true,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'readonly-string-any',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {readonly [key:string]:any}?true:false;type Failure=Bag extends {readonly [key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {readonly [key:string]:any}?true:false;type Failure=Bag extends {readonly [key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'aliased-any-index-value',
    declarations:
      'interface Bag{x:string}type Value=any;type Decision=Bag extends {[key:string]:Value}?true:false;type Failure=Bag extends {[key:string]:Value}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Value=any;type Decision=Bag extends {[key:string]:Value}?true:false;type Failure=Bag extends {[key:string]:Value}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'generic-actual-any-value',
    declarations:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<any>?true:false;type Failure=Bag extends Dict<any>?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<any>?true:false;type Failure=Bag extends Dict<any>?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'generic-default-any-value',
    declarations:
      'interface Bag{x:string}type Dict<Value=any>={[key:string]:Value};type Decision=Bag extends Dict?true:false;type Failure=Bag extends Dict?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Dict<Value=any>={[key:string]:Value};type Decision=Bag extends Dict?true:false;type Failure=Bag extends Dict?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'whole-union-any-value',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:number|any}?true:false;type Failure=Bag extends {[key:string]:number|any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:number|any}?true:false;type Failure=Bag extends {[key:string]:number|any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'whole-intersection-any-value',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&string}?true:false;type Failure=Bag extends {[key:string]:any&string}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&string}?true:false;type Failure=Bag extends {[key:string]:any&string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'source-generic-environment',
    declarations:
      'interface Bag<T>{x:T}type Decision=Bag<string> extends {[key:string]:any}?true:false;type Failure=Bag<string> extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag<T>{x:T}type Decision=Bag<string> extends {[key:string]:any}?true:false;type Failure=Bag<string> extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'inherited-interface',
    declarations:
      'interface Base{x:string}interface Bag extends Base{}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Base{x:string}interface Bag extends Base{}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'merged-interface',
    declarations:
      'interface Bag{x:string}interface Bag{y:number}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}interface Bag{y:number}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'callable-interface',
    declarations:
      'interface Bag{():void}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag{():void}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'explicit-index-any-pin',
    declarations:
      'interface Bag{[key:string]:unknown}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'interface Bag{[key:string]:unknown}type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'ordinary-literal-any-pin',
    declarations:
      'type Bag={x:string};type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};',
    source:
      'type Bag={x:string};type Decision=Bag extends {[key:string]:any}?true:false;type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'unknown-value-keeps-data',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:unknown}?true:false;type Failure=Bag extends {[key:string]:unknown}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:unknown}?true:false;type Failure=Bag extends {[key:string]:unknown}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'number-value-keeps-data',
    declarations:
      'interface Bag{x:number}type Decision=Bag extends {[key:string]:number}?true:false;type Failure=Bag extends {[key:string]:number}?Error:{stack:string};',
    source:
      'interface Bag{x:number}type Decision=Bag extends {[key:string]:number}?true:false;type Failure=Bag extends {[key:string]:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'never-value-keeps-data',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:never}?true:false;type Failure=Bag extends {[key:string]:never}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:never}?true:false;type Failure=Bag extends {[key:string]:never}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'numeric-any-requires-covering',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:number]:any}?true:false;type Failure=Bag extends {[key:number]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:number]:any}?true:false;type Failure=Bag extends {[key:number]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'mixed-string-numeric-any',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;[key:number]:any}?true:false;type Failure=Bag extends {[key:string]:any;[key:number]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;[key:number]:any}?true:false;type Failure=Bag extends {[key:string]:any;[key:number]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'mixed-string-number-value',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;[key:number]:number}?true:false;type Failure=Bag extends {[key:string]:any;[key:number]:number}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;[key:number]:number}?true:false;type Failure=Bag extends {[key:string]:any;[key:number]:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'mixed-unknown-string-any-number',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:unknown;[key:number]:any}?true:false;type Failure=Bag extends {[key:string]:unknown;[key:number]:any}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:unknown;[key:number]:any}?true:false;type Failure=Bag extends {[key:string]:unknown;[key:number]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'explicit-numeric-any-pin',
    declarations:
      'interface Bag{[key:number]:unknown}type Decision=Bag extends {[key:number]:any}?true:false;type Failure=Bag extends {[key:number]:any}?Error:{stack:string};',
    source:
      'interface Bag{[key:number]:unknown}type Decision=Bag extends {[key:number]:any}?true:false;type Failure=Bag extends {[key:number]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'missing-required-member-keeps-data',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;required:number}?true:false;type Failure=Bag extends {[key:string]:any;required:number}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;required:number}?true:false;type Failure=Bag extends {[key:string]:any;required:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'incompatible-required-member-keeps-data',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;x:number}?true:false;type Failure=Bag extends {[key:string]:any;x:number}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;x:number}?true:false;type Failure=Bag extends {[key:string]:any;x:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'matching-required-member',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;x:string}?true:false;type Failure=Bag extends {[key:string]:any;x:string}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any;x:string}?true:false;type Failure=Bag extends {[key:string]:any;x:string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: true,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'generic-non-any-keeps-data',
    declarations:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<unknown>?true:false;type Failure=Bag extends Dict<unknown>?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<unknown>?true:false;type Failure=Bag extends Dict<unknown>?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'generic-actual-number-keeps-data',
    declarations:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<number>?true:false;type Failure=Bag extends Dict<number>?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Dict<Value>={[key:string]:Value};type Decision=Bag extends Dict<number>?true:false;type Failure=Bag extends Dict<number>?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'inference-still-needs-signature',
    declarations:
      'interface Bag{failure:Error}type Failure=Bag extends {[key:string]:infer V}?V:{stack:string};',
    source:
      'interface Bag{failure:Error}type Failure=Bag extends {[key:string]:infer V}?V:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: null,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'empty-any-never-index',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&never}?true:false;type Failure=Bag extends {[key:string]:any&never}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&never}?true:false;type Failure=Bag extends {[key:string]:any&never}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'disjoint-mixed-any-index',
    declarations:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&string&number}?true:false;type Failure=Bag extends {[key:string]:any&string&number}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Decision=Bag extends {[key:string]:any&string&number}?true:false;type Failure=Bag extends {[key:string]:any&string&number}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'synthetic-generic-result-not-any',
    declarations:
      'interface Bag{x:string}type Value=ReturnType<<T>()=>T>;type Decision=Bag extends {[key:string]:Value}?true:false;type Failure=Bag extends {[key:string]:Value}?Error:{stack:string};',
    source:
      'interface Bag{x:string}type Value=ReturnType<<T>()=>T>;type Decision=Bag extends {[key:string]:Value}?true:false;type Failure=Bag extends {[key:string]:Value}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: false,
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'any-index-retains-named-inference-error',
    declarations:
      'interface Bag{failure:Error}type Failure=Bag extends {[key:string]:any;failure:infer V}?V:{stack:string};',
    source:
      'interface Bag{failure:Error}type Failure=Bag extends {[key:string]:any;failure:infer V}?V:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    nativeTruth: null,
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'any-index-retains-named-inference-data',
    declarations:
      'interface Bag{failure:{stack:string}}type Failure=Bag extends {[key:string]:any;failure:infer V}?V:{stack:string};',
    source:
      'interface Bag{failure:{stack:string}}type Failure=Bag extends {[key:string]:any;failure:infer V}?V:{stack:string};function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    nativeTruth: null,
    refused: false,
    nativeExpected: 'fixed',
  },
] as const;

describe('interface any-valued index relations', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'interface-any-index.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared interface any-valued index relations', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const observations = compile(app).refusals.map(({ reason }) =>
      reason.includes('a shared module that answers otherwise'),
    );

    expect(observations).toStrictEqual(refused ? [true] : []);
  });
});

/** An actual frame observation on its original native compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
