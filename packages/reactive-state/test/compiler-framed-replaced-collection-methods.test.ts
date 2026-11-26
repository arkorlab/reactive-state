import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A native Map's, Set's or WeakMap's method counts as native only where nothing may replace it on
 * the prototype or the instance: written directly, through an alias or the global object, under
 * a key the compile cannot read, by a native writer, or by giving an instance another prototype.
 */
const CASES = [
  {
    id: 'proto-get-assigned',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {get:unknown}).get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-defined',
    source:
      "function frames(error:Error){Object.defineProperty(Map.prototype,'get',{value:()=>error,configurable:true,writable:true});return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-defined-many',
    source:
      "function frames(error:Error){Object.defineProperties(Map.prototype,{get:{value:()=>error,configurable:true,writable:true}});return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-reflect-set',
    source:
      "function frames(error:Error){Reflect.set(Map.prototype,'get',()=>error);return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-reflect-define',
    source:
      "function frames(error:Error){Reflect.defineProperty(Map.prototype,'get',{value:()=>error,configurable:true,writable:true});return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-object-assign',
    source:
      "function frames(error:Error){Object.assign(Map.prototype,{get:()=>error});return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-alias',
    source:
      "function frames(error:Error){const proto=Map.prototype as unknown as {get:unknown};proto.get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-global-alias',
    source:
      "function frames(error:Error){(globalThis as unknown as {Map:{prototype:{get:unknown}}}).Map.prototype.get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-computed',
    source:
      "function pick():string{return 'get';}function frames(error:Error){(Map.prototype as unknown as Record<string,unknown>)[pick()]=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-handed',
    source:
      "function patch(ctor:{prototype:object},error:Error){(ctor.prototype as {get?:unknown}).get=()=>error;}function frames(error:Error){patch(Map,error);return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-instance-proto',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);Object.setPrototypeOf(values,{get:()=>error});return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-dunder-proto',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);(values as unknown as {__proto__:unknown}).__proto__={get:()=>error};return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-weakmap-get',
    source:
      "function frames(error:Error){(WeakMap.prototype as unknown as {get:unknown}).get=()=>error;const key={};return new WeakMap<object,{stack?:string}>([[key,{stack:'fixed'}]]).get(key)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-values-spread',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {values:unknown}).values=()=>[error].values();return [...new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-values-next',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {values:unknown}).values=()=>[error].values();return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-set-iterator-spread',
    source:
      "function frames(error:Error){(Set.prototype as unknown as Record<symbol,unknown>)[Symbol.iterator]=()=>[error].values();return [...new Set<{stack?:string}>([{stack:'fixed'}])][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-foreach-callback',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {forEach:unknown}).forEach=function(cb:(v:unknown)=>void){cb(error);};let found:string|undefined;new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).forEach((v)=>{found=v.stack;});return found;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'elsewhere-proto-set-keeps-error',
    source:
      "class TaggedError extends Error{tag='x';}function unused(){return Object.getPrototypeOf({});}function frames(error:Error){const tagged=error as TaggedError;return [...new Set<{tag:string;stack?:string}>([tagged])][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'elsewhere-proto-map-keeps-error',
    source:
      "class TaggedError extends Error{tag='x';}function unused(){return Object.getPrototypeOf({});}function frames(error:Error){const tagged=error as TaggedError;return [...new Map<string,{tag:string;stack?:string}>([['k',tagged]]).values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-get-shadows-proto-quiet',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {get:unknown}).get=()=>error;const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(values as unknown as {get:unknown}).get=()=>({stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'handed-local-map-retains',
    source:
      "function swap(map:{get?:unknown},error:unknown){map.get=()=>error;}function frames(error:Error){const values=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);swap(values,error);return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'handed-local-ctor-retains',
    source:
      "function patchMaps(ctor:{prototype:object},error:unknown){(ctor.prototype as {get?:unknown}).get=()=>error;}function frames(error:Error){patchMaps(Map,error);return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'handed-import-map-retains',
    source:
      "import {swap} from '@/domain/swaps';function frames(error:Error){const values=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);swap(values,error);return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    beside: {
      'domain/swaps.ts':
        'export function swap(map:{get?:unknown},error:unknown){map.get=()=>error;}',
    },
    refused: true,
  },
  {
    id: 'handed-import-ctor-retains',
    source:
      "import {patchMaps} from '@/domain/patches';function frames(error:Error){patchMaps(Map,error);return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    beside: {
      'domain/patches.ts':
        'export function patchMaps(ctor:{prototype:object},error:unknown){(ctor.prototype as {get?:unknown}).get=()=>error;}',
    },
    refused: true,
  },
  {
    id: 'handed-local-map-titled-quiet',
    source:
      "function keep(_v:unknown){}function frames(error:Error){void error;const values=new Map<string,{stack?:string;title:string}>([['safe',{stack:'fixed',title:'t'}]]);keep(values);return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-set-stores-error',
    source:
      "function frames(error:Error){const original=Map.prototype.set;(Map.prototype as unknown as {set:unknown}).set=function(this:Map<string,unknown>,key:string){return original.call(this,key,error);};const values=new Map<string,{stack?:string}>();values.set('safe',{stack:'fixed'});return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-add-stores-error',
    source:
      "function frames(error:Error){const original=Set.prototype.add;(Set.prototype as unknown as {add:unknown}).add=function(this:Set<unknown>){return original.call(this,error);};const values=new Set<{stack?:string}>();values.add({stack:'fixed'});return [...values][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-set-chain-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>();values.set('safe',{stack:'fixed'});return values.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unknown-get-error-hidden',
    source:
      'function frames(error:Error){const values=new Map<string,{message:string}>([["x",{message:"fixed"}]]);const methods=[function(){return error;}];values.get=methods[0]!;return values.get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-clear-own-get-quiet',
    source:
      "function frames(error:Error){void error;(Map.prototype as unknown as {clear:unknown}).clear=function(){};const values=new Map<string,{stack?:string}>();(values as unknown as {get:unknown}).get=()=>({stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-get-own-conditional-retains',
    source:
      "function frames(error:Error,flag:boolean){(Map.prototype as unknown as {get:unknown}).get=()=>error;const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);if(flag)(values as unknown as {get:unknown}).get=()=>({stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'proto-clear-rewrites-get-retains',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {clear:unknown}).clear=function(this:{get:unknown}){this.get=()=>error;};const values=new Map<string,{stack?:string}>();(values as unknown as {get:unknown}).get=()=>({stack:'fixed'});values.clear();return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-set-hands-map-retains',
    source:
      "function store(map:Map<string,unknown>,error:Error){Map.prototype.set.call(map,'x',error);}function frames(error:Error){const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(values as unknown as {set:unknown}).set=function(key:string){void key;store(values,error);};values.set('y',{stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-set-hands-this-retains',
    source:
      "function store(map:Map<string,unknown>,error:Error){Map.prototype.set.call(map,'x',error);}function frames(error:Error){const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(values as unknown as {set:unknown}).set=function(this:Map<string,unknown>,key:string){void key;store(this,error);};values.set('y',{stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-set-reads-map-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(values as unknown as {set:unknown}).set=function(key:string){void key;void values.size;};values.set('y',{stack:'fixed'});return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-set-returned-escape-retains',
    source:
      "function store(map:unknown,error:Error){Map.prototype.set.call(map as Map<string,unknown>,'x',error);}function frames(error:Error){const values=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(values as unknown as {set:unknown}).set=function(this:unknown){return this;};store(values.set('y',{stack:'fixed'}),error);return values.get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-unreplaced-quiet',
    source:
      "function frames(error:Error){void error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-other-member-quiet',
    source:
      "function frames(error:Error){(Map.prototype as unknown as {describe:unknown}).describe=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-local-class-quiet',
    source:
      "class Box{get(){return {stack:'fixed'};}}function frames(error:Error){(Box.prototype as unknown as {get:unknown}).get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-array-get-quiet',
    source:
      "function frames(error:Error){(Array.prototype as unknown as {get:unknown}).get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proto-compared-quiet',
    source:
      "function frames(error:Error){void error;const same=typeof Map==='function'&&Map.prototype.get===Map.prototype.get;return same?new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack:'';}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  // A class's `extends` expression runs as the class is declared: what it writes is written.
  {
    id: 'proto-get-heritage',
    source:
      "function frames(error:Error){class Wrapped extends ((Map.prototype as unknown as {get:unknown}).get=()=>error,Map){}void Wrapped;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-get-heritage-read',
    source:
      "function frames(error:Error){void error;class Base{}class Wrapped extends ((void Map.prototype.get),Base){}void Wrapped;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'instance-get-heritage',
    source:
      "function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);class Wrapped extends ((m as unknown as {get:unknown}).get=()=>error,Map){}void Wrapped;return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-get-heritage-handed',
    source:
      "function swap(x:{get:unknown},e:Error){x.get=()=>e;}function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);class Wrapped extends (swap(m as never,error),Map){}void Wrapped;return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // What `__proto__` reads off an instance is its prototype, a collection's among them.
  {
    id: 'instance-proto-get-assigned',
    source:
      "function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);((m as unknown as {__proto__:{get:unknown}}).__proto__).get=()=>error;return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-proto-bracket-assigned',
    source:
      "function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);((m as unknown as Record<string,{get:unknown}>)['__proto__']).get=()=>error;return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-proto-alias-assigned',
    source:
      "function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);const proto=(m as unknown as {__proto__:{get:unknown}}).__proto__;proto.get=()=>error;return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-proto-handed',
    source:
      "function swap(p:{get:unknown},e:Error){p.get=()=>e;}function frames(error:Error){const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);swap((m as unknown as {__proto__:{get:unknown}}).__proto__,error);return m.get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-proto-compared',
    source:
      "function frames(error:Error){void error;const m=new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]);const same=(m as unknown as {__proto__:unknown}).__proto__===Map.prototype;return same?m.get('safe')!.stack:'';}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  // A name a prototype is assigned to other than as a `const` may hold any prototype.
  {
    id: 'proto-alias-let-reassigned',
    source:
      "function frames(error:Error){let p=Map.prototype as unknown as {get:unknown};p.get=()=>error;p=Set.prototype as unknown as {get:unknown};void p;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proto-alias-const-other',
    source:
      "function frames(error:Error){const p=Set.prototype as unknown as {get:unknown};p.get=()=>error;return new Map<string,{stack?:string}>([['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  // A Map's declared value type is read past local aliases to the `Map<K, V>` they name.
  {
    id: 'alias-handed-titled-quiet',
    source:
      "type Safe=Map<string,{tag:string;stack?:string}>;function read(values:Safe){Object.keys(values);return values.get('x')?.stack;}function frames(error:Error){void error;return read(new Map([['x',{tag:'t',stack:'fixed'}]]));}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'alias-handed-swap-retains',
    source:
      "type Loose=Map<string,{stack?:string}>;function swap(map:{get?:unknown},error:unknown){map.get=()=>error;}function read(values:Loose,error:Error){swap(values,error);return values.get('x')?.stack;}function frames(error:Error){return read(new Map([['x',{stack:'fixed'}]]),error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-alias-handed-titled-quiet',
    source:
      "type Values<T>=Map<string,T>;function read(values:Values<{tag:string;stack?:string}>){Object.keys(values);return values.get('x')?.stack;}function frames(error:Error){void error;return read(new Map([['x',{tag:'t',stack:'fixed'}]]));}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'alias-unread-entries-titled-quiet',
    source:
      "type Safe=Map<string,{tag:string;stack?:string}>;function read(entries:[string,{tag:string;stack?:string}][]){const values:Safe=new Map(entries);return values.get('x')?.stack;}function frames(error:Error){void error;return read([['x',{tag:'t',stack:'fixed'}]]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  // Through a set that may answer another receiver: an Error any installed get answers; the Map's
  // own get where the set may answer the Map itself; else the declared value type, or anything.
  {
    id: 'chain-fresh-set-own-get-titled-quiet',
    source:
      "function frames(error:Error){const m=new Map<string,{tag:string;stack?:string}>();(m as unknown as {get:unknown}).get=()=>error;(m as unknown as {set:unknown}).set=()=>new Map([['x',{tag:'t',stack:'fixed'}]]);return m.set('y',{tag:'t'}).get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'chain-fresh-set-error-retains',
    source:
      "function frames(error:Error){const m=new Map<string,{stack?:string}>();(m as unknown as {get:unknown}).get=()=>({stack:'fixed'});(m as unknown as {set:unknown}).set=()=>new Map([['x',error]]);return m.set('y',{}).get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chain-fresh-set-proto-get-retains',
    source:
      "function frames(error:Error){const m=new Map<string,{tag:string;stack?:string}>();(Map.prototype as unknown as {get:unknown}).get=()=>error;(m as unknown as {set:unknown}).set=()=>new Map([['x',{tag:'t',stack:'fixed'}]]);return m.set('y',{tag:'t'}).get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chain-set-this-own-get-retains',
    source:
      "function frames(error:Error){const m=new Map<string,{tag:string;stack?:string}>();(m as unknown as {get:unknown}).get=()=>error;(m as unknown as {set:unknown}).set=function(this:unknown){return this;};return m.set('y',{tag:'t'}).get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chain-open-set-other-map-retains',
    source:
      "function frames(error:Error){const other=new Map<string,{stack?:string}>([['x',error]]);const m=new Map<string,{stack?:string}>([['x',{stack:'fixed'}]]);(m as unknown as {set:unknown}).set=function(this:unknown){void this;return other;};return m.set('y',{stack:'fixed'}).get('x')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // A forEach's callback reads the annotation's element type past a local alias.
  {
    id: 'alias-foreach-cleared-titled-quiet',
    source:
      "type Safe=Set<{tag:string;stack?:string}>;function read(values:Safe){let found:string|undefined;values.forEach((value)=>{found=value.stack;});return found;}function frames(error:Error){void error;(Set.prototype as unknown as {clear:unknown}).clear=function(){};return read(new Set([{tag:'t',stack:'fixed'}]));}",
    invocation: 'frames(new Error("ours"))',
    // Refused here: the file writes a member of `Set.prototype`, which may give a collection's
    // `forEach` another body, so what its callback is given is not read as the annotation's element.
    refused: true,
  },
  {
    id: 'alias-foreach-replaced-retains',
    source:
      "type Loose=Set<{stack?:string}>;function read(values:Loose){let found:string|undefined;values.forEach((value)=>{found=value.stack;});return found;}function frames(error:Error){(Set.prototype as unknown as {forEach:unknown}).forEach=function(cb:(v:unknown)=>void){cb(error);};return read(new Set([{stack:'fixed'}]));}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('replaced collection method readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'replaced-collection-methods.ts', source);
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

describe('shared replaced collection method results', () => {
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
