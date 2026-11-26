import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'statement-error-value',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-constant-alias',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const alias=values;alias.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-computed-method',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values["set"]("x",error);return values["get"]("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-constructor-alias',
    source:
      'const NativeMap=globalThis.Map;function frames(error:Error){const values=new NativeMap<string,{message:string}>([["x",{message:"fixed"}]]);values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-unknown-key',
    source:
      'function frames(error:Error,key:string){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set(key,error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"),"x")',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-spread-pair',
    source:
      'function store(pair:[string,Error]){const values=new Map([["x",{message:"fixed"}]]);values.set(...pair);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-rest-value',
    source:
      'function store(...rest:[Error]){const values=new Map([["x",{message:"fixed"}]]);values.set("x",...rest);return values.get("x")!.message;}function frames(error:Error){return store(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-apply-list',
    source:
      'function store(args:[string,Error]){const values=new Map([["x",{message:"fixed"}]]);Map.prototype.set.apply(values,args);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-reflect-list',
    source:
      'function store(args:[string,Error]){const values=new Map([["x",{message:"fixed"}]]);Reflect.apply(Map.prototype.set,values,args);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-call-spread',
    source:
      'function store(pair:[string,Error]){const values=new Map([["x",{message:"fixed"}]]);Map.prototype.set.call(values,...pair);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-chain-spread',
    source:
      'function store(pair:[string,Error]){const values=new Map([["x",{message:"fixed"}]]);values.set("y",{message:"other"}).set(...pair);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unread-typed-error-spread',
    source:
      'function store(pair:[string,Error]){const values=new Map<string,Error|{message:string}>([["x",{message:"fixed"}]]);values.set(...pair);return values.get("x")!.message;}function frames(error:Error){return store(["x",error]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'read-spread-pair',
    source:
      'function frames(error:Error){void error;const values=new Map([["x",{message:"fixed"}]]);const pair:[string,{message:string}]=["x",{message:"other"}];values.set(...pair);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'read-apply-list',
    source:
      'function frames(error:Error){void error;const values=new Map([["x",{message:"fixed"}]]);Map.prototype.set.apply(values,["x",{message:"other"}]);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'read-reflect-list',
    source:
      'function frames(error:Error){void error;const values=new Map([["x",{message:"fixed"}]]);Reflect.apply(Map.prototype.set,values,["x",{message:"other"}]);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'read-call-arguments',
    source:
      'function frames(error:Error){void error;const values=new Map([["x",{message:"fixed"}]]);Map.prototype.set.call(values,"x",{message:"other"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'read-chain-values',
    source:
      'function frames(error:Error){void error;const values=new Map([["x",{message:"fixed"}]]);values.set("y",{message:"other"}).set("x",{message:"other"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unread-rest-other-key',
    source:
      'function store(...rest:[Error]){const values=new Map([["x",{message:"fixed"}]]);values.set("y",...rest);return values.get("x")!.message;}function frames(error:Error){return store(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-constant-key-alias',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const key="x";values.set(key,error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-possible-branch',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);if(flag)values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"),true)',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-selected-branch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);if(true)values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-called-closure',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);function store(){values.set("x",error);}store();return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-captured-later-write',
    source:
      'const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);function frames(error:Error){const result=values.get("x")!.message;values.set("x",error);return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-repeated-later-write',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);let result="";for(const index of [0,1]){void index;result=values.get("x")!.message;values.set("x",error);}return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-repeated-condition-write',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);let result="";let index=0;do{result=values.get("x")!.message;}while(values.set("x",error)&&index++<1);return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-borrowed-get',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set("x",error);return Map.prototype.get.call(values,"x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-borrowed-set',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);Map.prototype.set.call(values,"x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-reflected-set',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);Reflect.apply(Map.prototype.set,values,["x",error]);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-zero-key',
    source:
      'function frames(error:Error){const values=new Map<number,{message:string}>([[0,{message:"fixed"}]]);values.set(-0,error);return values.get(0)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-review-case',
    source:
      'function frames(error:Error){return new Map().set("failure",error).get("failure").stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-error-value',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>().set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-constructor-entry',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>([["x",{message:"fixed"}]]).set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-constant-result-alias',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>().set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-base-alias',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const alias=values;return alias.set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-last-error-wins',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>().set("x",{message:"fixed"}).set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'possible-own-get',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);if(flag)values.get=()=>({message:"fixed"});values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"),true)',
    reader: true,
    refused: true,
  },
  {
    id: 'possible-own-set',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);if(flag)values.set=()=>values;values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"),false)',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-last-data-wins-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set("x",error);values.set("x",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-overwrites-constructor-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",error]]);values.set("x",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'chain-last-data-wins-pin',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>().set("x",error).set("x",{message:"fixed"}).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'chain-unrelated-key-pin',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>([["x",{message:"fixed"}]]).set("other",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-unrelated-key-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set("other",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-unrelated-map-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const other=new Map<string,{message:string}>();other.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-lexical-shadow-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);{const values=new Map<string,{message:string}>();values.set("x",error);}return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-later-write-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const result=values.get("x")!.message;values.set("x",error);return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-skipped-branch-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);if(false)values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-unused-closure-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);function store(){values.set("x",error);}return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-own-get-data-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.get=()=>({message:"fixed"});values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-own-set-data-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>values;values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-own-set-block-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>{values.clear();return values;};values.set("x",error);return values.get("x")?.message??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  // Through a set that answers another Map, the get reads the declared value type: it admits one.
  {
    id: 'chain-own-set-other-result-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>new Map([["x",{message:"fixed"}]]);return values.set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-own-get-data-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.get=()=>({message:"fixed"});return values.set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-borrows-call-on-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){return Map.prototype.set.call(this,key,value);};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-borrows-reflect-on-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){return Reflect.apply(Map.prototype.set,this,[key,value]);};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-heritage-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){class Base{}class Holder extends (Map.prototype.set.call(this,key,value),Base){}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-member-name-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){class Holder{[String(Map.prototype.set.call(this,key,value))](){return 0;}}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-member-body-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){void key;void value;class Base{}class Holder extends Base{write(){return Map.prototype.set.call(this,"x",undefined);}}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-parameter-decorator-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){const mark=(_target:object,_name:string|symbol|undefined,_index:number)=>undefined;class Holder{take(@(Map.prototype.set.call(this,key,value),mark) input:unknown){return input;}}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-constructor-decorator-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){const mark=(_target:object,_name:string|symbol|undefined,_index:number)=>undefined;class Holder{constructor(@(Map.prototype.set.call(this,key,value),mark) input:unknown){void input;}}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-parameter-decorator-other',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const other=new Map<string,unknown>();values.set=function(key:string,value:{message:string}){const mark=(_target:object,_name:string|symbol|undefined,_index:number)=>undefined;class Holder{take(@(Map.prototype.set.call(other,key,value),mark) input:unknown){return input;}}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-implements-type',
    source:
      'type values={};function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){void key;void value;class Holder implements values{}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-implements-extends-write',
    source:
      'type values={};function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){class Base{}class Holder extends (Map.prototype.set.call(values,key,value),Base) implements values{}void Holder;return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-get-borrows-call-on-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",error]]);values.get=function(key:string){return Map.prototype.get.call(this,key);};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-get-borrows-reflect-on-this',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",error]]);values.get=function(key:string){return Reflect.apply(Map.prototype.get,this,[key]);};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-get-other-key-borrow',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",error]]);values.get=function(key:string){void key;return Map.prototype.get.call(this,"y");};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-self-delete-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){Reflect.deleteProperty(this,"set");return this.set(key,value);};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-self-delete-call-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){Reflect.deleteProperty(this,"set");return this.set.call(this,key,value);};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-self-delete-reflect-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){Reflect.deleteProperty(this,"set");return Reflect.apply(this.set,this,[key,value]);};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-other-key-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){void key;return this.set("y",value);};values.set("x",(values.set=Map.prototype.set,error));return values.get("y")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-other-key-call-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){void key;return this.set.call(this,"y",value);};values.set("x",(values.set=Map.prototype.set,error));return values.get("y")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-other-key-reflect-redispatch',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",{message:"fixed"}]]);values.set=function(key:string,value:{message:string}){void key;return Reflect.apply(this.set,this,["y",value]);};values.set("x",(values.set=Map.prototype.set,error));return values.get("y")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-set-returns-this-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(){return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-unrelated-call-pin',
    source:
      'function frames(error:Error){const seen:string[]=[];const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=function(key:string){seen.push(key);return this;};values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-set-arrow-writes-other-map-pin',
    source:
      'function frames(error:Error){const other=new Map<string,{message:string}>();const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=(key:string,value:{message:string})=>other.set(key,value);values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-get-returns-this-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}|Error>([["x",error]]);values.get=function(){return this;};return String((values.get("x") as {message?:string}).message);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-set-other-key',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",{message:"fixed"}]]);const methods=[function(this:Map<string,{message:string}>,key:string,value:{message:string}){void key;return Map.prototype.set.call(this,"y",value);}];values.set=methods[0]!;values.set("x",error);return values.get("y")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unknown-set-data-arguments-pin',
    source:
      'function frames(error:Error){void error;const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const methods=[function(this:Map<string,{message:string}>,key:string,value:{message:string}){return Map.prototype.set.call(this,key,value);}];values.set=methods[0]!;values.set("x",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-get-unread-body',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}|Error>([["x",{message:"fixed"}]]);values.get=function(key:string){if(key)return error;return {message:"fixed"};};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-get-readable-body-data-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}|Error>([["x",error]]);values.get=function(){return {message:"fixed"};};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-get-method-unread',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}|Error>([["x",{message:"fixed"}]]);const methods=[function(){return error;}];values.get=methods[0]!;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unknown-get-other-key-write',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const methods=[function(this:Map<string,{message:string}>,key:string){void key;return Map.prototype.get.call(this,"y");}];values.get=methods[0]!;values.set("y",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unknown-get-other-key-entry',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",error]]);const methods=[function(this:Map<string,{message:string}>,key:string){void key;return Map.prototype.get.call(this,"y");}];values.get=methods[0]!;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-get-unread-body-other-key',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",error]]);const box={m:values};values.get=function(key:string){if(key)return Map.prototype.get.call(box.m,"y");return {message:"fixed"};};return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unknown-get-data-entries-pin',
    source:
      'function frames(error:Error){void error;const values=new Map<string,{message:string}>([["x",{message:"fixed"}],["y",{message:"fixed"}]]);const methods=[function(this:Map<string,{message:string}>,key:string){void key;return Map.prototype.get.call(this,"y");}];values.get=methods[0]!;values.set("y",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    // An own get the compile cannot read may answer anything the declared value type admits.
    reader: true,
    refused: true,
  },
  {
    id: 'native-get-reinstalled-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["bad",error],["safe",{message:"fixed"}]]);values.get=Map.prototype.get;return values.get("safe")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-get-reinstalled-selected-error',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["bad",error],["safe",{message:"fixed"}]]);values.get=Map.prototype.get;return values.get("bad")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-get-alias-pin',
    source:
      'function frames(error:Error){const nativeGet=Map.prototype.get;const values=new Map<string,{message:string}>([["bad",error],["safe",{message:"fixed"}]]);values.get=nativeGet;return values.get("safe")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-or-unknown-get-other-key',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,{message:string}>([["bad",error],["safe",{message:"fixed"}]]);const methods=[function(this:Map<string,{message:string}>,key:string){void key;return Map.prototype.get.call(this,"bad");}];values.get=flag?Map.prototype.get:methods[0]!;return values.get("safe")!.message;}',
    invocation: 'frames(new Error("ours"),false)',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-local-words-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set("x",new Error("fixed"));return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'chain-local-words-pin',
    source:
      'function frames(error:Error){return new Map().set("x",new Error("fixed")).get("x").message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'chain-local-constructor-pin',
    source:
      'class Map{set(_key:unknown,_value:unknown){return this;}get(_key:unknown){return{message:"fixed"};}}function frames(error:Error){return new Map().set("x",error).get("x").message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-ignored-extra-value-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);(values.set as (...args:unknown[])=>typeof values)("x",{message:"fixed"},error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'chain-explicit-native-value-type-pin',
    source:
      'function frames(error:Error,values:Map<string,Error>){return(values.set("x",error)as Map<string,Error>).get("x")!.stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-borrowed-set-bypasses-own',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>values;return Map.prototype.set.call(values,"x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-custom-chain-other-map-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>new Map([["x",{message:"fixed"}]]);const other=values.set("x",error);other.set("x",error);other.set=()=>other;values.set=Map.prototype.set;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-own-method-key-pin',
    source:
      'function frames(error:Error){const keys={setTime(_value:number){return "other";}};const values=new Map<string,{message:string}>([["x",error]]);values.set(keys.setTime(NaN),{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-own-set-keeps-entry-pin',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",error]]);values.set=()=>values;values.set("x",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'possible-own-set-keeps-entry-pin',
    source:
      'function frames(error:Error,flag:boolean){const values=new Map<string,{message:string}>([["x",error]]);if(flag)values.set=()=>values;values.set("x",{message:"fixed"});return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"),true)',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-reset-delete',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>values;delete(values as {set?:unknown}).set;values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-reset-logical',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);values.set=()=>values;values.set&&=Map.prototype.set;values.set("x",error);return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-default-source-write',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const {a=values.get("x")!.message}=(values.set("x",error),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-default-source-other-map',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const other=new Map<string,unknown>();const {a=values.get("x")!.message}=(other.set("x",error),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statement-heritage-write',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);class Base{}class Holder extends (values.set("x",error),Base){}void Holder;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'statement-heritage-other-map',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const other=new Map<string,unknown>();class Base{}class Holder extends (other.set("x",error),Base){}void Holder;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Map set value words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'map-set-values.ts', source);
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

describe('shared Map set value admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_MAP_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
