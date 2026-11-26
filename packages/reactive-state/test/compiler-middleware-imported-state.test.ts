import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Runtime imports cannot carry singleton state between extracted authority and host parts. */
const CASES = [
  {
    id: 'named-singleton',
    imports: 'import { decision } from "@/decisions";',
    before: 'decision.allowed = params.projectId.length > 0;',
    after: 'response.headers.set("X-Decision", String(decision.allowed));',
    refused: true,
    reason: 'both',
  },
  {
    id: 'default-singleton',
    imports: 'import decision from "@/decisions";',
    before: 'decision.allowed = true;',
    after: 'response.headers.set("X-Decision", String(decision.allowed));',
    refused: true,
    reason: 'both',
  },
  {
    id: 'namespace-singleton',
    imports: 'import * as decisions from "@/decisions";',
    before: 'decisions.decision.allowed = true;',
    after: 'response.headers.set("X-Decision", String(decisions.decision.allowed));',
    refused: true,
    reason: 'both',
  },
  {
    id: 'same-export-two-aliases',
    imports: 'import { decision as guarded, decision as shown } from "@/decisions";',
    before: 'guarded.allowed = true;',
    after: 'response.headers.set("X-Decision", String(shown.allowed));',
    refused: true,
    reason: 'both',
  },
  {
    id: 'same-module-writer-and-value',
    imports: 'import { allow, decision } from "@/decisions";',
    before: 'allow();',
    after: 'response.headers.set("X-Decision", String(decision.allowed));',
    refused: true,
    reason: 'both',
  },
  {
    id: 'guard-only-singleton',
    imports: 'import { decision } from "@/decisions";',
    before: 'decision.allowed = true;',
    after: 'response.headers.set("X-Decision", "fixed");',
    refused: false,
  },
  {
    id: 'host-only-singleton',
    imports: 'import { decision } from "@/decisions";',
    before: 'await requirePublishedProject(params.projectId);',
    after: 'response.headers.set("X-Decision", String(decision.allowed));',
    refused: false,
  },
  {
    id: 'guard-only-pure-function',
    imports: 'import { label } from "@/decisions";',
    before: 'label(params.projectId);',
    after: 'response.headers.set("X-Decision", "fixed");',
    refused: false,
  },
  {
    id: 'host-only-pure-function',
    imports: 'import { label } from "@/decisions";',
    before: 'await requirePublishedProject(params.projectId);',
    after: 'response.headers.set("X-Decision", label(params.projectId));',
    refused: false,
  },
  {
    id: 'type-only-shared-between-parts',
    imports: 'import type { Decision } from "@/decisions";',
    before:
      'const checked: Decision = { allowed: true }; if (!checked.allowed) throw new Error("denied");',
    after:
      'const shown: Decision = { allowed: true }; response.headers.set("X-Decision", String(shown.allowed));',
    refused: false,
  },
  {
    id: 'already-refused-after-local-shadow',
    imports: 'import { decision } from "@/decisions";',
    before: 'decision.allowed = true;',
    after:
      '{ const decision = { allowed: "fixed" }; response.headers.set("X-Decision", decision.allowed); }',
    refused: true,
  },
] as const;

describe('runtime imported identities across split middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async (row) => {
    const { imports, before, after, refused } = row;
    const app = await application({
      'decisions.ts': [
        'export interface Decision { allowed: boolean }',
        'export const decision = { allowed: false };',
        'export default decision;',
        'export function allow() { decision.allowed = true; }',
        'export function label(value: string) { return value; }',
      ].join('\n'),
      'app/boards/[projectId]/middleware.ts': [
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        imports,
        'export default (async ({ params }, next) => {',
        before,
        'const response = await next();',
        after,
        'return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toHaveLength(refused ? 1 : 0);
    expect(compiled.refusals[0]?.reason ?? '').toContain('reason' in row ? row.reason : '');
  });
});
