import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the discarded invocation before selecting the local JSON input. */
const fixture = stateFixture('null-prototype-callees', 'NullPrototypeCallees');

/** An empty Object.create(null) result has no callable members, including Object.prototype names. */
describe('written null-prototype factory callees', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(Object.create(null) as any).missing()',
    '(Object.create(null) as any).toString()',
    '(Object.create(null) as any)["missing"]()',
    'new ((Object.create(null) as any).missing)()',
    '(Object.create(null) as any).missing`x`',
    '(Object.create(null,undefined) as any).missing()',
    '(()=>{const blank=Object.create(null);return blank.missing();})()',
    '(()=>{const create=Object.create;return create(null).missing();})()',
  ])('refuses an invocation of a source-proven absent member: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(Object.create(null,{missing:{value(){return 0;}}}) as any).missing()',
    '(Object.create(null,{missing:{get(){return ()=>0;}}}) as any).missing()',
    '(Object.create({missing(){return 0;}}) as any).missing()',
    '(Object.create(Object.prototype) as any).toString()',
    '(()=>{const blank=Object.create(null);const alias=blank;alias.missing=()=>0;return blank.missing();})()',
    '(()=>{const blank=Object.create(null);function install(into:any){into.missing=()=>0;}install(blank);return blank.missing();})()',
    '(()=>{function make(){return Object.create(null,{missing:{value(){return 0;}}});}return make().missing();})()',
    '(()=>{try{return Object.create(null).missing();}catch{return 0;}})()',
    '(()=>Object.create(null).missing())',
    '(Object.create(null) as any).missing?.(decodeURIComponent("%"))',
    'false&&(Object.create(null) as any).missing()',
  ])('keeps own, inherited, unknown, changed and unexecuted callees: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
