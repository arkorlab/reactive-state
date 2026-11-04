import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
import { framedSourceCases } from './support/framed-source-cases.ts';

describe('actual shared compiler source-visible error receivers', () => {
  const { apps, compile } = compilerApplications();

  it.each(framedSourceCases)('$name', async (test) => {
    const { source, invocation } = test;
    const refused = 'compilerRefused' in test ? test.compilerRefused : test.refused;
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
