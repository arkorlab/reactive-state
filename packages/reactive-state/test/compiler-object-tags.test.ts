import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority reads a native object tag before the result is discarded for a JSON string. */
const fixture = stateFixture('object-tags', 'ObjectTags');

/** Object.prototype.toString reads the final own well-known tag, without calling a data value. */
describe('source-written Object.prototype.toString tag getters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("tag");}})',
    'globalThis.Object.prototype.toString.call({get [globalThis.Symbol.toStringTag](){throw new Error("tag");}})',
    '(()=>{const key=Symbol.toStringTag;return Object.prototype.toString.call({get [key](){throw new Error("tag");}});})()',
    '(()=>{const value={get [Symbol.toStringTag](){throw new Error("tag");}};return Object.prototype.toString.call(value);})()',
    'Object.prototype.toString.apply({get [Symbol.toStringTag](){throw new Error("tag");}},[])',
    'Reflect.apply(Object.prototype.toString,{get [Symbol.toStringTag](){throw new Error("tag");}},[])',
    'Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("tag");},set [Symbol.toStringTag](_value:unknown){}})',
    'Object.prototype.toString.call({[Symbol.toStringTag]:"old",get [Symbol.toStringTag](){throw new Error("tag");}})',
    'Object.prototype.toString.call({get [Symbol.toStringTag](){return "old";},get [Symbol.toStringTag](){throw new Error("tag");}})',
  ])('refuses a selected tag getter that synchronously always throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.prototype.toString.call({get [Symbol.toStringTag](){return "Safe";}})',
    'Object.prototype.toString.call({get [Symbol.toStringTag](){return 1;}})',
    'Object.prototype.toString.call({[Symbol.toStringTag](){throw new Error("not called");}})',
    'Object.prototype.toString.call({set [Symbol.toStringTag](_value:unknown){throw new Error("unused");}})',
    'Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("overwritten");},[Symbol.toStringTag]:"Safe"})',
    'Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("overwritten");},[Symbol.toStringTag](){throw new Error("not called");}})',
    'Object.prototype.toString.call({get other(){throw new Error("unused");},[Symbol.toStringTag]:"Safe"})',
    '(()=>{const value={get [Symbol.toStringTag](){throw new Error("repaired");}};function repair(){Object.defineProperty(value,Symbol.toStringTag,{value:"Safe"});return 0;}return(Object.prototype.toString.call as Function)(value,repair());})()',
    '(()=>{const value={get [Symbol.toStringTag](){throw new Error("repaired");}};return(Object.defineProperty(value,Symbol.toStringTag,{value:"Safe"}),Object.prototype.toString.call(value));})()',
    '(()=>{const Object={prototype:{toString:{call(_value:unknown){return "Safe";}}}};return Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("unused");}});})()',
    'Object.prototype.toString.call(JSON.parse(first||"{}"))',
    '(()=>{try{Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("caught");}});}catch{}return 0;})()',
    '(()=>Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("deferred");}}))',
    'false&&Object.prototype.toString.call({get [Symbol.toStringTag](){throw new Error("skipped");}})',
    'Object.prototype.toString.call({set [Symbol.toStringTag](_value:unknown){},get [Symbol.toStringTag](){return "Safe";}})',
  ])('keeps returned tags, data shadows, repairs and unexecuted reads: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
