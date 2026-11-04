import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-selected initializer evaluates the discarded operation on the authority. */
const fixture = stateFixture('borrowed-consumers', 'BorrowedConsumers');

/** Native consumption checks the selected receiver, iterator and implicit constructor. */
describe('written borrowed and iterator consumers', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "Array.prototype.reduce.call('',()=>0)",
    "Array.prototype.reduceRight.call('',()=>0)",
    'Array.prototype.reduce.call({length:0},()=>0)',
    'Array.prototype.reduceRight.call({length:-1},()=>0)',
    'Array.prototype.reduce.call({length:0.5},()=>0)',
    "Reflect.apply(Array.prototype.reduce,'',[()=>0])",
    'Array.prototype.reduce.apply({length:0},[()=>0])',
    'Uint8Array.from({get [Symbol.iterator](){throw new Error("bad");}})',
    'BigInt64Array.from({get [Symbol.iterator](){throw new Error("bad");}})',
    'Float16Array.from({get [Symbol.iterator](){throw new Error("bad");}})',
    '(()=>{const Bytes=Uint8Array;return Bytes.from({get [Symbol.iterator](){throw new Error("bad");}});})()',
    'Array.from({[Symbol.iterator]:1} as never)',
    'Array.from({[Symbol.iterator]:false} as never)',
    'Array.from({[Symbol.iterator]:"bad"} as never)',
    'Array.from({[Symbol.iterator]:{}} as never)',
    'Array.from({[Symbol.iterator]:[]} as never)',
    'new Set({[Symbol.iterator]:1} as never)',
    'Object.fromEntries({[Symbol.iterator]:1} as never)',
    'Iterator.from({[Symbol.iterator]:1} as never)',
    'Uint8Array.from({[Symbol.iterator]:1} as never)',
    'new(class extends(null as any){})()',
    '(()=>{const Empty=class extends(null as any){};return new Empty();})()',
    '(()=>{class Empty extends(null as any){}return new Empty();})()',
    '(()=>{const base=null;return new(class extends(base as any){})();})()',
  ])('refuses guaranteed native consumption failure: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "Array.prototype.reduce.call('',()=>0,undefined)",
    "Array.prototype.reduce.call('x',()=>{throw new Error('unused');})",
    'Array.prototype.reduce.call({length:1,0:first},()=>0)',
    'Array.prototype.reduce.call({length:0},()=>0,0)',
    '(()=>{const value:any={length:0};value.length=1;value[0]=first;return Array.prototype.reduce.call(value,()=>0);})()',
    '(()=>{try{Array.prototype.reduce.call({length:0},()=>0);}catch{}return first;})()',
    "false&&Array.prototype.reduce.call('',()=>0)",
    "()=>Array.prototype.reduce.call('',()=>0)",
    'Uint8Array.from({*[Symbol.iterator](){yield 1;}})',
    'BigInt64Array.from({*[Symbol.iterator](){yield 1n;}})',
    'Uint8Array.from({get [Symbol.iterator](){return function*(){yield 1;};}})',
    '(()=>{try{Uint8Array.from({get [Symbol.iterator](){throw new Error("caught");}});}catch{}return first;})()',
    '()=>Uint8Array.from({get [Symbol.iterator](){throw new Error("deferred");}})',
    'Array.from({[Symbol.iterator]:null,length:1})',
    'Uint8Array.from({[Symbol.iterator]:undefined,length:1})',
    'Iterator.from({[Symbol.iterator]:null,next(){return{done:true};}})',
    'Array.from({[Symbol.iterator]:()=>({next(){return{done:true};}})})',
    'Array.from({[Symbol.iterator]:1,[Symbol.iterator]:function*(){yield 1;}})',
    '(()=>{const value:any={[Symbol.iterator]:1};value[Symbol.iterator]=function*(){yield 1;};return Array.from(value);})()',
    '(()=>{try{Array.from({[Symbol.iterator]:1} as never);}catch{}return first;})()',
    'false&&Array.from({[Symbol.iterator]:1} as never)',
    'new(class extends(null as any){constructor(){return {};}})()',
    '(class extends(null as any){})',
    '(()=>{try{return new(class extends(null as any){})();}catch{return first;}})()',
    '()=>new(class extends(null as any){})()',
    '(()=>{const Empty=class extends(null as any){};Object.setPrototypeOf(Empty,class{});return new Empty();})()',
    '(()=>{class Empty extends(null as any){}Object.setPrototypeOf(Empty,class{});return new Empty();})()',
    'new(class extends(null as any){static{Object.setPrototypeOf(this,class{});}})()',
    'new(class extends(class{}){})()',
    'Uint8Array.from(first as never)',
    '(()=>{const Bytes=Uint8Array,saved=Bytes.from;try{Bytes.from=(()=>[]) as never;return Bytes.from({get [Symbol.iterator](){throw new Error("unused");}});}finally{Bytes.from=saved;}})()',
    '(()=>{const saved=Array.prototype.reduce;try{return(Array.prototype.reduce=(()=>0) as never,Array.prototype.reduce.call("",()=>0));}finally{Array.prototype.reduce=saved;}})()',
    '(()=>{const saved=Array.prototype.reduce;try{Array.prototype.reduce=(()=>0) as never;return Array.prototype.reduce.call("",()=>0);}finally{Array.prototype.reduce=saved;}})()',
    '(()=>{const saved=Uint8Array.from;try{Uint8Array.from=(()=>[]) as never;return Uint8Array.from({get [Symbol.iterator](){throw new Error("unused");}});}finally{Uint8Array.from=saved;}})()',
    '(()=>{const saved=Array.from;try{Array.from=(()=>[]) as never;return Array.from({[Symbol.iterator]:1} as never);}finally{Array.from=saved;}})()',
  ])('keeps initial, overwritten, deferred and handled consumption: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
