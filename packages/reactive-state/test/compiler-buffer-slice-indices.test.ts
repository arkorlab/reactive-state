import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('buffer-slice-indices', 'BufferSliceIndices');

/** Native buffer slices convert both indices, including empty receivers. */
describe('written buffer slice index conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new ArrayBuffer(8).slice(1n as never)',
    'new ArrayBuffer(8).slice(0, 1n as never)',
    "new SharedArrayBuffer(8).slice(Symbol('start') as never)",
    "new SharedArrayBuffer(8).slice(0, Symbol('end') as never)",
    'new ArrayBuffer(0).slice(0n as never)',
  ])('refuses a source-proven invalid buffer slice index: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new ArrayBuffer(8).slice(-1)',
    'new SharedArrayBuffer(8).slice(0, 1)',
    'new ArrayBuffer(8).slice(0, undefined)',
    '(new ArrayBuffer(8).slice as Function)(0, 1, 1n)',
    '({ slice(_index: bigint) { return first; } }).slice(1n)',
    '(() => { const buffer = new ArrayBuffer(8); buffer.slice = (() => new ArrayBuffer(0)) as never; return buffer.slice(1n as never); })()',
    '(() => { const saved = ArrayBuffer.prototype.slice; try { ArrayBuffer.prototype.slice = (() => new ArrayBuffer(0)) as never; return (() => new ArrayBuffer(8).slice(1n as never))(); } finally { ArrayBuffer.prototype.slice = saved; } })()',
    '(() => { const saved = ArrayBuffer.prototype.slice; try { return new ArrayBuffer({ valueOf() { ArrayBuffer.prototype.slice = (() => new ArrayBuffer(0)) as never; return 8; } } as never).slice(1n as never); } finally { ArrayBuffer.prototype.slice = saved; } })()',
    '(() => { function sliced(index: unknown) { return new ArrayBuffer(8).slice(index as never); } return sliced(0); })()',
    '(() => { try { return new ArrayBuffer(8).slice(1n as never); } catch { return first; } })()',
    'false && new ArrayBuffer(8).slice(1n as never)',
    '(() => new ArrayBuffer(8).slice(1n as never))',
  ])(
    'keeps valid, ignored, application and effectful buffer slice indices: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
