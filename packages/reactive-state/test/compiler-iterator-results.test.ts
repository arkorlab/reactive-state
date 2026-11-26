import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-selected branch makes the authority evaluate the iterator before the trailing JSON text. */
const fixture = stateFixture('iterator-results', 'IteratorResults');

/** Both iterator acquisition and every requested synchronous result require an object. */
describe('source-written iterator protocol results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.from({[Symbol.iterator](){return 1 as never;}})',
    'Array.from({[Symbol.iterator](){return null as never;}})',
    '[...{[Symbol.iterator](){return false as never;}}]',
    'new Set({[Symbol.iterator](){return "bad" as never;}})',
    'Iterator.from({[Symbol.iterator](){return 1 as never;}})',
    '(()=>{const []={[Symbol.iterator](){return 1 as never;}};return 0;})()',
    'Array.from({[Symbol.iterator](){}} as never)',
    '(()=>{const iterator=()=>1;return Array.from({[Symbol.iterator]:iterator} as never);})()',
    'Array.from({[Symbol.iterator](){return{next(){return 1 as never;}};}})',
    '[...{[Symbol.iterator](){return{next(){return null as never;}};}}]',
    '(()=>{const [item]={[Symbol.iterator](){return{next(){return undefined as never;}};}};return item;})()',
    '(()=>{for(const item of {[Symbol.iterator](){return{next(){return false as never;}};}}){void item;break;}return 0;})()',
  ])('refuses a primitive iterator or consumed result: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.from({[Symbol.iterator](){return{next(){return{done:true};}};}})',
    'Array.from({[Symbol.iterator](){return{next(){return 1;},next(){return{done:true};}};}})',
    'Iterator.from({[Symbol.iterator](){return{next(){return 1 as never;}};}})',
    '(()=>{const []={[Symbol.iterator](){return{next(){return 1 as never;}};}};return 0;})()',
    '(()=>{for(const item of {[Symbol.iterator](){return{async next(){return 1;}};}} as never){void item;break;}return 0;})()',
    '(()=>{for(const item of {[Symbol.iterator](){return{*next(){throw new Error("deferred");}};}} as never){void item;break;}return 0;})()',
    'Array.from({*[Symbol.iterator](){yield 0;}})',
    'Array.from({get [Symbol.iterator](){return()=>({next(){return{done:true};}});}})',
    '(()=>{const answer=1;return Array.from({[Symbol.iterator](answer={next(){return{done:true};}} as never){return answer;}} as never);})()',
    '(()=>{const iterator=()=>0;iterator.next=()=>({done:true});return Array.from({[Symbol.iterator](){return iterator;}} as never);})()',
    'Array.from({[Symbol.iterator](){return{next(){return first===""?{done:true}:1 as never;}};}})',
    '(()=>{try{Array.from({[Symbol.iterator](){return 1 as never;}});}catch{}return 0;})()',
    '(()=>Array.from({[Symbol.iterator](){return 1 as never;}}))',
    'false&&Array.from({[Symbol.iterator](){return 1 as never;}})',
  ])('keeps object, unconsumed, deferred, unknown and caught results: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
