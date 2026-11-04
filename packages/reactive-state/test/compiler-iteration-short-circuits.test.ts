import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A page prop makes the authority evaluate this initializer rather than merely keeping its text. */
const fixture = stateFixture('short-iteration', 'ShortIteration', 'value');

/** Logical operators do not request the iterator of a proven skipped right operand. */
describe('iteration short circuits', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'false && [...(null as never)]',
    'true || [...(null as never)]',
    '("present" as string | null) ?? [...(null as never)]',
    '0 && [...(null as never)]',
    '"" && [...(null as never)]',
    '-0 && [...(null as never)]',
    '!true && [...(null as never)]',
  ])('keeps an unexecuted iteration: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'true && [...(null as never)]',
    'false || [...(null as never)]',
    '(null as string | null) ?? [...(null as never)]',
  ])('refuses an executed non-iterable operand: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});
