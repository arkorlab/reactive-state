import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The factory finishes before the authority receives the trailing prop-based JSON string. */
const fixture = stateFixture('array-from-callee-changes', 'ArrayFromCalleeChanges', 'spaced');

/** A changed namespace no longer selects the native array-like length conversion. */
describe('array factory namespace changes before length conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(() => { const array = Array; array.from = (() => "ok") as never; return array.from({ length: 1n } as never); })()',
    '(() => { const native = Array; const array = native; array.from = (() => "ok") as never; return array.from({ length: Symbol("ignored") } as never); })()',
    '(() => { const array = { from(_: unknown) { return "ok"; } }; return array.from({ length: 1n }); })()',
    '(() => { let from = Array.from; from = (() => []) as never; return from({ length: 1n } as never); })()',
  ])('keeps replaced and application-owned factories: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '(() => { const array = Array; return array.from({ length: 1n } as never); })()',
    '(() => { const native = Array; const array = native; return array.from({ length: Symbol("used") } as never); })()',
  ])('still refuses unchanged native namespace aliases: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('which no JSON holds'),
    ]);
  });
});
