import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The borrowed call completes before its discarded result yields an authority-started JSON value. */
const fixture = stateFixture('borrowed-array-getters', 'BorrowedArrayGetters');

/** Borrowed native array operations read length and a selected index before returning. */
describe('source-written borrowed array getters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.prototype.join.call({length:1,get 0(){throw new Error("index");}})',
    'Array.prototype.map.call({length:1,get 0(){throw new Error("index");}},value=>value)',
    'Array.prototype.join.apply({length:1,get 0(){throw new Error("index");}},[])',
    'Reflect.apply(Array.prototype.join,{length:1,get 0(){throw new Error("index");}},[])',
    '(()=>{const receiver={length:1,get 0(){throw new Error("index");}};return Array.prototype.join.call(receiver);})()',
    'Array.prototype.join.call({get length(){throw new Error("length");},0:first})',
    'Array.prototype.join.call({length:1,get 0(){throw new Error("index");},set 0(_value:unknown){}})',
    '(()=>{const key=0;return Array.prototype.join.call({length:1,get [key](){throw new Error("index");}});})()',
    'Array.prototype.join.call({length:1,0:first,get 0(){throw new Error("final index");}})',
    'Reflect.apply(Array.prototype.map,{length:1,get 0(){throw new Error("index");}},[value=>value])',
  ])('refuses a necessarily consumed throwing getter: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.prototype.join.call({length:0,get 0(){throw new Error("unused");}})',
    'Array.prototype.map.call({length:1,get 1(){throw new Error("outside");}},value=>value)',
    'Array.prototype.join.call({length:1,get 0(){throw new Error("overwritten");},0:first})',
    'Array.prototype.join.call({length:1,0:first,get other(){throw new Error("unused");}})',
    'Array.prototype.join.call({length:1,get 0(){return first;}})',
    'Array.prototype.join.call({length:1,set 0(_value:unknown){throw new Error("unused");}})',
    '(()=>{const receiver={get length(){Object.defineProperty(receiver,"0",{value:first});return 1;},get 0(){throw new Error("repaired");}};return Array.prototype.join.call(receiver);})()',
    '(()=>{const receiver={length:1,get 0(){throw new Error("repaired");}};return Array.prototype.join.call(receiver,{toString(){Object.defineProperty(receiver,"0",{value:first});return "";}} as never);})()',
    '(()=>{const receiver={length:1,get 0(){throw new Error("repaired");}};function repair(){Object.defineProperty(receiver,"0",{value:first});return 0;}return(Array.prototype.join.call as Function)(receiver,undefined,repair());})()',
    '(()=>{const original=Array.prototype.join;try{Array.prototype.join=(()=>first) as never;return(()=>Array.prototype.join.call({length:1,get 0(){throw new Error("unused");}}))();}finally{Array.prototype.join=original;}})()',
    '(()=>{try{return Array.prototype.join.call({length:1,get 0(){throw new Error("caught");}});}catch{return first;}})()',
    '(()=>Array.prototype.join.call({length:1,get 0(){throw new Error("deferred");}}))',
    'false&&Array.prototype.join.call({length:1,get 0(){throw new Error("skipped");}})',
    'Array.prototype.join.call({length:first||0,get 0(){throw new Error("unknown length");}})',
  ])(
    'keeps unused, overwritten, returning, repaired and unexecuted getters: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
