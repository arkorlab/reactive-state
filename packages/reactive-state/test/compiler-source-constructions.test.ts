import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The constructed result is discarded, so only escaping synchronous work prevents the JSON input. */
const fixture = stateFixture('source-constructions', 'SourceConstructions');

/** Construction runs a base class's instance fields before its explicit constructor body. */
describe('written class construction work', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new(class{constructor(){throw new Error("bad");}})()',
    'new(class{constructor(){decodeURIComponent("%");}})()',
    'new(class{value=decodeURIComponent("%");})()',
    'new(class{value=(()=>{throw new Error("field");})();})()',
    'new(class{value=(()=>{throw new Error("field");})();constructor(){return {};}})()',
    '(()=>{class Failed{constructor(){throw new Error("bad");}}return new Failed();})()',
    '(()=>{const Failed=class{value=decodeURIComponent("%");};const Alias=Failed;return new Alias();})()',
  ])('refuses the synchronous work of a constructed source class: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(class{constructor(){throw new Error("unconstructed");}})',
    'new(class{value=()=>{throw new Error("deferred");};})()',
    '(()=>{try{return new(class{constructor(){throw new Error("caught");}})();}catch{return 0;}})()',
    'new(class{constructor(){try{throw new Error("caught");}catch{}}})()',
    'new(class{constructor(){try{throw new Error("overridden");}finally{return {};}}})()',
    'new(class extends(class{}){value=(()=>{throw new Error("unused");})();constructor(){return {};}})()',
    'new((()=>{void first;return class{constructor(){return {};}};})())()',
    '(()=>{let Made=class{constructor(){throw new Error("replaced");}};Made=class{};return new Made();})()',
    '(()=>{const original=decodeURIComponent;try{return new(class{constructor(){decodeURIComponent("%");}})((globalThis.decodeURIComponent=()=>"ok"));}finally{globalThis.decodeURIComponent=original;}})()',
    '(()=>{const original=decodeURIComponent;try{return new(class{first=(globalThis.decodeURIComponent=()=>"ok");second=decodeURIComponent("%");})()}finally{globalThis.decodeURIComponent=original;}})()',
    '(()=>{class Loop{constructor(){new Loop();}}try{return new Loop();}catch{return 0;}})()',
  ])(
    'keeps unconstructed, deferred, caught, replaced and uncertain work: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
