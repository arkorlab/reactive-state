import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The cloning result is discarded before the authority receives a string value. */
const fixture = stateFixture('structured-clone-values', 'StructuredCloneValues', 'spaced');

/** Native cloning rejects callable values, symbols and known uncloneable object identities. */
describe('written structured clone primary values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'structuredClone(() => {})',
    'structuredClone(function () {})',
    'structuredClone(async () => 0)',
    'structuredClone(class {})',
    "structuredClone(Symbol('value'))",
    'structuredClone(Symbol.iterator)',
    'structuredClone(new WeakMap())',
    'structuredClone(new WeakSet())',
    'structuredClone(new Proxy({}, {}))',
    'structuredClone(new Promise((resolve) => resolve(0)))',
    'structuredClone(new WeakRef({}))',
    'structuredClone(new FinalizationRegistry(() => {}))',
    '(() => { const value = () => 0; const alias = value; return structuredClone(alias); })()',
    '(() => { const value = new WeakMap(); return structuredClone(value); })()',
    'globalThis.structuredClone(() => {})',
  ])('refuses a source-proven uncloneable primary value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    'structuredClone(1n)',
    'structuredClone(undefined)',
    'structuredClone({ value: first })',
    'structuredClone([first, 1])',
    'structuredClone(new Date(0))',
    'structuredClone(/text/u)',
    'structuredClone(new Map([[first, 0]]))',
    'structuredClone(new Set([first]))',
    'structuredClone(new Uint8Array([1]))',
    "structuredClone({ [Symbol('ignored')]: () => {} })",
    'structuredClone({ get value() { return 0; } })',
    '(() => { let value: unknown = () => 0; value = {}; return structuredClone(value); })()',
    '(() => { const structuredClone = (_value: unknown) => first; return structuredClone(() => {}); })()',
    '(() => { class WeakMap { value = 0; } return structuredClone(new WeakMap()); })()',
    '(() => { try { structuredClone(() => {}); } catch {} return first; })()',
    'false && structuredClone(() => {})',
    '(() => structuredClone(() => {}))',
    '(() => { const saved = globalThis.structuredClone; try { globalThis.structuredClone = (() => 0) as never; return structuredClone(() => {}); } finally { globalThis.structuredClone = saved; } })()',
  ])('keeps cloneable, shadowed, changed, caught and deferred inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
