import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'from-array-review',
    source: 'function frames(error:Error){return Iterator.from([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-supplied-message',
    source: 'function frames(error:Error){return Iterator.from([error]).next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-alias',
    source:
      'function frames(error:Error){const input=[error];const alias=input;return Iterator.from(alias).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-error-alias',
    source:
      'function frames(error:Error){const value=error;return Iterator.from([value]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=Iterator;return Native.from([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-native-callable-alias',
    source:
      'function frames(error:Error){const from=Iterator.from;return from([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-global-computed',
    source:
      'function frames(error:Error){return globalThis.Iterator["from"]([error]).next().value!["stack"];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-values-review',
    source:
      'function frames(error:Error){return Iterator.from([error].values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-entries-value',
    source:
      'function frames(error:Error){return Iterator.from([error].entries()).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-iterator-alias',
    source:
      'function frames(error:Error){const source=[error].values();return Iterator.from(source).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-iterator-result-alias',
    source:
      'function frames(error:Error){const iterator=Iterator.from([error]);return iterator.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-fresh-frames',
    source:
      'function frames(error:Error){return Iterator.from([new Error("fixed")]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-review',
    source:
      'function frames(error:Error){return Iterator.from(new Set([error])).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-add-chain',
    source:
      'function frames(error:Error){return Iterator.from(new Set<Error>().add(error)).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-alias',
    source:
      'function frames(error:Error){const input=new Set([error]);return Iterator.from(input).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-values',
    source:
      'function frames(error:Error){return Iterator.from(new Set([error]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-entry-value',
    source:
      'function frames(error:Error){return Iterator.from(new Map([["failure",error]])).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-entry-key',
    source:
      'function frames(error:Error){return Iterator.from(new Map([[error,"fixed"]])).next().value![0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-alias',
    source:
      'function frames(error:Error){const input=new Map([["failure",error]]);return Iterator.from(input).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-values',
    source:
      'function frames(error:Error){return Iterator.from(new Map([["failure",error]]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-nested-native-wrapper',
    source:
      'function frames(error:Error){return Iterator.from(Iterator.from([error])).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-data-pin',
    source:
      'function frames(error:Error){return Iterator.from([{stack:"fixed"}]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-first-data-pin',
    source:
      'function frames(error:Error){return Iterator.from([{stack:"fixed"},error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-empty-pin',
    source:
      'function frames(error:Error){return(Iterator.from([])as IteratorObject<{stack?:string},undefined,unknown>).next().value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-leading-hole-pin',
    source: 'function frames(error:Error){return Iterator.from([,error]).next().value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-local-words-pin',
    source:
      'function frames(error:Error){return Iterator.from([new Error("fixed")]).next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-entry-key-pin',
    source:
      'function frames(error:Error){return Iterator.from([error].entries()).next().value![0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-local-iterator-pin',
    source:
      'function frames(error:Error){const Iterator={from(_input:unknown){return[{stack:"fixed"}].values();}};return Iterator.from([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-key-data-pin',
    source:
      'function frames(error:Error){return Iterator.from(new Map([["failure",error]] )).next().value![0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-replaced-value-pin',
    source:
      'function frames(error:Error){return Iterator.from(new Map<string,{stack?:string}>([["failure",error],["failure",{stack:"fixed"}]])).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-prior-field-rewrite-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return Iterator.from([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-ignored-acquisition-tail-pin',
    source:
      'function frames(error:Error){return(Iterator.from as(...args:unknown[])=>IteratorObject<{stack?:string},undefined,unknown>)([error],Object.assign(error,{stack:"fixed"})).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-ignored-next-tail-pin',
    source:
      'function frames(error:Error){const iterator=Iterator.from([error]);return(iterator.next as(...args:unknown[])=>IteratorResult<{stack?:string}>)(0,Object.assign(error,{stack:"fixed"})).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-own-next-pin',
    source:
      'function frames(error:Error){const iterator=Iterator.from([error]);iterator.next=()=>({value:{stack:"fixed"}as Error,done:false});return iterator.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-earlier-next-pin',
    source:
      'function frames(error:Error){const iterator=Iterator.from([{stack:"fixed"},error]);iterator.next();return iterator.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-iterator-replacement-pin',
    source:
      'function frames(error:Error){const input=[error];input[Symbol.iterator]=function*(){yield{stack:"fixed"}as Error;return undefined;};return Iterator.from(input).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-construction-ignored-tail-pin',
    source:
      'function frames(error:Error){return Iterator.from(new(Set as new(...args:unknown[])=>Set<{stack?:string}>)([error],Object.assign(error,{stack:"fixed"}))).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-saved-result-input-write-pin',
    source:
      'function frames(error:Error){const result=Iterator.from([error]).next();Object.assign(error,{stack:"fixed"});return result.value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-saved-value-write-pin',
    source:
      'function frames(error:Error){const value=Iterator.from([error]).next().value!;Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-saved-result-opaque-pin',
    source:
      'function frames(error:Error){const result=Iterator.from([error]).next();return result.value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-later-array-replacement-pin',
    source:
      'function frames(error:Error){const input:{stack?:string}[]=[error];const iterator=Iterator.from(input);input[0]={stack:"fixed"};return iterator.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-computed-key-effect-pin',
    source:
      'function frames(error:Error){return Iterator.from([error])[(Object.assign(error,{stack:"fixed"}),"next")]().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-alias',
    source:
      'function frames(error:Error){const input=new Set<Error>().add(error);return Iterator.from(input).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-input-alias',
    source:
      'function frames(error:Error){const input:[[string,Error]]=[["failure",error]];return Iterator.from(new Map(input)).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-wrapped-set-prior-rewrite-pin',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return Iterator.from(new Set([error]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-wrapped-set-constructor-tail-pin',
    source:
      'function frames(error:Error){return Iterator.from(new(Set as new(...args:unknown[])=>Set<{stack?:string}>)([error],Object.assign(error,{stack:"fixed"})).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-wrapped-array-earlier-next-pin',
    source:
      'function frames(error:Error){const input=[error,{stack:"fixed"}].values();input.next();return Iterator.from(input).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-computed-from-effect-pin',
    source:
      'function frames(error:Error){return Iterator[(Object.assign(error,{stack:"fixed"}),"from")]([error]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-local-error-constructor-pin',
    source:
      'function frames(error:Error){const Error=class{stack="fixed";message="fixed";};return Iterator.from([new Error()]).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-eager-extra-entry-effect-pin',
    source:
      'function frames(error:Error){const input:[[string,Error,unknown]]=[["failure",error,Object.assign(error,{stack:"fixed"})]];return Iterator.from(new(Map as new(input:readonly unknown[])=>Map<string,{stack?:string}>)(input)).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'raw-map-alias-overwrite-data',
    source:
      'function frames(error:Error){const first="failure";const last="failure";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'raw-map-alias-distinct-control',
    source:
      'function frames(error:Error){const first="failure";const last="other";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'raw-map-object-alias-overwrite-data',
    source:
      'function frames(error:Error){const key={};const alias=key;return Iterator.from(new Map<object,{stack?:string}>([[key,error],[alias,{stack:"fixed"}]])).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'wrapped-map-values-alias-overwrite-data',
    source:
      'function frames(error:Error){const first="failure";const last="failure";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'wrapped-map-values-alias-distinct-control',
    source:
      'function frames(error:Error){const first="failure";const last="other";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'wrapped-map-values-object-alias-overwrite-data',
    source:
      'function frames(error:Error){const key={};const alias=key;return Iterator.from(new Map<object,{stack?:string}>([[key,error],[alias,{stack:"fixed"}]]).values()).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'wrapped-map-default-alias-overwrite-data',
    source:
      'function frames(error:Error){const first="failure";const last="failure";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])[Symbol.iterator]()).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'wrapped-map-default-alias-distinct-control',
    source:
      'function frames(error:Error){const first="failure";const last="other";return Iterator.from(new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])[Symbol.iterator]()).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'wrapped-map-default-object-alias-overwrite-data',
    source:
      'function frames(error:Error){const key={};const alias=key;return Iterator.from(new Map<object,{stack?:string}>([[key,error],[alias,{stack:"fixed"}]])[Symbol.iterator]()).next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'raw-map-first-error-key-kept-control',
    source:
      'function frames(error:Error){return Iterator.from(new Map([[error,"first"],[error,"fixed"]])).next().value![0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Iterator.from([value]).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return Iterator.from([value]).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return Iterator.from([selected]).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-array-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Iterator.from([value]).next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Iterator.from([value]).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return Iterator.from([value]).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-array-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return Iterator.from([value]).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-add-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return Iterator.from(new Set<Error>().add(selected)).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-set-add-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-set-add-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return Iterator.from(new Set<Error>().add(value)).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return Iterator.from(new Map([["failure",selected]])).next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return Iterator.from(new Map([["failure",value]])).next().value![1].stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-values-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-values-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-values-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return Iterator.from(new Map([["failure",selected]]).values()).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'from-map-values-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-values-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-values-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'from-map-values-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return Iterator.from(new Map([["failure",value]]).values()).next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Iterator from words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iterator-from-forwarding.ts', source);
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

describe('shared native Iterator from admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
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
