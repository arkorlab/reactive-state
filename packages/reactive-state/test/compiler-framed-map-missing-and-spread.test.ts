import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * Missing Map values and source-known get spreads keep the selected native result. An input a
 * collection's reader cannot read — past a comma that may run code, a call's result, a parameter —
 * may hold an Error where the declared value type admits one; a quiet comma is read through.
 */
const CASES = [
  {
    id: 'missing-other-value-retains-first',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-entry-value-slot',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never]).entries().next().value![1].stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-whole-map-alias',
    source:
      "function frames(error:Error){const values=new Map([['first',error],['other'] as never]);return values.values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-default-iterator',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never])[Symbol.iterator]().next().value![1].stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'first-missing-later-error-overwrite',
    source:
      "function frames(error:Error){return new Map<string,Error>([['first'] as never,['first',error],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-unrelated-entry-retains-first',
    source:
      "function frames(error:Error){return new Map([['first',error],[] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-value-same-key-clears-error',
    source:
      "function frames(error:Error){try{return new Map([['first',error],['first'] as never]).values().next().value!.stack;}catch{return'fixed';}}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-clears-undefined-first-key',
    source:
      "function frames(error:Error){try{return new Map<unknown,Error>([[undefined,error],[] as never]).values().next().value!.stack;}catch{return'fixed';}}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'missing-value-keeps-ordinary-data',
    source:
      "function frames(error:Error){return new Map([['first',{stack:'fixed'}],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'explicit-undefined-other-pin',
    source:
      "function frames(error:Error){return new Map<string,Error|undefined>([['first',error],['other',undefined]]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-reported-spread-safe',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...(['safe'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-whole-tuple-alias-safe',
    source:
      "function frames(error:Error){const keys=['safe'] as const;return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...keys)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-nested-spread-safe',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...([...['safe']] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-spread-selected-error-pin',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...(['bad'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-exposed-tuple-retains-error-pin',
    source:
      "function frames(error:Error){const keys=['safe'] as [string];keys[0]='bad';return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...keys)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-borrowed-safe-pin',
    source:
      "function frames(error:Error){return Map.prototype.get.call(new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]),...(['safe'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-own-safe-pin',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['bad',error]]);values.get=()=>({stack:'fixed'});return values.get(...(['bad'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-nonspread-safe-pin',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-comma-unknown-key',
    source:
      "function frames(error:Error,key:string){return new Map<string,{stack?:string}>((void 0,[['bad',error],['safe',{stack:'fixed'}]])).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"bad")',
    refused: true,
  },
  {
    id: 'map-comma-bad-key',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>((void 0,[['bad',error],['safe',{stack:'fixed'}]])).get('bad')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weakmap-comma',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>((void 0,[[key,error]])).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-spread-comma',
    source:
      "function frames(error:Error){return [...new Map<string,{stack?:string}>((void 0,[['bad',error],['safe',{stack:'fixed'}]])).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-next-comma',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>((void 0,[['bad',error],['safe',{stack:'fixed'}]])).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-values-next-comma',
    source:
      "function frames(error:Error){return new Set<{stack?:string}>((void 0,[error,{stack:'fixed'}])).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-spread-comma',
    source:
      "function frames(error:Error){return [...new Set<{stack?:string}>((void 0,[error,{stack:'fixed'}]))][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-from-comma',
    source:
      "function frames(error:Error){return Array.from<{stack?:string}>((void 0,[error,{stack:'fixed'}]))[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'from-entries-comma',
    source:
      "function frames(error:Error){return Object.fromEntries<{stack?:string}>((void 0,[['k',error]])).k!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-call-entries',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['bad',e]];}function frames(error:Error,key:string){return new Map<string,{stack?:string}>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"bad")',
    refused: true,
  },
  {
    id: 'map-param-entries',
    source:
      "function frames(error:Error,key:string,entries:[string,{stack?:string}][]=[['bad',error]]){return new Map<string,{stack?:string}>(entries).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"bad")',
    refused: true,
  },
  {
    id: 'map-noisy-comma',
    source:
      "function frames(error:Error,key:string){const log:string[]=[];return new Map<string,{stack?:string}>((log.push('x'),[['bad',error]])).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"bad")',
    refused: true,
  },
  {
    id: 'map-annotated-call-entries',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['bad',e]];}function frames(error:Error,key:string){const values:Map<string,{stack?:string}>=new Map(make(error));return values.get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"bad")',
    refused: true,
  },
  {
    id: 'array-from-call',
    source:
      'function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){return Array.from<{stack?:string}>(list(error))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-call',
    source:
      'function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){return new Set<{stack?:string}>(list(error)).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-spread-call',
    source:
      'function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){return [...new Set<{stack?:string}>(list(error))][0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-spread-call',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['bad',e]];}function frames(error:Error){return [...new Map<string,{stack?:string}>(make(error)).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-next-call',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['bad',e]];}function frames(error:Error){return new Map<string,{stack?:string}>(make(error)).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'from-entries-call',
    source:
      "function pairs(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){return Object.fromEntries<{stack?:string}>(pairs(error)).k!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-titled-call-quiet',
    source:
      "function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;title:string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'set-titled-call-quiet',
    source:
      "function names():{stack?:string;title:string}[]{return [{stack:'fixed',title:'t'}];}function frames(error:Error){void error;return new Set<{stack?:string;title:string}>(names()).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'array-from-titled-call-quiet',
    source:
      "function names():{stack?:string;title:string}[]{return [{stack:'fixed',title:'t'}];}function frames(error:Error){void error;return Array.from<{stack?:string;title:string}>(names())[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'from-entries-titled-call-quiet',
    source:
      "function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error){void error;return Object.fromEntries<{stack?:string;title:string}>(titles()).k!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-quiet-comma-safe-quiet',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>((void 0,[['bad',error],['safe',{stack:'fixed'}]])).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-quiet-comma-data-quiet',
    source:
      "function frames(error:Error){void error;return new Set<{stack?:string}>((void 0,[{stack:'fixed'}])).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-spread-titled-call-quiet',
    source:
      "function names():{stack?:string;title:string}[]{return [{stack:'fixed',title:'t'}];}function frames(error:Error){void error;return [...new Set<{stack?:string;title:string}>(names())][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-titled-call-quiet',
    source:
      "function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error){void error;return [...new Map<string,{stack?:string;title:string}>(titles()).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-spread-plain',
    source:
      "function frames(error:Error){return [...new Map<string,{stack?:string}>([['k',error]]).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-safe-plain',
    source:
      "function frames(error:Error){return [...new Map<string,{stack?:string}>([['k',{stack:'fixed'}],['e',error]]).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-iter-tuple-path',
    source:
      "function pairsOf(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){return new Set<[string,{stack?:string}]>(pairsOf(error)).values().next().value![1]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-quiet-comma-index',
    source: 'function frames(error:Error){return (void 0,[error])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-from-member-call',
    source:
      'const holder={list(e:{stack?:string}):{stack?:string}[]{return [e];}};function frames(error:Error){return Array.from<{stack?:string}>(holder.list(error))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-spread-index-call',
    source:
      'function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error,i:number){return [...new Set<{stack?:string}>(list(error))][i]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    refused: true,
  },
  {
    id: 'set-literal-spread-call',
    source:
      'function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){return new Set<{stack?:string}>([...list(error)]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-to-string-property-retains-error',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,{stack?:string;toString:()=>string}>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'map-value-of-property-retains-error',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,{stack?:string;valueOf:()=>unknown}>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'map-to-string-titled-safe-pin',
    source:
      "function titles():[string,{stack?:string;title:string;toString:()=>string}][]{return [['k',{stack:'fixed',title:'t',toString:()=>'t'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;title:string;toString:()=>string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-parameter-property-class-quiet',
    source:
      "class Data{stack?:string;constructor(public title:string){}}function datas():[string,Data][]{const data=new Data('t');data.stack='fixed';return [['k',data]];}function frames(error:Error,key:string){void error;return new Map<string,Data>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-values-before-spread-quiet',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){return [{stack:'fixed'},...new Map<string,{stack?:string}>(make(error)).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-before-spread-saved-quiet',
    source:
      "function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){const values=[{stack:'fixed'},...new Set<{stack?:string}>(list(error))];return values[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'array-from-nested-call-retains-error',
    source:
      'function lists(e:{stack?:string}):{stack?:string}[][]{return [[e]];}function frames(error:Error){const groups=lists(error);return Array.from<{stack?:string}>(groups[0]!)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-from-nested-param-retains-error',
    source:
      'function frames(error:Error,groups:{stack?:string}[][]){void error;return Array.from<{stack?:string}>(groups[0]!)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),[[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'array-from-nested-titled-safe-pin',
    source:
      "function lists():{stack?:string;title:string}[][]{return [[{stack:'fixed',title:'t'}]];}function frames(error:Error){void error;const groups=lists();return Array.from<{stack?:string;title:string}>(groups[0]!)[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-generic-alias-titled-quiet',
    source:
      "type Data<T>=T;function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error,key:string){void error;return new Map<string,Data<{stack?:string;title:string}>>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-generic-alias-retains-error',
    source:
      "type Data<T>=T;function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,Data<{stack?:string}>>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'map-generic-default-titled-quiet',
    source:
      "type Data<T={stack?:string;title:string}>=T;function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error,key:string){void error;return new Map<string,Data>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-values-replaced-data-quiet',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values=new Map<string,{stack?:string}>(make(error));values.values=()=>[{stack:'fixed'}].values();return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-replaced-error-retains',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values=new Map<string,{stack?:string}>(make({stack:'fixed'}));values.values=()=>[error].values();return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-iterator-replaced-data-quiet',
    source:
      "function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){const values=new Set<{stack?:string}>(list(error));values[Symbol.iterator]=()=>[{stack:'fixed'}].values();return [...values][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-recomma-data-quiet',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string;title:string}>([['k',{stack:'fixed',title:'t'}]]);values.values=()=>[error].values() as never;return (values.values=()=>[{stack:'fixed',title:'t'}].values(),[...values.values()][0]!.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-restored-retains',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values=new Map<string,{stack?:string}>(make(error));values.values=()=>[{stack:'fixed'}].values();return (values.values=Map.prototype.values,[...values.values()][0]!.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-deferred-retains',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values=new Map<string,{stack?:string}>(make(error));values.values=()=>[{stack:'fixed'}].values();const read=()=>[...values.values()][0]!.stack;values.values=Map.prototype.values;return read();}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-quiet-comma-quiet',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values=new Map<string,{stack?:string}>(make(error));values.values=()=>[{stack:'fixed'}].values();return (void 0,[...values.values()][0]!.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-iterator-restored-retains',
    source:
      "function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){const values=new Set<{stack?:string}>(list(error));values[Symbol.iterator]=()=>[{stack:'fixed'}].values();return (values[Symbol.iterator]=Set.prototype[Symbol.iterator],[...values][0]!.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-let-reassigned-quiet',
    source:
      "function read(entries:{stack?:string}[]){let values=new Set(entries);values=new Set([{stack:'fixed'}]);return [...values][0]!.stack;}function frames(error:Error){return read([error]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-default-parameter-quiet',
    source:
      "function load():{stack?:string}[]{return [];}function read(values=new Set(load())){return [...values][0]!.stack;}function frames(error:Error){void error;return read(new Set([{stack:'fixed'}]));}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-const-alias-retains',
    source:
      'function read(entries:{stack?:string}[]){const values=new Set(entries);const alias=values;return [...alias][0]!.stack;}function frames(error:Error){return read([error]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-error-subclass-retains',
    source:
      'class HttpError extends Error{status=500;}function read(items:HttpError[]){return [...new Set<HttpError>(items)][0]!.stack;}function frames(error:Error){return read([error as HttpError]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-error-interface-retains',
    source:
      'interface Coded extends Error{code:number}function read(items:Coded[]){return [...new Set<Coded>(items)][0]!.stack;}function frames(error:Error){return read([error as Coded]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-imported-base-retains',
    source:
      "import {Failure} from '@/domain/failures';class HttpError extends Failure{status=500;}function read(items:HttpError[]){return [...new Set<HttpError>(items)][0]!.stack;}function frames(error:Error){return read([error as never]);}",
    invocation: 'frames(new Error("ours"))',
    beside: { 'domain/failures.ts': 'export class Failure extends Error{}' },
    refused: true,
  },
  {
    id: 'set-subclass-intersection-retains',
    source:
      'class HttpError extends Error{status=500;}function read(items:(HttpError&{code:number})[]){return [...new Set<HttpError&{code:number}>(items)][0]!.stack;}function frames(error:Error){return read([error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-error-intersection-retains',
    source:
      'function read(items:(Error&{status:number})[]){return [...new Set<Error&{status:number}>(items)][0]!.stack;}function frames(error:Error){return read([error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-plain-class-quiet',
    source:
      "class Row{status=500;stack?:string;}function read(items:Row[]){return [...new Set<Row>(items)][0]!.stack;}function frames(error:Error){void error;return read([{status:1,stack:'fixed'}]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-plain-base-class-quiet',
    source:
      "class Base{title='';}class Row extends Base{status=500;stack?:string;}function read(items:Row[]){return [...new Set<Row>(items)][0]!.stack;}function frames(error:Error){void error;return read([{title:'t',status:1,stack:'fixed'}]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-noop-retains',
    source:
      "function noop(){}function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);values.values=()=>[error].values() as never;noop();return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-block-retains',
    source:
      "function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);{values.values=()=>[error].values() as never;}return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-loop-retains',
    source:
      "function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);for(let i=0;i<1;i++)values.values=()=>[error].values() as never;return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-alias-retains',
    source:
      "function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);const alias=values;alias.values=()=>[error].values() as never;return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-defined-retains',
    source:
      "function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);Object.defineProperty(values,'values',{value:()=>[error].values()});return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-iterator-noop-retains',
    source:
      "function noop(){}function frames(error:Error){const values=new Set([{stack:'fixed'}]);values[Symbol.iterator]=()=>[error].values() as never;noop();return [...values][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-unreplaced-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map([['k',{stack:'fixed'}]]);return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-values-later-write-quiet',
    source:
      "function frames(error:Error){const values=new Map([['k',{stack:'fixed'}]]);const first=[...values.values()][0]!.stack;values.values=()=>[error].values() as never;return first;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'iface-bound-number-quiet',
    source:
      "interface Data<T>{stack?:string;name:T}function datas():[string,Data<number>][]{return [['k',{stack:'fixed',name:1}]];}function frames(error:Error,key:string){void error;return new Map<string,Data<number>>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'iface-bound-string-retains',
    source:
      "interface Data<T>{stack?:string;name:T}function read(entries:[string,Data<string>][],key:string){return new Map<string,Data<string>>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'class-bound-number-quiet',
    source:
      "class Box<T>{stack?:string;name!:T}function datas():[string,Box<number>][]{return [['k',{stack:'fixed',name:1}]];}function frames(error:Error,key:string){void error;return new Map<string,Box<number>>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'class-bound-string-retains',
    source:
      "class Box<T>{stack?:string;name!:T}function read(entries:[string,Box<string>][],key:string){return new Map<string,Box<string>>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'path-alias-titled-quiet',
    source:
      "type Row={inner:{stack?:string;title:string}};function rows():Row[]{return [{inner:{stack:'fixed',title:'t'}}];}function frames(error:Error){void error;return new Set<Row>(rows()).values().next().value!.inner.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'path-interface-titled-quiet',
    source:
      "interface Inner{stack?:string;title:string}interface Row{inner:Inner}function rows():Row[]{return [{inner:{stack:'fixed',title:'t'}}];}function frames(error:Error){void error;return new Set<Row>(rows()).values().next().value!.inner.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'path-alias-open-retains',
    source:
      'type Row={inner:{stack?:string}};function read(rows:Row[]){return new Set<Row>(rows).values().next().value!.inner.stack;}function frames(error:Error){return read([{inner:error}]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'name-template-prefix-quiet',
    source: `function datas():[string,{stack?:string;name:\`data:\${string}\`}][]{return [['k',{stack:'fixed',name:'data:x'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;name:\`data:\${string}\`}>(datas()).get(key)!.stack;}`,
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'name-template-open-retains',
    source: `function read(entries:[string,{stack?:string;name:\`\${string}\`}][],key:string){return new Map<string,{stack?:string;name:\`\${string}\`}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iface-merged-titled-quiet',
    source:
      "interface Data{stack?:string}interface Data{title:string}function datas():[string,Data][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error,key:string){void error;return new Map<string,Data>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'iface-merged-open-retains',
    source:
      "interface Data{stack?:string}interface Data{title?:string}function read(entries:[string,Data][],key:string){return new Map<string,Data>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-name-number-quiet',
    source:
      "function datas():[string,{stack?:string;name?:number}][]{return [['k',{stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;name?:number}>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'class-optional-name-number-quiet',
    source:
      "class Row{stack?:string;name?:number}function datas():[string,Row][]{return [['k',{stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,Row>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'optional-name-string-retains',
    source:
      "function read(entries:[string,{stack?:string;name?:string}][],key:string){return new Map<string,{stack?:string;name?:string}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-title-retains',
    source:
      "function read(entries:[string,{stack?:string;title?:number}][],key:string){return new Map<string,{stack?:string;title?:number}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'name-template-empty-span-retains',
    source: `function read(entries:[string,{stack?:string;name:\`\${string}\${''}\`}][],key:string){return new Map<string,{stack?:string;name:\`\${string}\${''}\`}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'name-template-nested-retains',
    source: `function read(entries:[string,{stack?:string;name:\`\${\`\${string}\`}\`}][],key:string){return new Map<string,{stack?:string;name:\`\${\`\${string}\`}\`}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error as never]],'k');}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'name-template-finite-quiet',
    source: `function datas():[string,{stack?:string;name:\`\${'a'|'b'}\`}][]{return [['k',{stack:'fixed',name:'a'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;name:\`\${'a'|'b'}\`}>(datas()).get(key)!.stack;}`,
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'cause-indexed-access-retains',
    source:
      "function read(entries:[string,{stack?:string;cause?:Error['cause']}][],key:string){return new Map<string,{stack?:string;cause?:Error['cause']}>(entries).get(key)!.stack;}function frames(error:Error){return read([['k',error]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'cause-number-quiet',
    source:
      "function datas():[string,{stack?:string;cause?:number}][]{return [['k',{stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;cause?:number}>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'class-base-shadowed-type-retains',
    source:
      'class Base<T>{stack?:string;name!:T}function frames(error:Error){type Base<T>={stack?:string;name:number;tag?:T};class Derived extends Base<string>{}function read(items:Derived[]){return [...new Set<Derived>(items)][0]!.stack;}return read([error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'class-base-number-quiet',
    source:
      "class Base<T>{stack?:string;name!:T}class Derived extends Base<number>{}function read(items:Derived[]){return [...new Set<Derived>(items)][0]!.stack;}function frames(error:Error){void error;return read([{stack:'fixed',name:1} as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'class-base-global-map-quiet',
    source:
      "class Derived extends Map<string,string>{stack?:string}function read(items:Derived[]){return [...new Set<Derived>(items)][0]!.stack;}function frames(error:Error){void error;const made=new Derived();made.stack='fixed';return read([made]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'class-own-untyped-member-retains',
    source:
      'class Base{inner!:{stack?:string;title:string}}class Derived extends Base{override inner=null as any;}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.inner.stack;}function frames(error:Error){return read([{inner:error} as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iface-own-getter-retains',
    source:
      'interface Base{inner:{stack?:string;title:string}}interface Derived extends Base{get inner():any}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.inner.stack;}function frames(error:Error){return read([{inner:error} as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iface-own-other-getter-quiet',
    source:
      "interface Base{inner:{stack?:string;title:string}}interface Derived extends Base{get other():string}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.inner.stack;}function frames(error:Error){void error;return read([{inner:{stack:'fixed',title:'t'},other:'o'} as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'class-override-generic-member-retains',
    source:
      'class Base<T>{name!:T;stack?:string}class Derived extends Base<number>{override name=null as any;}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.stack;}function frames(error:Error){return read([error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'class-generic-member-other-quiet',
    source:
      "class Base<T>{name!:T;stack?:string}class Derived extends Base<number>{other=1;}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.stack;}function frames(error:Error){void error;return read([{name:1,stack:'fixed',other:1} as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'iface-readonly-base-override-retains',
    source:
      'interface Base<T>{name:T;stack?:string}interface Derived extends Readonly<Base<number>>{name:any}function read(entries:[string,Derived][],key:string){return new Map<string,Derived>(entries).get(key)!.stack;}function frames(error:Error){return read([["k",error as never]],"k");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iface-readonly-base-quiet',
    source:
      "interface Base<T>{name:T;stack?:string}interface Derived extends Readonly<Base<number>>{}function read(entries:[string,Derived][],key:string){return new Map<string,Derived>(entries).get(key)!.stack;}function frames(error:Error){void error;return read([['k',{name:1,stack:'fixed'}]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'iface-cyclic-heritage-retains',
    source:
      'interface Failure extends Other{stack?:string}interface Other extends Failure{}function read(entries:[string,Failure][],key:string){return new Map<string,Failure>(entries).get(key)!.stack;}function frames(error:Error){return read([["k",error as never]],"k");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'class-merged-cyclic-heritage-retains',
    source:
      'interface Failure extends Other{stack?:string}class Failure{}interface Other extends Failure{}function read(entries:[string,Failure][],key:string){return new Map<string,Failure>(entries).get(key)!.stack;}function frames(error:Error){return read([["k",error as never]],"k");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iface-heritage-chain-quiet',
    source:
      "interface Failure extends Other{stack?:string}interface Other{name:number}function read(entries:[string,Failure][],key:string){return new Map<string,Failure>(entries).get(key)!.stack;}function frames(error:Error){void error;return read([['k',{name:1,stack:'fixed'}]],'k');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'class-base-member-quiet',
    source:
      "class Base{inner!:{stack?:string;title:string}}class Derived extends Base{}function read(items:Derived[]){return new Set<Derived>(items).values().next().value!.inner.stack;}function frames(error:Error){void error;return read([{inner:{stack:'fixed',title:'t'}} as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-to-string-number-quiet',
    source:
      "function datas():[string,{stack?:string;toString:number}][]{return [['k',{stack:'fixed',toString:1}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;toString:number}>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-value-of-literal-quiet',
    source:
      "function datas():[string,{stack?:string;valueOf:'v'}][]{return [['k',{stack:'fixed',valueOf:'v'}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;valueOf:'v'}>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-to-string-function-retains-error',
    source:
      "function make(e:{stack?:string}):[string,{stack?:string;toString:Function}][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,{stack?:string;toString:Function}>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'map-name-number-alias-quiet',
    source:
      "type N=number;function datas():[string,{stack?:string;name:N}][]{return [['k',{stack:'fixed',name:1}]];}function frames(error:Error,key:string){void error;return new Map<string,{stack?:string;name:N}>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-name-bound-number-quiet',
    source:
      "type Named<T>={stack?:string;name:T};function datas():[string,Named<number>][]{return [['k',{stack:'fixed',name:1}]];}function frames(error:Error,key:string){void error;return new Map<string,Named<number>>(datas()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'map-name-string-alias-retains-error',
    source:
      "type S=string;function make(e:{stack?:string;name:S}):[string,{stack?:string;name:S}][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,{stack?:string;name:S}>(make(error)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  // An iteration or spread reads the annotation's element or value type past a local alias.
  {
    id: 'set-alias-values-titled-call-quiet',
    source:
      "type Titled=Set<{stack?:string;title:string}>;function names():{stack?:string;title:string}[]{return [{stack:'fixed',title:'t'}];}function frames(error:Error){void error;const values:Titled=new Set(names());return values.values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-alias-values-call-retains',
    source:
      'type Loose=Set<{stack?:string}>;function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){const values:Loose=new Set(list(error));return values.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-generic-alias-spread-titled-quiet',
    source:
      "type Table<V>=Map<string,V>;function titles():[string,{stack?:string;title:string}][]{return [['k',{stack:'fixed',title:'t'}]];}function frames(error:Error){void error;const values:Table<{stack?:string;title:string}>=new Map(titles());return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-generic-alias-spread-retains',
    source:
      "type Table<V>=Map<string,V>;function make(e:{stack?:string}):[string,{stack?:string}][]{return [['k',e]];}function frames(error:Error){const values:Table<{stack?:string}>=new Map(make(error));return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-alias-spread-titled-call-quiet',
    source:
      "type Titled=Set<{stack?:string;title:string}>;function names():{stack?:string;title:string}[]{return [{stack:'fixed',title:'t'}];}function frames(error:Error){void error;const values:Titled=new Set(names());return [...values][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-alias-spread-call-retains',
    source:
      'type Loose=Set<{stack?:string}>;function list(e:{stack?:string}):{stack?:string}[]{return [e];}function frames(error:Error){const values:Loose=new Set(list(error));return [...values][0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // TypeScript's checker reads mapped, conditional and utility types, `typeof`, intrinsic string
  // types and symbol keys; a weak type and a string index an Error's members fit still admit one.
  {
    id: 'checker-mapped-quiet',
    source:
      "function titles():[string,{[K in 'title'|'stack']:string}][]{return [['k',{title:'t',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{[K in 'title'|'stack']:string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-conditional-quiet',
    source:
      "function titles():[string,(string extends string?{title:string;stack?:string}:unknown)][]{return [['k',{title:'t',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,(string extends string?{title:string;stack?:string}:unknown)>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-typeof-quiet',
    source:
      "const sample={title:'t',stack:'fixed'};function titles():[string,typeof sample][]{return [['k',sample]];}function frames(error:Error,key:string){void error;return new Map<string,typeof sample>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-awaited-quiet',
    source:
      "function titles():[string,Awaited<Promise<{title:string;stack?:string}>>][]{return [['k',{title:'t',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,Awaited<Promise<{title:string;stack?:string}>>>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-return-type-quiet',
    source:
      "function titles():[string,ReturnType<()=>{title:string;stack?:string}>][]{return [['k',{title:'t',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,ReturnType<()=>{title:string;stack?:string}>>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-lowercase-name-quiet',
    source:
      "function titles():[string,{name:Lowercase<'X'>;stack?:string}][]{return [['k',{name:'x' as const,stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{name:Lowercase<'X'>;stack?:string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-uppercase-name-quiet',
    source:
      "function titles():[string,{name:Uppercase<string>;stack?:string}][]{return [['k',{name:'X',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{name:Uppercase<string>;stack?:string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-omit-name-quiet',
    source:
      "function titles():[string,Omit<Error,'name'>&{name:number}][]{return [['k',{name:1,message:'m',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,Omit<Error,'name'>&{name:number}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-symbol-member-quiet',
    source:
      "function titles():[string,{[Symbol.iterator]():Iterator<number>;stack?:string}][]{return [['k',{[Symbol.iterator]:()=>[1].values(),stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{[Symbol.iterator]():Iterator<number>;stack?:string}>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-record-number-quiet',
    source:
      "function titles():[string,Record<string,number>][]{return [['k',{stack:1}]];}function frames(error:Error,key:string){void error;return new Map<string,Record<string,number>>(titles()).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-weak-retains',
    source:
      "function make(e:Partial<{title:string;stack:string}>):[string,Partial<{title:string;stack:string}>][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,Partial<{title:string;stack:string}>>(make(error as never)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'checker-record-unknown-retains',
    source:
      "function make(e:Record<string,unknown>):[string,Record<string,unknown>][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,Record<string,unknown>>(make(error as never)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  // A union of Error subclasses that share a base, a type the checker defers until its parameters
  // are known, and a base an ambient declaration gives beside one that resolves each admit one.
  {
    id: 'checker-union-subclass-intersection-retains',
    source:
      "class AppError extends Error{code='app';}class HttpError extends AppError{status=500;}type Failure=(AppError|HttpError)&{retryable?:boolean};function read(items:Failure[]){return [...new Set<Failure>(items)][0]!.stack;}function frames(error:Error,key:string){void key;return read([error as never]);}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'checker-generic-conditional-retains',
    source:
      'type Item<T>=T extends string?Error:{title:string;stack?:string};function read<T>(items:Item<T>[]){return [...new Set<Item<T>>(items)][0]!.stack;}function frames(error:Error,key:string){void key;return read<string>([error]);}',
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'checker-ambient-base-retains',
    source:
      "interface Known{title:string}interface Failure extends Known,DomainError{}function make(e:Failure):[string,Failure][]{return [['k',e]];}function frames(error:Error,key:string){return new Map<string,Failure>(make(error as never)).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"),"k")',
    beside: {
      'app/api/domain-errors.d.ts': 'declare class DomainError extends Error { code: string }',
    },
    refused: true,
  },
  // A member path skips a union's `null` and `undefined`, whose member read throws, and a Set
  // spread through an unannotated alias reads the annotation of the name it aliases.
  {
    id: 'checker-nullish-arm-path-quiet',
    source:
      "type Row={inner:{title:string;stack?:string}};function read(rows:(Row|undefined)[]){return new Set<Row|undefined>(rows).values().next().value!.inner.stack;}function frames(error:Error,key:string){void error;void key;return read([{inner:{title:'t',stack:'fixed'}}]);}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-nullish-arm-path-retains',
    source:
      'type Row={inner:{stack?:string}};function read(rows:(Row|undefined)[]){return new Set<Row|undefined>(rows).values().next().value!.inner.stack;}function frames(error:Error,key:string){void key;return read([{inner:error}]);}',
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
  {
    id: 'checker-set-alias-annotation-quiet',
    source:
      "function read(rows:{title:string;stack?:string}[]){const s:Set<{title:string;stack?:string}>=new Set(rows);const alias=s;return [...alias][0]!.stack;}function frames(error:Error,key:string){void error;void key;return read([{title:'t',stack:'fixed'}]);}",
    invocation: 'frames(new Error("ours"),"k")',
    refused: false,
  },
  {
    id: 'checker-set-alias-annotation-retains',
    source:
      'function read(rows:{stack?:string}[]){const s:Set<{stack?:string}>=new Set(rows);const alias=s;return [...alias][0]!.stack;}function frames(error:Error,key:string){void key;return read([error]);}',
    invocation: 'frames(new Error("ours"),"k")',
    refused: true,
  },
];

describe('finite Map entry and argument readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-map-get.ts', source);
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

describe('shared finite Map entry and argument results', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, beside }) => {
    const app = await application({
      ...beside,
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
