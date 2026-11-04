import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Complete written key sets retain empty keyof results before a never comparison. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-empty-keyof',
    source:
      'type Data={stack:string};type Checked=keyof {};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-empty-alias',
    source:
      'type Data={stack:string};type Empty={};type Checked=keyof Empty;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-keyof-actual',
    source:
      'type Data={stack:string};type Keys<T>=keyof T;type Checked=Keys<{}>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-local-interface',
    source:
      'type Data={stack:string};interface Empty{}type Checked=keyof Empty;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-inherited-interface',
    source:
      'type Data={stack:string};interface Base{}interface Child extends Base{}type Checked=keyof Child;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-merged-interface',
    source:
      'type Data={stack:string};interface Empty{}interface Empty{}type Checked=keyof Empty;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'disjoint-literal-union',
    source:
      'type Data={stack:string};type Checked=keyof ({left:number}|{right:string});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-union-arm',
    source:
      'type Data={stack:string};type Checked=keyof ({}|{value:number});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shared-union-key-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({value:number}|{value:string});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'named-field-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof {value:number};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-signature-has-no-keys',
    source:
      'type Data={stack:string};type Checked=keyof {():void};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'constructor-type-has-no-keys',
    source:
      'type Data={stack:string};type Checked=keyof (new()=>{});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'function-type-has-no-keys',
    source:
      'type Data={stack:string};type Checked=keyof (()=>void);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-unknown-is-empty',
    source:
      'type Data={stack:string};type Checked=keyof unknown;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-object-is-empty',
    source:
      'type Data={stack:string};type Checked=keyof object;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-null-is-empty',
    source:
      'type Data={stack:string};type Checked=keyof null;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-undefined-is-empty',
    source:
      'type Data={stack:string};type Checked=keyof undefined;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-void-is-empty',
    source:
      'type Data={stack:string};type Checked=keyof void;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'parenthesized-never-target',
    source:
      'type Data={stack:string};type Checked=keyof {};type Fits=Checked extends (never)?true:false;type Failure=Checked extends (never)?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-tuple-keyof-comparison',
    source:
      'type Data={stack:string};type Checked=[keyof {}];type Fits=Checked extends [never]?true:false;type Failure=Checked extends [never]?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-keyof-inverse-data-precision',
    source:
      'type Data={stack:string};type Checked=keyof {};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'disjoint-union-inverse-data-precision',
    source:
      'type Data={stack:string};type Checked=keyof ({left:number}|{right:string});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-array-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof number[];type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-tuple-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof [];type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'readonly-tuple-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof readonly [];type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-Error-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof Error;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-number-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof number;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-string-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof string;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'keyof-never-has-property-keys',
    source:
      'type Data={stack:string};type Checked=keyof never;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'keyof-any-has-property-keys',
    source:
      'type Data={stack:string};type Checked=keyof any;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'string-index-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof {[key:string]:number};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'number-index-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof {[key:number]:number};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-index-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof {[key:symbol]:number};type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'overlapping-finite-union-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({keep:number;left:string}|{keep:number;right:boolean});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-keyof-nonempty-actual-data-pin',
    source:
      'type Data={stack:string};type Keys<T>=keyof T;type Checked=Keys<{value:number}>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-boolean-keys-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof boolean;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-native-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|Error);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-unknown-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|unknown);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reversed-native-union',
    source:
      'type Data={stack:string};type Checked=keyof (Error|{});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'qualified-native-error-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|globalThis.TypeError);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-native-array-union',
    source:
      'type Data={stack:string};type Checked=keyof (number[]|{});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-native-primitive-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|string);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-native-boolean-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|boolean);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-local-class-union',
    source:
      'type Data={stack:string};class Thing{value=1;}type Checked=keyof ({}|Thing);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-interface-native-union',
    source:
      'type Data={stack:string};interface Empty{}type Checked=keyof (Empty|Error);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-indexed-shape-union',
    source:
      'type Data={stack:string};type Checked=keyof ({}|{[key:string]:unknown});type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'default-native-union-alias',
    source:
      'type Data={stack:string};type Union<T=Error>={}|T;type Checked=keyof Union;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-native-union-actual',
    source:
      'type Data={stack:string};type Keys<T>=keyof ({}|T);type Checked=Keys<Error>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-native-union',
    source:
      'type Data={stack:string};type Checked=keyof (unknown|Error);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-never-union',
    source:
      'type Data={stack:string};type Checked=keyof (never|unknown);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-native-inverse-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({}|Error);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-unknown-inverse-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({}|unknown);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-explicit-any-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({}|any);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-late-any-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof (({}|Error)|any);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-unknown-any-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({}|unknown|any);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-any-alias-data-pin',
    source:
      'type Data={stack:string};type Whole=any;type Checked=keyof ({}|Whole);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-return-any-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof ({}|ReturnType<()=>any>);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-whole-any-union-data-pin',
    source:
      'type Data={stack:string};type Keys<T>=keyof T;type Checked=Keys<{}|any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-error-shadow-any-data-pin',
    source:
      'type Data={stack:string};type Error=any;type Checked=keyof ({}|Error);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-overlapping-union-data-pin',
    source:
      'type Data={stack:string};type Checked=keyof (Error|TypeError);type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('keyof never relation readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'keyof-never-relations.ts', source);
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

describe('shared keyof never relation admissions', () => {
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
