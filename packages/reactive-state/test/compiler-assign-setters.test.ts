import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates copying before the discarded target yields a trailing JSON string. */
const fixture = stateFixture('assign-setters', 'AssignSetters');

/** Assign reads each enumerable source value before setting the target in native key order. */
describe('source-written Object.assign target setters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.assign({set value(_value:unknown){throw new Error("setter");}},{value:first})',
    '(()=>{const target={set value(_value:unknown){throw new Error("setter");}};const source={value:first};return Object.assign(target,source);})()',
    '(()=>{const key="value";return Object.assign({set [key](_value:unknown){throw new Error("setter");}},{[key]:first});})()',
    'Object.assign({set value(_value:unknown){throw new Error("setter");},get value(){return 0;}},{value:first})',
    'Object.assign({set 0(_value:unknown){throw new Error("setter");},set value(_value:unknown){}},{value:first,0:0})',
    'Object.assign({set value(_value:unknown){throw new Error("setter");}},{},null,{value:first})',
    'Object.assign({set value(_value:unknown){throw new Error("setter");}},{value:first,get later(){return 0;}})',
    'Object.assign({set value(_value:unknown){throw new Error("setter");}},{set value(_value:unknown){}})',
    'Object.assign({value:0,set value(_value:unknown){throw new Error("setter");}},{value:first})',
    'Object.assign({set value(_value:unknown){throw new Error("setter");}},{get value(){return 0;},value:first})',
  ])('refuses the first invoked setter when it always throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.assign({set value(_value:unknown){throw new Error("unused");}},{other:first})',
    'Object.assign({set value(_value:unknown){throw new Error("overwritten");},value:0},{value:first})',
    'Object.assign({get value(){throw new Error("unread");},set value(_value:unknown){}},{value:first})',
    'Object.assign({set earlier(_value:unknown){Object.defineProperty(this,"value",{value:0,writable:true});},set value(_value:unknown){throw new Error("repaired");}},{earlier:0,value:first})',
    'Object.assign({set value(_value:unknown){throw new Error("repaired");},set 0(_value:unknown){Object.defineProperty(this,"value",{value:0,writable:true});}},{value:first,0:0})',
    '(()=>{const target={set value(_value:unknown){throw new Error("repaired");}};return Object.assign(target,{get value(){Object.defineProperty(target,"value",{value:0,writable:true});return first;}});})()',
    '(()=>{const target={set value(_value:unknown){throw new Error("repaired");}};function repair(){Object.defineProperty(target,"value",{value:0,writable:true});return{value:first};}return Object.assign(target,{value:first},repair());})()',
    'Object.assign({set value(_value:unknown){throw new Error("unused");}},Object.defineProperty({},"value",{value:first}))',
    'Object.assign({set value(_value:unknown){throw new Error("unused");}},null,undefined)',
    'Object.assign({set value(_value:unknown){throw new Error("unknown");}},JSON.parse(first||"{}"))',
    '(()=>{try{Object.assign({set value(_value:unknown){throw new Error("caught");}},{value:first});}catch{}return 0;})()',
    '(()=>Object.assign({set value(_value:unknown){throw new Error("deferred");}},{value:first}))',
    'false&&Object.assign({set value(_value:unknown){throw new Error("skipped");}},{value:first})',
    'Object.assign({set value(_value:unknown){}},{value:first})',
  ])('keeps untouched, pure, repaired, unknown and unexecuted setters: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
