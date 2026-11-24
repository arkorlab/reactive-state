import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the selected branch before the trailing JSON text reaches the state. */
const fixture = stateFixture('iterator-close', 'IteratorClose');

/** Finite destructuring closes an iterator only while its requested steps leave it open. */
describe('source-written iterator close failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const []={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("close");}};}};return 0;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("close");}};}};return item;})()',
    '(()=>{const [,]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("close");}};}};return 0;})()',
    '(()=>{const [left,right]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("close");}};}};return left+right;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},get return(){throw new Error("close");}};}};return item;})()',
    '(()=>{const key="return";const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},[key](){throw new Error("close");}};}};return item;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},get return(){throw new Error("close");},set return(_value:unknown){}};}};return item;})()',
    '(()=>{const finish=()=>{throw new Error("close");};const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return:finish};}};return item;})()',
    '(()=>{const []={[Symbol.iterator](){return{next(){return{done:true};},return(){throw new Error("close");}};}};return 0;})()',
  ])('refuses a close hook necessarily called by destructuring: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:true};},return(){throw new Error("unused");}};}};return item;})()',
    '(()=>{const [...items]={[Symbol.iterator](){let done=false;return{next(){if(done)return{done:true};done=true;return{done:false,value:1};},return(){throw new Error("unused");}};}};return items;})()',
    'Array.from({[Symbol.iterator](){return{next(){return{done:true};},return(){throw new Error("unused");}};}})',
    'Iterator.from({[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("unused");}};}})',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){return{};}};}};return item;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("overwritten");},return(){return{};}};}};return item;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},set return(_value:unknown){}};}};return item;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return first===""?{done:true}:{done:false,value:1};},return(){throw new Error("unknown");}};}};return item;})()',
    '(()=>{const iterator={next(){return{done:false,value:undefined};},return(){throw new Error("repaired");}};const [item=(iterator.return=(()=>({})) as never,0)]={[Symbol.iterator](){return iterator;}};return item;})()',
    '(()=>{const original=decodeURIComponent;try{const [item]={[Symbol.iterator](){return{next(){return{done:false,get value(){globalThis.decodeURIComponent=()=>"ok";return 1;}};},return(){return{value:decodeURIComponent("%")};}};}};return item;}finally{globalThis.decodeURIComponent=original;}})()',
    '(()=>{const []={[Symbol.iterator](){return{get next(){this.return=(()=>({})) as never;return()=>({done:true});},return(){throw new Error("repaired");}};}};return 0;})()',
    '(()=>{const []={[Symbol.iterator](){return{__proto__:{get next(){this.return=()=>({});return()=>({done:true});}},return(){throw new Error("repaired");}};}} as never;return 0;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},async return(){return 0;}};}} as never;return item;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},*return(){throw new Error("deferred");}};}} as never;return item;})()',
    '(()=>{try{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("caught");}};}};void item;}catch{}return 0;})()',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("deferred");}};}};return item;})',
    'false&&(()=>{const [item]={[Symbol.iterator](){return{next(){return{done:false,value:1};},return(){throw new Error("skipped");}};}};return item;})()',
  ])(
    'keeps completed, exhausted, unused, repaired and deferred close hooks: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
