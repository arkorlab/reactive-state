import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-dependent initializer reaches the authority's JSON and synchronous-throw checks. */
const fixture = stateFixture('factory-result-conversion', 'FactoryResultConversion', 'value');

/** Typed factories convert the selected mapper's result after its synchronous return. */
describe('factory mapper result conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Uint8Array.from([1], () => Symbol("x") as never)',
    'Float64Array.from([1], () => 1n as never)',
    'Uint16Array.from([1], function () { return Symbol.iterator as never; })',
    'BigInt64Array.from([1n], () => 1 as never)',
    'BigUint64Array.from([1n], () => null as never)',
    'BigInt64Array.from([1n], () => undefined as never)',
    'BigInt64Array.from([1n], () => "bad" as never)',
    'BigInt64Array.from([1n], () => Symbol("x") as never)',
    'BigInt64Array.from([1n], (() => {}) as never)',
    'BigInt64Array.from([1n], (() => { return; }) as never)',
  ])('refuses a source-proven mapper result conversion failure: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.from([1], () => Symbol("x"))',
    'Uint8Array.from([], () => Symbol("x") as never)',
    'Uint8Array.from([1], () => undefined as never)',
    'Uint8Array.from([1], () => "bad" as never)',
    'BigInt64Array.from([1n], () => "12" as never)',
    'BigInt64Array.from([1n], () => true as never)',
    'BigInt64Array.from([], () => 1 as never)',
    'Uint8Array.from([1], () => { if (first === "") return Symbol("x") as never; return 1; })',
    '(() => { try { Uint8Array.from([1], () => Symbol("x") as never); } catch {} return first; })()',
    'false && Uint8Array.from([1], () => Symbol("x") as never)',
    '(() => { const source = [1]; source.length = 0; return Uint8Array.from(source, () => Symbol("x") as never); })()',
    'Uint8Array.from([1], (async () => Symbol("x")) as never)',
    'Uint8Array.from([1], (function* () { return Symbol("x"); }) as never)',
    'Uint8Array.from([1], () => { const result = Symbol("x"); return 1; })',
    '(() => { const original = Symbol; try { return Uint8Array.from([undefined], (_value = (globalThis.Symbol = (() => 0) as never)) => Symbol() as never); } finally { globalThis.Symbol = original; } })()',
  ])('keeps valid, empty, uncertain, deferred and handled conversions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
