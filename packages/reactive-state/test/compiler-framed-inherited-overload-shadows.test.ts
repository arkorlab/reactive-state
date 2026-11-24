import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A non-inference requirement is met by any written overload of a source method, as TypeScript's
 * relation is; inference keeps reading the final overload.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'exact-report-direct-conditional',
    source:
      'interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Failure=Derived extends{f(value:string):void}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reported-inherited-any-not-overload',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inverse-inherited-any-data',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'function-property-requirement',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f:(value:string)=>void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'matching-own-number-data-pin',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f(value:number):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'matching-own-number-error-pin',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f(value:number):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'multilevel-nearest-method',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Middle extends Base{f(value:number):void;}interface Derived extends Middle{}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'multilevel-nearest-inverse-data',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Middle extends Base{f(value:number):void;}interface Derived extends Middle{}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inherited-base-type-literal',
    source:
      'type Data={stack:string};type Base={f(value:any):void};interface Derived extends Base{f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-literal-own-method',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{["f"](value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-own-actual',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived<T> extends Base{f(value:T):void;}type Source=Derived<number>;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-own-default',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived<T=number> extends Base{f(value:T):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-base-and-own',
    source:
      'type Data={stack:string};interface Base<T>{f(value:T):void;}interface Derived<T> extends Base<any>{f(value:T):void;}type Source=Derived<number>;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-of-generic-own',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Model<T> extends Base{f(value:T):void;}type Derived=Model<number>;type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-own-incompatible-overloads',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}interface Derived{f(value:boolean):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-own-inverse-data',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}interface Derived{f(value:boolean):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unrelated-first-merged-body',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{caption:string;}interface Derived{f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'genuine-own-overloads-data',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;f(value:string):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'genuine-own-overloads-error',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:string):void;f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'genuine-merged-own-overloads',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{f(value:number):void;}interface Derived{f(value:string):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'genuine-inherited-overloads',
    source:
      'type Data={stack:string};interface Base{f(value:string):void;f(value:number):void;}interface Derived extends Base{}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unrelated-own-field-keeps-overloads',
    source:
      'type Data={stack:string};interface Base{f(value:string):void;f(value:number):void;}interface Derived extends Base{caption:string;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unrelated-computed-member-keeps-own',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}declare const marker:unique symbol;interface Derived extends Base{[marker]():void;f(value:number):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-property-shadows-base-overloads',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;f(value:number):void;}interface Derived extends Base{f:(value:number)=>void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-property-inverse-data',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;f(value:number):void;}interface Derived extends Base{f:(value:number)=>void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-literal-overloads-pin',
    source:
      'type Data={stack:string};type Derived={f(value:string):void;f(value:number):void};type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-literal-single-mismatch-pin',
    source:
      'type Data={stack:string};type Derived={f(value:number):void};type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'multiple-identical-bases-pin',
    source:
      'type Data={stack:string};interface Left{f(value:number):void;}interface Right{f(value:number):void;}interface Derived extends Left,Right{}type Source=Derived;type Target={f(value:number):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'no-owned-member-retains-base-any',
    source:
      'type Data={stack:string};interface Base{f(value:any):void;}interface Derived extends Base{}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'different-name-keeps-inherited-overload',
    source:
      'type Data={stack:string};interface Base{f(value:string):void;f(value:number):void;}interface Derived extends Base{other(value:boolean):void;}type Source=Derived;type Target={f(value:string):void};type Matches=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('inherited overload shadow readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inherited-overload-shadows.ts', source);
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

describe('shared inherited overload shadow admissions', () => {
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
