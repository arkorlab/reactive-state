import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native call executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('prototype-identity-cycles', 'PrototypeIdentityCycles');

/** Object rejects cycles while Reflect reports false; literal property names do not imply identity. */
describe('written Object prototype identity cycles', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const value={};return Object.setPrototypeOf(value,value);})()',
    '(()=>{const value={};const alias=value;return Object.setPrototypeOf(value,alias);})()',
    '(()=>{const value={};const prototype={__proto__:value};return Object.setPrototypeOf(value,prototype);})()',
    '(()=>{const value={};const middle={__proto__:value};const prototype={__proto__:middle};return Object.setPrototypeOf(value,prototype);})()',
    '(()=>{const value:unknown[]=[];return Object.setPrototypeOf(value,value);})()',
    '(()=>{const value={};return Object.setPrototypeOf(value,Object.create(value));})()',
  ])('refuses a source-proven Object prototype cycle: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const value={};return Reflect.setPrototypeOf(value,value);})()',
    '(()=>{const value={};const prototype={__proto__:value};return Reflect.setPrototypeOf(value,prototype);})()',
    'Object.setPrototypeOf({},{})',
    "(()=>{const value={};return Object.setPrototypeOf(value,{['__proto__']:value});})()",
    '(()=>{const value={};return Object.setPrototypeOf(value,{__proto__:1 as never});})()',
    "(()=>{const value={};return Object.setPrototypeOf(value,{get __proto__(){throw new Error('unused');}});})()",
    'Object.setPrototypeOf(1,{})',
    '(()=>{const value={};const prototype={__proto__:value};Object.setPrototypeOf(prototype,null);return Object.setPrototypeOf(value,prototype);})()',
    '(()=>{Object.setPrototypeOf=(()=>first) as never;const value={};return Object.setPrototypeOf(value,value);})()',
    '(()=>{try{const value={};return Object.setPrototypeOf(value,value);}catch{return first;}})()',
    '(()=>{const value={};return ()=>Object.setPrototypeOf(value,value);})()',
    'false&&(()=>{const value={};return Object.setPrototypeOf(value,value);})()',
  ])('keeps explicit, ignored, custom and deferred native inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
