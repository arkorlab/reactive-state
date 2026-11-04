import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-selected initializer evaluates the discarded operation on the authority. */
const fixture = stateFixture('iterator-outer-effects', 'IteratorOuterEffects');

/** Immediate nested consumers retain the effects before their invocation. */
describe('iterator consumer outer effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const saved=Uint16Array.from;try{Uint16Array.from=(()=>[1]) as never;return (()=>Uint16Array.from({get [Symbol.iterator](){throw new Error("unused iterator");}}))();}finally{Uint16Array.from=saved;}})()',
    '(()=>Uint16Array.from({*[Symbol.iterator](){yield 1;}}))()',
  ])('keeps an unchanged or replaced nested consumer: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '(()=>Uint16Array.from({get [Symbol.iterator](){throw new Error("bad");}}))()',
    '(()=>{const unused=()=>{Uint16Array.from=(()=>[1]) as never;};return (()=>Uint16Array.from({get [Symbol.iterator](){throw new Error("bad");}}))();})()',
  ])('refuses an invoked getter without an earlier replacement: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});
