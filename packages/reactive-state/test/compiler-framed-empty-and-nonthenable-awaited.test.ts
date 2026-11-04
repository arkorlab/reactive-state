import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Closed conditional domains and noncallable then fields preserve declared Error origins. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'empty00-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty00-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty01-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'a'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty01-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'a'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty02-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'|'b'}&{kind:'b'|'c'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty02-N',
    source:
      "type Data={stack:string};type Source={kind:'a'|'b'}&{kind:'b'|'c'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty03-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'|'b'}&{kind:'c'|'d'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty03-N',
    source:
      "type Data={stack:string};type Source={kind:'a'|'b'}&{kind:'c'|'d'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty04-Y',
    source:
      'type Data={stack:string};type Source={kind:string}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty04-N',
    source:
      'type Data={stack:string};type Source={kind:string}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty05-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty05-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty06-Y',
    source:
      'type Data={stack:string};type Source={kind:boolean}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty06-N',
    source:
      'type Data={stack:string};type Source={kind:boolean}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty07-Y',
    source:
      "type Data={stack:string};type Source={kind?:'a'}&{kind?:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty07-N',
    source:
      "type Data={stack:string};type Source={kind?:'a'}&{kind?:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty08-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind?:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty08-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind?:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty09-Y',
    source:
      "type Data={stack:string};type Source={kind?:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty09-N',
    source:
      "type Data={stack:string};type Source={kind?:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty10-Y',
    source:
      'type Data={stack:string};type Source={kind:never}&{x:string};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty10-N',
    source:
      'type Data={stack:string};type Source={kind:never}&{x:string};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty11-Y',
    source:
      "type Data={stack:string};type Source={kind:never}&{kind:'a'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty11-N',
    source:
      "type Data={stack:string};type Source={kind:never}&{kind:'a'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty12-Y',
    source:
      'type Data={stack:string};type Source={kind:never}&{kind:string};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty12-N',
    source:
      'type Data={stack:string};type Source={kind:never}&{kind:string};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty13-Y',
    source:
      "type Data={stack:string};type Source={kind:any}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty13-N',
    source:
      "type Data={stack:string};type Source={kind:any}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty14-Y',
    source:
      "type Data={stack:string};type Source={kind:unknown}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty14-N',
    source:
      "type Data={stack:string};type Source={kind:unknown}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty15-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&any;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty15-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&any;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty16-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&unknown;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty16-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&unknown;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty17-Y',
    source:
      "type Data={stack:string};type Source={nested:{kind:'a'}}&{nested:{kind:'b'}};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty17-N',
    source:
      "type Data={stack:string};type Source={nested:{kind:'a'}}&{nested:{kind:'b'}};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty18-Y',
    source:
      'type Data={stack:string};type Source={left:string}&{right:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty18-N',
    source:
      'type Data={stack:string};type Source={left:string}&{right:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty19-Y',
    source:
      "type A<T>={kind:T};type Data={stack:string};type Source=A<'a'>&A<'b'>;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty19-N',
    source:
      "type A<T>={kind:T};type Data={stack:string};type Source=A<'a'>&A<'b'>;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty20-Y',
    source:
      "interface Left{kind:'a'}interface Base{kind:'b'}interface Right extends Base{}type Data={stack:string};type Source=Left&Right;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty20-N',
    source:
      "interface Left{kind:'a'}interface Base{kind:'b'}interface Right extends Base{}type Data={stack:string};type Source=Left&Right;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty21-Y',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.B>;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty21-N',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.B>;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty22-Y',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.A>;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty22-N',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.A>;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty23-Y',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.Same>;type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty23-N',
    source:
      "type A<T>={kind:T};enum Tag{A='a',B='b',Same='a'}type Data={stack:string};type Source=A<Tag.A>&A<Tag.Same>;type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'await-number-E',
    source:
      'type Failure=Awaited<{then:number;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-number-D',
    source:
      'type Failure=Awaited<{then:number;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-string-E',
    source:
      'type Failure=Awaited<{then:string;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:"fixed",error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-string-D',
    source:
      'type Failure=Awaited<{then:string;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:"fixed",error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-boolean-E',
    source:
      'type Failure=Awaited<{then:boolean;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:true,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-boolean-D',
    source:
      'type Failure=Awaited<{then:boolean;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:true,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-bigint-E',
    source:
      'type Failure=Awaited<{then:bigint;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1n,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-bigint-D',
    source:
      'type Failure=Awaited<{then:bigint;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1n,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-symbol-E',
    source:
      'type Failure=Awaited<{then:symbol;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:Symbol.for("ours"),error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-symbol-D',
    source:
      'type Failure=Awaited<{then:symbol;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:Symbol.for("ours"),error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-null-E',
    source:
      'type Failure=Awaited<{then:null;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:null,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-null-D',
    source:
      'type Failure=Awaited<{then:null;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:null,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-undefined-E',
    source:
      'type Failure=Awaited<{then:undefined;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:undefined,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-undefined-D',
    source:
      'type Failure=Awaited<{then:undefined;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:undefined,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-void-E',
    source:
      'type Failure=Awaited<{then:void;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:undefined,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-void-D',
    source:
      'type Failure=Awaited<{then:void;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:undefined,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-date-E',
    source:
      'type Failure=Awaited<{then:Date;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:new Date(0),error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-date-D',
    source:
      'type Failure=Awaited<{then:Date;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:new Date(0),error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-regexp-E',
    source:
      'type Failure=Awaited<{then:RegExp;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:/x/,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-regexp-D',
    source:
      'type Failure=Awaited<{then:RegExp;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:/x/,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-unknown-E',
    source:
      'type Failure=Awaited<{then:unknown;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-unknown-D',
    source:
      'type Failure=Awaited<{then:unknown;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-constructor-E',
    source:
      'type Failure=Awaited<{then:new()=>Error;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation:
      'frames({then:(class {name="fixed";message="fixed";stack="fixed"}),error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-constructor-D',
    source:
      'type Failure=Awaited<{then:new()=>Error;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation:
      'frames({then:(class {name="fixed";message="fixed";stack="fixed"}),error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-union-E',
    source:
      'type Failure=Awaited<{then:number|string;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-union-D',
    source:
      'type Failure=Awaited<{then:number|string;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-mixed-union-E',
    source:
      'type Failure=Awaited<{then:number|((value:string)=>string);error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-mixed-union-D',
    source:
      'type Failure=Awaited<{then:number|((value:string)=>string);error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-object-E',
    source:
      'type Failure=Awaited<{then:{label:string};error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:{label:"fixed"},error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-object-D',
    source:
      'type Failure=Awaited<{then:{label:string};error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:{label:"fixed"},error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-alias-E',
    source:
      'type Numeric=number;type Failure=Awaited<{then:Numeric;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-alias-D',
    source:
      'type Numeric=number;type Failure=Awaited<{then:Numeric;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-optional-E',
    source:
      'type Failure=Awaited<{then?:(value:Error)=>void;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-optional-D',
    source:
      'type Failure=Awaited<{then?:(value:Error)=>void;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'callable-data',
    source:
      'type Failure=Awaited<{then(done:(value:{stack:string})=>void):void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'getter-data',
    source:
      'type Failure=Awaited<{get then():number;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'unit00-Y',
    source:
      "type Data={stack:string};type Source={kind:never}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit00-N',
    source:
      "type Data={stack:string};type Source={kind:never}&{kind:'a'}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit01-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&{kind:never};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit01-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:'b'}&{kind:never};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit02-Y',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:never}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit02-N',
    source:
      "type Data={stack:string};type Source={kind:'a'}&{kind:never}&{kind:'b'};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit03-Y',
    source:
      'type Data={stack:string};type Source={kind:undefined}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit03-N',
    source:
      'type Data={stack:string};type Source={kind:undefined}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit04-Y',
    source:
      'type Data={stack:string};type Source={kind:number}&{kind:undefined};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit04-N',
    source:
      'type Data={stack:string};type Source={kind:number}&{kind:undefined};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit05-Y',
    source:
      'type Data={stack:string};type Source={kind:null}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit05-N',
    source:
      'type Data={stack:string};type Source={kind:null}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit06-Y',
    source:
      'type Data={stack:string};type Source={kind:number}&{kind:null};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit06-N',
    source:
      'type Data={stack:string};type Source={kind:number}&{kind:null};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit07-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:typeof Right};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit07-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:typeof Right};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit08-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Right}&{kind:typeof Left};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit08-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Right}&{kind:typeof Left};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit09-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:typeof Left};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit09-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:typeof Left};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit10-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit10-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Data={stack:string};type Source={kind:typeof Left}&{kind:number};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit11-Y',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:First.Same};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit11-N',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:First.Same};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit12-Y',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:First.One};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit12-N',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:First.One};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unit13-Y',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:Second.Zero};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit13-N',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:Second.Zero};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'unit14-Y',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:Second.Zero}&{kind:First.Zero};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit14-N',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:Second.Zero}&{kind:First.Zero};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'unit15-Y',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:Second.One};type Target={missing:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unit15-N',
    source:
      'enum First{Zero=0,One=1,Same=0};enum Second{Zero=0,One=1};type Data={stack:string};type Source={kind:First.Zero}&{kind:Second.One};type Target={missing:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-env0-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Box<T>={kind:T};type Data={stack:string};type Source=Box<typeof Left>&Box<typeof Right>;type Failure=Source extends {missing:number}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-env0-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Box<T>={kind:T};type Data={stack:string};type Source=Box<typeof Left>&Box<typeof Right>;type Failure=Source extends {missing:number}?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-env1-Y',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Box<T>={kind:T};type Data={stack:string};type Source=Box<typeof Left>&Box<typeof Left>;type Failure=Source extends {missing:number}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-env1-N',
    source:
      'declare const Left:unique symbol;declare const Right:unique symbol;type Box<T>={kind:T};type Data={stack:string};type Source=Box<typeof Left>&Box<typeof Left>;type Failure=Source extends {missing:number}?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'await-getter-number-E',
    source:
      'type Failure=Awaited<{get then():number;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-getter-pair-E',
    source:
      'type Failure=Awaited<{get then():number;set then(value:(done:(v:Error)=>void)=>void);error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-getter-pair-D',
    source:
      'type Failure=Awaited<{get then():number;set then(value:(done:(v:Error)=>void)=>void);error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-getter-date-E',
    source:
      'type Failure=Awaited<{get then():Date;error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:new Date(0),error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-getter-date-D',
    source:
      'type Failure=Awaited<{get then():Date;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:new Date(0),error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-setter-number-E',
    source:
      'type Failure=Awaited<{set then(value:number);error:Error}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'await-setter-number-D',
    source:
      'type Failure=Awaited<{set then(value:number);error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
    invocation: 'frames({then:1,error:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'await-getter-callable-D',
    source:
      'type Failure=Awaited<{get then():(done:(value:{stack:string})=>void)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'await-overload-D',
    source:
      'type Failure=Awaited<{then(done:(value:Error)=>void):void;then(done:(value:{stack:string})=>void):void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-scope0-Y',
    source:
      'declare namespace LeftNamespace{const tag:unique symbol;type Tag=typeof tag;}declare namespace RightNamespace{const tag:unique symbol;type Tag=typeof tag;}type Data={stack:string};type Source={kind:LeftNamespace.Tag}&{kind:RightNamespace.Tag};type Failure=Source extends {missing:number}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-scope0-N',
    source:
      'declare namespace LeftNamespace{const tag:unique symbol;type Tag=typeof tag;}declare namespace RightNamespace{const tag:unique symbol;type Tag=typeof tag;}type Data={stack:string};type Source={kind:LeftNamespace.Tag}&{kind:RightNamespace.Tag};type Failure=Source extends {missing:number}?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
    reader: false,
  },
  {
    id: 'symbol-scope1-Y',
    source:
      'declare namespace LeftNamespace{const tag:unique symbol;type Tag=typeof tag;}declare namespace RightNamespace{const tag:unique symbol;type Tag=typeof tag;}type Data={stack:string};type Source={kind:LeftNamespace.Tag}&{kind:LeftNamespace.Tag};type Failure=Source extends {missing:number}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
    reader: false,
  },
  {
    id: 'symbol-scope1-N',
    source:
      'declare namespace LeftNamespace{const tag:unique symbol;type Tag=typeof tag;}declare namespace RightNamespace{const tag:unique symbol;type Tag=typeof tag;}type Data={stack:string};type Source={kind:LeftNamespace.Tag}&{kind:LeftNamespace.Tag};type Failure=Source extends {missing:number}?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

/** The actual Error observation on the original written source tree. */
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

describe('empty intersections and nonthenable Awaited origins', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callable-metadata.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(reader);
  });
});

describe('shared empty intersections and nonthenable Awaited', () => {
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
    const reasons = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(reasons).toStrictEqual(refused ? [true] : []);
  });
});
