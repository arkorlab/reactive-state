import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
import { BORROWED_TEXT_CASES } from './support/framed-borrowed-text-cases.ts';

/** Actual shared admission follows borrowed native conversions and deferred method identities. */
describe('shared borrowed text error words', () => {
  const { apps, compile } = compilerApplications();

  it.each(BORROWED_TEXT_CASES)('$name', async ({ source, invocation, framed }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value: string): TodoFilter { return String(${invocation}).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = framed ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
