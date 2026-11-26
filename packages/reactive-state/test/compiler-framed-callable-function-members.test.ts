import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Implicit native Function metadata follows written suppliers and existing weak-object rules. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'case00-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case00-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case01-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case01-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case02-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case02-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case03-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case03-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case04-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case04-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case05-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case05-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case06-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={call:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case06-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={call:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case07-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={apply:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case07-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={apply:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case08-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case08-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case09-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={arguments:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case09-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={arguments:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case10-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={caller:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case10-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={caller:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case11-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case11-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case12-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={length?:number;caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case12-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={length?:number;caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case13-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case13-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case14-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case14-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case15-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case15-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case16-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case16-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case17-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case17-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case18-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case18-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case19-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={call:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case19-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={call:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case20-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={apply:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case20-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={apply:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case21-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case21-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case22-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={arguments:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case22-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={arguments:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case23-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caller:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case23-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caller:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case24-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case24-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case25-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length?:number;caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case25-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={length?:number;caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case26-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case26-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case27-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case27-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case28-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case28-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case29-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case29-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case30-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case30-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case31-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case31-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case32-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={call:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case32-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={call:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case33-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={apply:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case33-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={apply:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case34-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case34-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case35-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={arguments:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case35-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={arguments:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case36-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caller:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case36-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caller:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case37-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case37-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case38-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length?:number;caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case38-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={length?:number;caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case39-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case39-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case40-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case40-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case41-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case41-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case42-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case42-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case43-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case43-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case44-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case44-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case45-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={call:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case45-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={call:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case46-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={apply:Function};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case46-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={apply:Function};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case47-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case47-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case48-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={arguments:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case48-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={arguments:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case49-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caller:unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case49-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caller:unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'case50-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case50-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case51-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length?:number;caption?:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case51-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={length?:number;caption?:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case52-Y',
    source:
      'type Data={stack:string};type Source={():string;length:"fixed"};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case52-N',
    source:
      'type Data={stack:string};type Source={():string;length:"fixed"};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case53-Y',
    source:
      'type Data={stack:string};type Source={():string;length:"fixed"};type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case53-N',
    source:
      'type Data={stack:string};type Source={():string;length:"fixed"};type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case54-Y',
    source:
      'type Data={stack:string};type Source={():string;length?:number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case54-N',
    source:
      'type Data={stack:string};type Source={():string;length?:number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case55-Y',
    source:
      'type Data={stack:string};type Source={():string;length?:number};type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case55-N',
    source:
      'type Data={stack:string};type Source={():string;length?:number};type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case56-Y',
    source:
      'type Data={stack:string};type Source={():string;name:number};type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case56-N',
    source:
      'type Data={stack:string};type Source={():string;name:number};type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case57-Y',
    source:
      'type Data={stack:string};type Source={():string;name:number};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case57-N',
    source:
      'type Data={stack:string};type Source={():string;name:number};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case58-Y',
    source:
      'type Data={stack:string};type Source={<T>(value:T):T};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case58-N',
    source:
      'type Data={stack:string};type Source={<T>(value:T):T};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case59-Y',
    source:
      'type Data={stack:string};type Source={(value:string):string;(value:number):number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case59-N',
    source:
      'type Data={stack:string};type Source={(value:string):string;(value:number):number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case60-Y',
    source:
      'interface Call{():string}type Data={stack:string};type Source=Call;type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case60-N',
    source:
      'interface Call{():string}type Data={stack:string};type Source=Call;type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'case61-Y',
    source:
      'interface Call{():string}interface Own extends Call{length:string}type Data={stack:string};type Source=Own;type Target={length:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'case61-N',
    source:
      'interface Call{():string}interface Own extends Call{length:string}type Data={stack:string};type Source=Own;type Target={length:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus00-Y',
    source:
      'type Data={stack:string};type Source={length:number}&({():string});type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus00-N',
    source:
      'type Data={stack:string};type Source={length:number}&({():string});type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus01-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{length:number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus01-N',
    source:
      'type Data={stack:string};type Source=({():string})&{length:number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus02-Y',
    source:
      'type Data={stack:string};type Source={length:1}&({():string});type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus02-N',
    source:
      'type Data={stack:string};type Source={length:1}&({():string});type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus03-Y',
    source:
      'type Data={stack:string};type Source={length:1}&({():string});type Target={length:1};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus03-N',
    source:
      'type Data={stack:string};type Source={length:1}&({():string});type Target={length:1};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus04-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{length:1};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus04-N',
    source:
      'type Data={stack:string};type Source=({():string})&{length:1};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus05-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{length:1};type Target={length:1};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus05-N',
    source:
      'type Data={stack:string};type Source=({():string})&{length:1};type Target={length:1};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus06-Y',
    source:
      'type Data={stack:string};type Source={length?:number}&({():string});type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus06-N',
    source:
      'type Data={stack:string};type Source={length?:number}&({():string});type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus07-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{length?:number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus07-N',
    source:
      'type Data={stack:string};type Source=({():string})&{length?:number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus08-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&({():string});type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus08-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&({():string});type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus09-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&({():string});type Target={length:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus09-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&({():string});type Target={length:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus10-Y',
    source:
      "type Data={stack:string};type Source=({():string})&{length:'fixed'};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus10-N',
    source:
      "type Data={stack:string};type Source=({():string})&{length:'fixed'};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus11-Y',
    source:
      "type Data={stack:string};type Source=({():string})&{length:'fixed'};type Target={length:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus11-N',
    source:
      "type Data={stack:string};type Source=({():string})&{length:'fixed'};type Target={length:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus12-Y',
    source:
      'type Data={stack:string};type Source={name:string}&({():string});type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus12-N',
    source:
      'type Data={stack:string};type Source={name:string}&({():string});type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus13-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{name:string};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus13-N',
    source:
      'type Data={stack:string};type Source=({():string})&{name:string};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus14-Y',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&({():string});type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus14-N',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&({():string});type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus15-Y',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&({():string});type Target={name:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus15-N',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&({():string});type Target={name:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus16-Y',
    source:
      "type Data={stack:string};type Source=({():string})&{name:'fixed'};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus16-N',
    source:
      "type Data={stack:string};type Source=({():string})&{name:'fixed'};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus17-Y',
    source:
      "type Data={stack:string};type Source=({():string})&{name:'fixed'};type Target={name:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus17-N',
    source:
      "type Data={stack:string};type Source=({():string})&{name:'fixed'};type Target={name:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus18-Y',
    source:
      'type Data={stack:string};type Source={name?:string}&({():string});type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus18-N',
    source:
      'type Data={stack:string};type Source={name?:string}&({():string});type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus19-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{name?:string};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus19-N',
    source:
      'type Data={stack:string};type Source=({():string})&{name?:string};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus20-Y',
    source:
      'type Data={stack:string};type Source={name:number}&({():string});type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus20-N',
    source:
      'type Data={stack:string};type Source={name:number}&({():string});type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus21-Y',
    source:
      'type Data={stack:string};type Source={name:number}&({():string});type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus21-N',
    source:
      'type Data={stack:string};type Source={name:number}&({():string});type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus22-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{name:number};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus22-N',
    source:
      'type Data={stack:string};type Source=({():string})&{name:number};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus23-Y',
    source:
      'type Data={stack:string};type Source=({():string})&{name:number};type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus23-N',
    source:
      'type Data={stack:string};type Source=({():string})&{name:number};type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus24-Y',
    source:
      'type Data={stack:string};type Source={length:number}&(()=>string);type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus24-N',
    source:
      'type Data={stack:string};type Source={length:number}&(()=>string);type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus25-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus25-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus26-Y',
    source:
      'type Data={stack:string};type Source={length:1}&(()=>string);type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus26-N',
    source:
      'type Data={stack:string};type Source={length:1}&(()=>string);type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus27-Y',
    source:
      'type Data={stack:string};type Source={length:1}&(()=>string);type Target={length:1};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus27-N',
    source:
      'type Data={stack:string};type Source={length:1}&(()=>string);type Target={length:1};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus28-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:1};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus28-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:1};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus29-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:1};type Target={length:1};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus29-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length:1};type Target={length:1};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus30-Y',
    source:
      'type Data={stack:string};type Source={length?:number}&(()=>string);type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus30-N',
    source:
      'type Data={stack:string};type Source={length?:number}&(()=>string);type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus31-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length?:number};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus31-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{length?:number};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus32-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus32-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus33-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus33-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus34-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus34-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus35-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus35-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus36-Y',
    source:
      'type Data={stack:string};type Source={name:string}&(()=>string);type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus36-N',
    source:
      'type Data={stack:string};type Source={name:string}&(()=>string);type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus37-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:string};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus37-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:string};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus38-Y',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&(()=>string);type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus38-N',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&(()=>string);type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus39-Y',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&(()=>string);type Target={name:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus39-N',
    source:
      "type Data={stack:string};type Source={name:'fixed'}&(()=>string);type Target={name:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus40-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{name:'fixed'};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus40-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{name:'fixed'};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus41-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{name:'fixed'};type Target={name:'fixed'};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus41-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{name:'fixed'};type Target={name:'fixed'};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus42-Y',
    source:
      'type Data={stack:string};type Source={name?:string}&(()=>string);type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus42-N',
    source:
      'type Data={stack:string};type Source={name?:string}&(()=>string);type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus43-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name?:string};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus43-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name?:string};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus44-Y',
    source:
      'type Data={stack:string};type Source={name:number}&(()=>string);type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus44-N',
    source:
      'type Data={stack:string};type Source={name:number}&(()=>string);type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus45-Y',
    source:
      'type Data={stack:string};type Source={name:number}&(()=>string);type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus45-N',
    source:
      'type Data={stack:string};type Source={name:number}&(()=>string);type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus46-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:number};type Target={name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus46-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:number};type Target={name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus47-Y',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:number};type Target={name:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus47-N',
    source:
      'type Data={stack:string};type Source=(()=>string)&{name:number};type Target={name:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus48-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus48-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus49-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={apply:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus49-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={apply:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus50-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={call:boolean};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus50-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={call:boolean};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus51-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={caller:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus51-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={caller:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus52-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus52-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus53-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={arguments:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus53-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={arguments:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus54-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus54-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus55-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus55-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={prototype:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus56-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus56-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus57-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={apply:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus57-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={apply:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus58-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={call:boolean};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus58-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={call:boolean};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus59-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caller:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus59-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={caller:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus60-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus60-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus61-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={arguments:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus61-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={arguments:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus62-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus62-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus63-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus63-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={prototype:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus64-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus64-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus65-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={apply:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus65-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={apply:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus66-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={call:boolean};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus66-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={call:boolean};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus67-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caller:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus67-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={caller:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus68-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus68-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus69-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={arguments:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus69-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={arguments:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus70-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus70-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={bind:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus71-Y',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus71-N',
    source:
      'type Data={stack:string};type Source={new():Date};type Target={prototype:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus72-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus72-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus73-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={apply:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus73-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={apply:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus74-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={call:boolean};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus74-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={call:boolean};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus75-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caller:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus75-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={caller:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus76-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus76-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus77-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={arguments:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus77-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={arguments:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'plus78-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus78-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={bind:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plus79-Y',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:never};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plus79-N',
    source:
      'type Data={stack:string};type Source=new()=>Date;type Target={prototype:never};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias0-Y',
    source:
      'type S=string;type Data={stack:string};type Source={():string};type Target={bind:S};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias0-N',
    source:
      'type S=string;type Data={stack:string};type Source={():string};type Target={bind:S};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias1-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string|number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias1-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string|number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias2-Y',
    source:
      'type S=string;type Data={stack:string};type Source={():string};type Target={bind:S|number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias2-N',
    source:
      'type S=string;type Data={stack:string};type Source={():string};type Target={bind:S|number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias3-Y',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string|unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias3-N',
    source:
      'type Data={stack:string};type Source={():string};type Target={bind:string|unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'alias4-Y',
    source:
      'type S=string;type Data={stack:string};type Source=()=>string;type Target={bind:S};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias4-N',
    source:
      'type S=string;type Data={stack:string};type Source=()=>string;type Target={bind:S};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias5-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string|number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias5-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string|number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias6-Y',
    source:
      'type S=string;type Data={stack:string};type Source=()=>string;type Target={bind:S|number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias6-N',
    source:
      'type S=string;type Data={stack:string};type Source=()=>string;type Target={bind:S|number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias7-Y',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string|unknown};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias7-N',
    source:
      'type Data={stack:string};type Source=()=>string;type Target={bind:string|unknown};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'weak0-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&{():string};type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'weak0-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&{():string};type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weak1-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length?:number};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'weak1-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length?:number};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix00-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length?:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix00-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length?:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix01-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix01-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix02-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix02-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&(()=>string);type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix03-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length?:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix03-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length?:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix04-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix04-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix05-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix05-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed';caption:string};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix06-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length?:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix06-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length?:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix07-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix07-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix08-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix08-N',
    source:
      "type Data={stack:string};type Source={length:'fixed';caption:string}&{():string};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix09-Y',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length?:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix09-N',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length?:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix10-Y',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length:number;caption:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix10-N',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length:number;caption:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix11-Y',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix11-N',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed';caption:string};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix12-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix12-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&(()=>string);type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix13-Y',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix13-N',
    source:
      "type Data={stack:string};type Source=(()=>string)&{length:'fixed'};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix14-Y',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&{():string};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix14-N',
    source:
      "type Data={stack:string};type Source={length:'fixed'}&{():string};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mix15-Y',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed'};type Target={length?:number;name:string};type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mix15-N',
    source:
      "type Data={stack:string};type Source={():string}&{length:'fixed'};type Target={length?:number;name:string};type Failure=Source extends Target?Data:Error;function frames(value:Failure){return value.stack;}",
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

describe('callable Function metadata origins', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callable-metadata.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(reader);
  });
});

describe('shared callable Function metadata', () => {
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
