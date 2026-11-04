import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('abort-timeouts', 'AbortTimeouts');

/** Native timeout delays are numbers in an unsigned integer range, without coercion. */
describe('source-written AbortSignal timeout delays', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'AbortSignal.timeout(-1)',
    'AbortSignal.timeout(0.5)',
    'AbortSignal.timeout(2 ** 32)',
    'AbortSignal.timeout(NaN)',
    'AbortSignal.timeout(Infinity)',
    "AbortSignal.timeout('1' as never)",
    'AbortSignal.timeout(null as never)',
    'AbortSignal.timeout(undefined as never)',
    'AbortSignal.timeout(1n as never)',
    "AbortSignal.timeout(Symbol('delay') as never)",
    'AbortSignal.timeout()',
    '(() => { const delay = -1; return AbortSignal.timeout(delay); })()',
    '(() => { const timeout = AbortSignal.timeout; return timeout(-1); })()',
  ])('refuses a source-known invalid delay: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    'AbortSignal.timeout(0)',
    'AbortSignal.timeout(-0)',
    'AbortSignal.timeout(1)',
    'AbortSignal.timeout(2 ** 32 - 1)',
    "AbortSignal.timeout(1, Symbol('ignored'))",
    'AbortSignal.timeout(Number(first))',
    '(() => { const AbortSignal = { timeout() { return first; } }; return AbortSignal.timeout(-1); })()',
    '(() => { const saved = AbortSignal.timeout; try { AbortSignal.timeout = () => first as never; return AbortSignal.timeout(-1); } finally { AbortSignal.timeout = saved; } })()',
    '(() => { try { return AbortSignal.timeout(-1); } catch { return first; } })()',
    'false && AbortSignal.timeout(-1)',
    '(() => AbortSignal.timeout(-1))',
  ])('keeps valid, ignored, unknown and deferred timeout work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
