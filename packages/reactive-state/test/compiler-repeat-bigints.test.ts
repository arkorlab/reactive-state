import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('repeat-bigints', 'RepeatBigints');

/** A native repeat count uses ToNumber, including through borrowed invocation helpers. */
describe('written BigInt string repeat counts', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "'x'.repeat(1n as never)",
    "''.repeat(0n as never)",
    "'x'.repeat(BigInt(1) as never)",
    "(() => { const count = 1n; const text = 'x'; return text.repeat(count as never); })()",
    "String.prototype.repeat.call('x', 1n as never)",
    "String.prototype.repeat.apply('x', [1n as never])",
    "Reflect.apply(String.prototype.repeat, 'x', [1n])",
  ])('refuses a consumed BigInt count: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "'x'.repeat(0)",
    "'x'.repeat(2)",
    "'x'.repeat('2' as never)",
    "'x'.repeat(1, 1n)",
    "'x'.repeat(Number(first))",
    '({ repeat(_value: bigint) { return first; } }).repeat(1n)',
    "(() => { const String = { prototype: { repeat() { return first; } } }; return String.prototype.repeat.call('x', 1n); })()",
    "(() => { const saved = String.prototype.repeat; try { String.prototype.repeat = () => first; return 'x'.repeat(1n as never); } finally { String.prototype.repeat = saved; } })()",
    "(() => { try { return 'x'.repeat(1n as never); } catch { return first; } })()",
    "false && 'x'.repeat(1n as never)",
    "(() => 'x'.repeat(1n as never))",
  ])('keeps numeric, ignored, own, changed and deferred work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each(["'x'.repeat(-1)", "'x'.repeat(Infinity)"])(
    'retains an existing invalid numeric count refusal: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
    },
  );
});
