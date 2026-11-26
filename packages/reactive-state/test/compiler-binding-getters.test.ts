import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Binding initialization completes before the discarded result yields a JSON string. */
const fixture = stateFixture('binding-getters', 'BindingGetters');

/** Binding reads follow selected getters before defaults and enumerable object-rest copies. */
describe('source-written object binding getters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const {value}={get value(){throw new Error("binding");}};return 0;})()',
    '(()=>{const {value:renamed}={get value(){throw new Error("binding");}};return 0;})()',
    '(()=>{const key="value";const {[key]:renamed}={get value(){throw new Error("binding");}};return 0;})()',
    '(()=>{const source={get value(){throw new Error("binding");}};const {value}=source;return 0;})()',
    '(()=>{const {value}={get value(){throw new Error("binding");},set value(_value:unknown){}};return 0;})()',
    '(()=>{const {value}={value:0,get value(){throw new Error("binding");}};return 0;})()',
    '(()=>{const {...rest}={get value(){throw new Error("rest");}};return 0;})()',
    '(()=>{const {skip,...rest}={skip:0,get value(){throw new Error("rest");}};return 0;})()',
    '(()=>{const {...rest}={get later(){return 0;},get 0(){throw new Error("rest order");}};return 0;})()',
    '(()=>{const {value}={get value(){return 0;},get value(){throw new Error("final getter");}};return 0;})()',
  ])('refuses the first binding getter when it always throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const {other}={other:0,get value(){throw new Error("unused");}};return 0;})()',
    '(()=>{const {value}={get value(){throw new Error("overwritten");},value:0};return 0;})()',
    '(()=>{const {...rest}={get value(){throw new Error("overwritten");},value:0};return 0;})()',
    '(()=>{const {value}={get value(){throw new Error("overwritten");},value(){return 0;}};return 0;})()',
    '(()=>{const {value}={set value(_value:unknown){throw new Error("unused");}};return 0;})()',
    '(()=>{const {value}={get value(){return first;}};return 0;})()',
    '(()=>{const source={get early(){Object.defineProperty(source,"value",{value:0});return 0;},get value(){throw new Error("repaired");}};const {early,value}=source;return 0;})()',
    '(()=>{const source={get value(){throw new Error("repaired");}};function repair(){Object.defineProperty(source,"value",{value:0});return 0;}const {missing=repair(),value}=source;return 0;})()',
    '(()=>{const source={get value(){throw new Error("repaired");}};const {early}={get early(){Object.defineProperty(source,"value",{value:0});return 0;}},{value}=source;return 0;})()',
    '(()=>{const {value}={get value(){throw new Error("overwritten");},[first||"value"]:0};return 0;})()',
    '(()=>{const {value}=JSON.parse(first||"{}");return 0;})()',
    '(()=>{try{const {value}={get value(){throw new Error("caught");}};}catch{}return 0;})()',
    '(()=>{const {value}={get value(){throw new Error("deferred");}};return 0;})',
    'false&&(()=>{const {...rest}={get value(){throw new Error("skipped");}};return 0;})()',
  ])(
    'keeps unused, overwritten, repaired, unknown and unexecuted getters: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
