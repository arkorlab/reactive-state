import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-dependent branch makes the authority check the initializer before the site reads it. */
const fixture = stateFixture('factory-mappers', 'FactoryMappers', 'value');

/** Native factories invoke their mapper only when their source supplies an entry. */
describe('synchronous factory mapper failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.from([first], () => { throw new Error("mapper"); })',
    'Array.from([first], () => decodeURIComponent("%"))',
    'Array.from([,], () => { throw new Error("mapper"); })',
    'Array.from("x", () => { throw new Error("mapper"); })',
    'Array.from({0: first, length: 1}, () => { throw new Error("mapper"); })',
    'Uint8Array.from([1], () => { throw new Error("mapper"); })',
    'BigInt64Array.from([1n], () => { throw new Error("mapper"); })',
    'globalThis.Array.from([first], () => { throw new Error("mapper"); })',
    '(() => { const factory = Array.from; const mapper = () => { throw new Error("mapper"); }; return factory([first], mapper); })()',
    '(() => { const source = [first]; return Array.from(source, () => { throw new Error("mapper"); }); })()',
    'Uint16Array.from({length: 1}, () => { throw new Error("mapper"); })',
  ])('refuses a mapper that necessarily throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.from([], () => { throw new Error("uncalled"); })',
    'Array.from("", () => { throw new Error("uncalled"); })',
    'Array.from({length: 0}, () => { throw new Error("uncalled"); })',
    'Uint8Array.from([], () => { throw new Error("uncalled"); })',
    'Array.from(first, () => { throw new Error("uncertain"); })',
    'Array.from({length: 1, [Symbol.iterator]() { return {next() { return {done: true}; }}; }}, () => { throw new Error("uncalled"); })',
    'Array.from([first], async () => { throw new Error("later"); })',
    'Array.from([first], function* () { throw new Error("later"); })',
    'Array.from([first], () => first)',
    '(() => { try { Array.from([first], () => { throw new Error("caught"); }); } catch {} return first; })()',
    'false && Array.from([first], () => { throw new Error("uncalled"); })',
    '(() => { const source = [first]; source.length = 0; return Array.from(source, () => { throw new Error("uncalled"); }); })()',
    '(() => { const source = [first]; return Array.from(source, () => { throw new Error("uncalled"); }, source.length = 0); })()',
    'Array.from({length: 1, length: 0}, () => { throw new Error("uncalled"); })',
    '(() => { const factory = {from(..._args: unknown[]) { return [first]; }}; return factory.from([first], () => { throw new Error("uncalled"); }); })()',
  ])('keeps empty, uncertain, deferred and handled mapper calls: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
