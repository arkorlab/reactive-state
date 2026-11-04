import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/** A collection copied into guard and envelope cannot carry a mutation between those copies. */
const FILE = 'app/boards/[projectId]/middleware.ts';

function middleware(before: string, header: string): string {
  return `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
import { requirePublishedProject } from '@/publication';
${before.includes('changeDecision(') ? "import { changeDecision } from '@/decisions';" : ''}
export default (async ({ params }, next) => {
  ${before}
  const response = await next();
  response.headers.set('X-Decision', ${header});
  return response;
}) satisfies RouteMiddleware<{ projectId: string }>;
`;
}

describe('collections read across split middleware parts', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    for (const app of apps) await removed(app);
    api[Symbol.dispose]();
  });

  async function compile(before: string, header: string) {
    const app = await application({
      [FILE]: middleware(before, header),
      'decisions.ts':
        "import { requireUser } from '@arkorlab/reactive-state/server';\nexport async function changeDecision(value: { allowed: boolean }) { await requireUser(); value.allowed = true; }\n",
    });
    apps.push(app);
    return compiledApp(app, api);
  }

  it.each([
    [
      'const decision = { allowed: false }; const copied = { read() { return decision.allowed; } }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.read())',
    ],
    [
      'const decision = { allowed: false }; const Copied = class { allowed = decision.allowed; }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(new Copied().allowed)',
    ],
    [
      'const decision = { allowed: false }; const copied = { get allowed() { return decision.allowed; } }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.allowed)',
    ],
    [
      'const decision = { allowed: false }; const copied = () => decision.allowed; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied())',
    ],
    [
      'const decision = { allowed: false }; const copied = { nested: { get allowed() { return decision.allowed; } } }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.nested.allowed)',
    ],
    [
      'const decision = { nested: { allowed: false } }; const copied = { nested: decision.nested }; const project = await requirePublishedProject(params.projectId); decision.nested.allowed = project.title.length > 0;',
      'String(copied.nested.allowed)',
    ],
    [
      'const decision = { allowed: false }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(decision.allowed)',
    ],
    [
      'const ids = [params.projectId]; const project = await requirePublishedProject(params.projectId); ids.push(project.id);',
      'ids.join(",")',
    ],
    [
      'const decision = { allowed: false }; const alias = decision; const project = await requirePublishedProject(params.projectId); alias.allowed = project.title.length > 0;',
      'String(decision.allowed)',
    ],
    [
      'const decision = { nested: { allowed: false } }; const alias = decision.nested; const project = await requirePublishedProject(params.projectId); alias.allowed = project.title.length > 0;',
      'String(decision.nested.allowed)',
    ],
    [
      'const decision = { nested: { allowed: false } }; const { nested } = decision; const project = await requirePublishedProject(params.projectId); nested.allowed = project.title.length > 0;',
      'String(decision.nested.allowed)',
    ],
    [
      'const decision = { count: 0 }; const alias = decision; await requirePublishedProject(params.projectId); alias.count++;',
      'String(decision.count)',
    ],
    [
      'const decision: { allowed?: boolean } = { allowed: false }; await requirePublishedProject(params.projectId); delete decision.allowed;',
      'String(decision.allowed)',
    ],
    [
      'const decision = { allowed: false }; await changeDecision(decision);',
      'String(decision.allowed)',
    ],
  ])('refuses a cross-part mutable collection: %s', async (before, header) => {
    const compiled = await compile(before, header);

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain('mutated');
  });

  it.each([
    [
      'const decision = { allowed: false }; const allowed = decision.allowed; const copied = () => allowed; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied())',
    ],
    [
      'const decision = { allowed: false }; const copied = { allowed: decision.allowed }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.allowed)',
    ],
    [
      'const decision = { allowed: false }; const copied = [decision.allowed]; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied[0])',
    ],
    [
      'const decision = { allowed: false }; const copied = { nested: { allowed: decision.allowed } }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.nested.allowed)',
    ],
    [
      'const decision = { allowed: false }; const alias = decision; const copied = { allowed: alias.allowed }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0;',
      'String(copied.allowed)',
    ],
    [
      'const decision = { id: params.projectId }; await requirePublishedProject(decision.id);',
      'decision.id',
    ],
    [
      'const decision = { allowed: false }; const allowed = decision.allowed; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0; if (!decision.allowed) return new Response("Denied", { status: 403 });',
      'String(allowed)',
    ],
    [
      'const decision = { allowed: false }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0; if (!decision.allowed) return new Response("Denied", { status: 403 });',
      '"unchanged"',
    ],
    [
      'const id = params.projectId; const copied = id; await requirePublishedProject(copied);',
      'copied',
    ],
    [
      'const decision = { allowed: false }; const read = (value: { allowed: boolean }) => value.allowed; await requirePublishedProject(read(decision) ? params.projectId : params.projectId);',
      'String(decision.allowed)',
    ],
    [
      'const decision = { id: params.projectId }; await requirePublishedProject(decision.id);',
      'JSON.stringify(decision)',
    ],
  ])('preserves readonly, one-part and primitive snapshots: %s', async (before, header) => {
    const compiled = await compile(before, header);

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('keeps a primitive snapshot after the guard outside the envelope ordering', async () => {
    const compiled = await compile(
      'const decision = { allowed: false }; const project = await requirePublishedProject(params.projectId); decision.allowed = project.title.length > 0; const allowed = decision.allowed;',
      'String(allowed)',
    );

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain('runs before `next` for each request');
  });
});
