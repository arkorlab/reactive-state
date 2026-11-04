import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A paired accessor contributes its readable getter before its wider setter input. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-readable-getter',
    source:
      'type Data={stack:string};type Source={get value():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-before-getter',
    source:
      'type Data={stack:string};type Source={set value(input:number|string);get value():number};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quoted-and-identifier-key-pair',
    source:
      'type Data={stack:string};type Source={get "value"():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-literal-key-pair',
    source:
      'type Data={stack:string};type Source={get ["value"]():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'numeric-readable-getter',
    source:
      'type Data={stack:string};type Source={get 1():number;set 1(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'negative-numeric-key-pair',
    source:
      'type Data={stack:string};type Source={get [-1]():number;set "-1"(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hex-and-decimal-key-pair',
    source:
      'type Data={stack:string};type Source={get 0x10():number;set [16](input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readable-string-getter',
    source:
      'type Data={stack:string};type Source={get value():string;set value(input:string|number)};type Target={[key:string]:string};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readable-structural-getter',
    source:
      'type Data={stack:string};type Source={get value():Data;set value(input:Data|Error)};type Target={[key:string]:Data};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'concrete-accessor-alias-argument',
    source:
      'type Data={stack:string};type Box<T>={get value():T;set value(input:T|string)};type Source=Box<number>;type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'default-accessor-alias-argument',
    source:
      'type Data={stack:string};type Box<T=number>={get value():T;set value(input:T|string)};type Source=Box;type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-type-alias',
    source:
      'type Data={stack:string};type Count=number;type Source={get value():Count;set value(input:Count|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-inverse-data-precision',
    source:
      'type Data={stack:string};type Source={get value():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'numeric-getter-inverse-data-precision',
    source:
      'type Data={stack:string};type Source={get 1():number;set "1"(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'getter-only-control',
    source:
      'type Data={stack:string};type Source={get value():number};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-only-input-control',
    source:
      'type Data={stack:string};type Source={set value(input:number)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-only-wide-data-control',
    source:
      'type Data={stack:string};type Source={set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'incompatible-readable-data-control',
    source:
      'type Data={stack:string};type Source={get value():string;set value(input:string|number)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plain-number-property-control',
    source:
      'type Data={stack:string};type Source={value:number};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-string-property-control',
    source:
      'type Data={stack:string};type Source={value:string};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonnumeric-getter-number-domain-control',
    source:
      'type Data={stack:string};type Source={get value():string;set value(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'noncanonical-numeric-key-control',
    source:
      'type Data={stack:string};type Source={get "01"():string;set "01"(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'covering-explicit-string-signature-control',
    source:
      'type Data={stack:string};type Source={[key:string]:number;get value():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'numeric-signature-plus-named-getter',
    source:
      'type Data={stack:string};type Source={[key:number]:number;get value():number;set value(input:number|string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'string-signature-covers-number-target-control',
    source:
      'type Data={stack:string};type Source={[key:string]:number;get value():number;set value(input:number|string)};type Target={[key:number]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-needs-explicit-index-control',
    source:
      'type Data={stack:string};interface Box{get value():number;set value(input:number|string)}type Source=Box;type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'interface-explicit-index-control',
    source:
      'type Data={stack:string};interface Box{[key:string]:number;get value():number;set value(input:number|string)}type Source=Box;type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boolean-readable-getter',
    source:
      'type Data={stack:string};type Source={get value():boolean;set value(input:boolean|number)};type Target={[key:string]:boolean};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-readable-getter',
    source:
      'type Data={stack:string};type Source={get value():"fixed";set value(input:string)};type Target={[key:string]:"fixed"};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'wide-getter-narrow-setter-data-control',
    source:
      'type Data={stack:string};type Source={get value():number|string;set value(input:number)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'readonly-property-control',
    source:
      'type Data={stack:string};type Source={readonly value:number};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unrelated-setter-still-compares',
    source:
      'type Data={stack:string};type Source={get value():number;set value(input:number|string);set other(input:string)};type Target={[key:string]:number};type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('readable accessor index readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'readable-accessor-indices.ts', source);
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

describe('shared readable accessor index admissions', () => {
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
