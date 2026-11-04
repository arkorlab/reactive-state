import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The discarded strict write still executes in an authority-started initializer. */
const fixture = stateFixture('inherited-property-writes', 'InheritedPropertyWrites');

/** A prototype getter without a setter also blocks strict assignment through its receiver. */
describe('written inherited getter assignments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(Object.freeze({__proto__:{get held(){return 0;}}}) as never).held=first',
    '({__proto__:{get held(){return 0;}}} as never).held=first',
    'Object.create({get held(){return 0;}}).held=first',
    '({__proto__:{__proto__:{get held(){return 0;}}}} as never).held=first',
    '(Object.seal({__proto__:{get held(){return 0;}}}) as never).held=first',
    '(Object.preventExtensions({__proto__:{get held(){return 0;}}}) as never).held=first',
  ])('refuses a source-proven inherited getter-only assignment: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '({__proto__:{get held(){return 0;}},held:0}).held=first as never',
    '(Object.freeze({__proto__:{set held(_value:string){}}}) as never).held=first',
    '(Object.freeze({__proto__:{get held(){return 0;},set held(_value:string){}}}) as never).held=first',
    '({__proto__:{held:0}} as never).held=first',
    'Object.create(null).held=first',
    'Object.create({get held(){return 0;}},{held:{value:0,writable:true}}).held=first',
    '({__proto__:{__proto__:{get held(){return 0;}},held:0}} as never).held=first',
    "({__proto__:{get held(){Object.defineProperty(this,'held',{value:0,writable:true});return 0;}}} as never).held++",
    '(()=>{const parent={get held(){return 0;}};const child={__proto__:parent} as never;return child.held=(Object.setPrototypeOf(child,{}),first);})()',
    "(()=>{const base=first===''?{}:{held:0};return ({__proto__:base} as never).held=first;})()",
    '(()=>{try{(Object.freeze({__proto__:{get held(){return 0;}}}) as never).held=first;}catch{}return first;})()',
    '(function*(){(Object.freeze({__proto__:{get held(){return 0;}}}) as never).held=first;})()',
  ])('keeps own shadows, setters and unproven or deferred assignments: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
