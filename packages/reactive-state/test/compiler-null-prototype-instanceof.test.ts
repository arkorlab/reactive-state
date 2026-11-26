import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority computes the discarded membership result before returning a JSON input. */
const fixture = stateFixture('null-prototype-instanceof', 'NullPrototypeInstanceof', 'indented');

/** A fresh null-prototype factory has neither callability nor an inherited instance hook. */
describe('null-prototype factory instanceof targets', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '1 instanceof (Object.create(null) as never)',
    '1 instanceof (Object.create(null, undefined) as never)',
    '1 instanceof (Object.create(null, {}) as never)',
    '1 instanceof (Object.create(null, void 0) as never)',
    '(() => { const target = Object.create(null); return 1 instanceof target; })()',
    '(() => { const blank = null; return 1 instanceof Object.create(blank); })()',
    '(() => { const create = Object.create; return 1 instanceof create(null); })()',
  ])('refuses a known target with no callable instance hook: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    '1 instanceof Object.create(null, {[Symbol.hasInstance]: {value: () => true}})',
    '1 instanceof Object.create(null, {[Symbol.hasInstance]: {get() { return () => true; }}})',
    '1 instanceof Object.create({[Symbol.hasInstance]() { return true; }})',
    '1 instanceof Object.create(Object.prototype)',
    '(() => { const target = Object.create(null); target[Symbol.hasInstance] = () => true; return 1 instanceof target; })()',
    '(() => { const target = Object.create(null); const alias = target; alias[Symbol.hasInstance] = () => true; return 1 instanceof target; })()',
    '(() => { const target = Object.create(null); Object.defineProperty(target, Symbol.hasInstance, {value: () => true}); return 1 instanceof target; })()',
    '(() => { const descriptors: any = {}; descriptors[Symbol.hasInstance] = {value: () => true}; return 1 instanceof Object.create(null, descriptors); })()',
    '(() => { const Object = {create() { return {[Symbol.hasInstance]() { return true; }}; }}; return 1 instanceof Object.create(); })()',
    '(() => { try { return 1 instanceof Object.create(null); } catch { return false; } })()',
    'false && (1 instanceof Object.create(null))',
    '(() => 1 instanceof Object.create(null))',
    "'missing' in Object.create(null)",
  ])('keeps hooks, changed or unknown targets and normal control flow: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
