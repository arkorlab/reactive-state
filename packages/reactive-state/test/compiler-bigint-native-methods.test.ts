import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('bigint-native-methods', 'BigintNativeMethods');

/** Source-known native numeric slots reject BigInts while value and Boolean positions retain them. */
describe('written BigInt numeric native method arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "'xy'.slice(1n as never)",
    "'xy'.substring(0, 1n as never)",
    "'xy'.charAt(1n as never)",
    "'xy'.padStart(1n as never)",
    '[1, 2].slice(1n as never)',
    '[1, 2].at(1n as never)',
    '[1, 2].fill(0, 1n as never)',
    '[1].includes(1, 0n as never)',
    'new Uint8Array([1, 2]).slice(1n as never)',
    'new Uint8Array(1).set([1], 0n as never)',
    'new Uint8Array(1).fill(1n as never)',
    'new Date(0).setTime(1n as never)',
    'new Date(0).setFullYear(2000, 1n as never)',
    'new DataView(new ArrayBuffer(8)).getInt16(1n as never)',
    'new DataView(new ArrayBuffer(8)).setInt16(0, 1n as never)',
    'new DataView(new ArrayBuffer(8)).setBigInt64(0n as never, 1n)',
    "String.prototype.slice.call('xy', 1n as never)",
    'Array.prototype.at.apply([1], [0n] as never)',
    "Reflect.apply(String.prototype.charAt, 'xy', [1n])",
  ])('refuses a consumed BigInt numeric argument: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "'xy'.slice(1, 2)",
    "'xy'.padStart(4, 1n as never)",
    "('xy'.slice as Function)(1, 2, 1n)",
    '[1].fill(1n as never)',
    '[1].indexOf(1n as never)',
    '[].includes(0 as never, 1n as never)',
    'new Uint8Array(0).indexOf(0, 1n as never)',
    'new BigInt64Array(1).fill(1n)',
    'new DataView(new ArrayBuffer(8)).setBigInt64(0, 1n)',
    'new DataView(new ArrayBuffer(8)).getInt16(0, 1n as never)',
    '({ slice(_index: bigint) { return first; } }).slice(1n)',
    '(() => { const values = [1, 2]; values.slice = (() => []) as never; return values.slice(1n as never); })()',
    "(() => { const saved = String.prototype.slice; try { String.prototype.slice = (() => first) as never; return (() => 'xy'.slice(1n as never))(); } finally { String.prototype.slice = saved; } })()",
    "(() => { function read(index: unknown) { return 'xy'.slice(index as never); } return read(0); })()",
    "(() => { try { return 'xy'.slice(1n as never); } catch { return first; } })()",
    "false && 'xy'.slice(1n as never)",
    "(() => 'xy'.slice(1n as never))",
  ])('keeps ignored, nonnumeric and unproven conversions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '[1].flat(1n as never)',
    '[].flat(0n as never)',
    "[1].flat(Symbol('depth') as never)",
    'Array.prototype.flat.call({ length: 0 }, 1n as never)',
    "Array.prototype.flat.apply([], [Symbol('depth')] as never)",
    'Reflect.apply(Array.prototype.flat, [1], [1n])',
  ])('refuses a source-proven invalid Array.flat depth: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '[].flat()',
    '[[1]].flat(1)',
    '[1].flat(undefined)',
    '([1].flat as Function)(0, 1n)',
    '({ flat(_depth: bigint) { return first; } }).flat(1n)',
    '(() => { const values = [1]; values.flat = (() => []) as never; return values.flat(1n as never); })()',
    '(() => { function flatten(depth: unknown) { return [1].flat(depth as never); } return flatten(0); })()',
    '(() => { try { return [1].flat(1n as never); } catch { return first; } })()',
    'false && [1].flat(1n as never)',
    '(() => [1].flat(1n as never))',
  ])('keeps valid, ignored and unproven Array.flat depths: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
