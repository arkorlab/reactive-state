import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  positionOf,
  removed,
} from './fixtures/application.ts';

/**
 * A default of the context's pattern that the guard and the envelope each bind — where each reads a
 * name it holds, the same or another — is computed by each: one they cannot compute alike is
 * refused, as one of a name both read is.
 */

const FILE = 'app/boards/[projectId]/middleware.ts';

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A middleware binding `pattern`, its guard reading `guarded`, its envelope `header` after `next`. */
function middleware(
  pattern: string,
  guarded: string,
  header: string,
  ...imports: readonly string[]
): string {
  return file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { requirePublishedProject } from '@/publication';",
    ...imports,
    '',
    `export default (async (${pattern}, next) => {`,
    `  await requirePublishedProject(${guarded});`,
    '  const response = await next();',
    `  response.headers.set('X-Nonce', ${header});`,
    '  return response;',
    '}) satisfies RouteMiddleware<{ projectId: string; absent?: string; nonce?: string }>;',
  );
}

/** A middleware binding `pattern`, whose guard runs `guarded` of the project, its envelope `header`. */
function written(pattern: string, guarded: string, header: string): string {
  return file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { requirePublishedProject } from '@/publication';",
    '',
    `export default (async (${pattern}, next) => {`,
    '  const project = await requirePublishedProject(projectId);',
    `  ${guarded}`,
    '  const response = await next();',
    `  response.headers.set('X-Nonce', ${header});`,
    '  return response;',
    '}) satisfies RouteMiddleware<{ projectId: string; decision?: { allowed: boolean }; ids?: string[]; pair?: { decision: { allowed: boolean } } }>;',
  );
}

const WRITTEN = "A default of the context's pattern, `";

const NONCES = file(
  'export function makeNoncePair(): { guardNonce: string; headerNonce: string } {',
  '  const nonce = crypto.randomUUID();',
  '  return { guardNonce: nonce, headerNonce: nonce };',
  '}',
);

const REASON = '`guardNonce`, `headerNonce`, read by the guard';

const CASES = [
  {
    what: 'the finding’s factory, imported, each part binds by a name of its own',
    text: middleware(
      '{ params: { absent: { guardNonce, headerNonce } = makeNoncePair() } }',
      'guardNonce',
      'headerNonce',
      "import { makeNoncePair } from '@/nonces';",
    ),
    marker: 'makeNoncePair() }',
    reason: REASON,
  },
  {
    what: 'a default of a global each part binds by a name of its own',
    text: middleware(
      "{ params: { absent: { guardNonce, headerNonce } = { guardNonce: crypto.randomUUID(), headerNonce: '' } } }",
      'guardNonce',
      'headerNonce',
    ),
    marker: '{ guardNonce: crypto',
    reason: REASON,
  },
  {
    what: 'one nonce of a global each part binds by a name of its own',
    text: middleware(
      '{ params: { absent: { guardNonce, headerNonce } = ((nonce: string) => ({ guardNonce: nonce, headerNonce: nonce }))(crypto.randomUUID()) } }',
      'guardNonce',
      'headerNonce',
    ),
    marker: '((nonce',
    reason: REASON,
  },
  {
    what: 'an array default each part binds by a name of its own',
    text: middleware(
      '{ params: { absent: [guardStamp, headerStamp] = [String(Date.now()), String(Date.now())] } }',
      'guardStamp',
      'headerStamp',
    ),
    marker: '[String(Date.now())',
    reason: '`guardStamp`, `headerStamp`, read by the guard',
  },
  {
    what: 'a default within another each part binds by a name of its own',
    text: middleware(
      "{ params: { absent: { pair: { guardNonce, headerNonce } = { guardNonce: crypto.randomUUID(), headerNonce: '' } } = {} } }",
      'guardNonce',
      'headerNonce',
    ),
    marker: '{ guardNonce: crypto',
    reason: REASON,
  },
  {
    what: 'a default of a name both parts read',
    text: middleware('{ params: { nonce = crypto.randomUUID() } }', 'nonce', 'nonce'),
    marker: 'crypto.randomUUID()',
    reason: '`nonce`, read by the guard',
  },
  {
    what: 'a default the guard alone binds',
    text: middleware(
      "{ params: { projectId, absent: { guardNonce, headerNonce } = { guardNonce: crypto.randomUUID(), headerNonce: '' } } }",
      'guardNonce + headerNonce',
      'projectId',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'a default of literals each part binds',
    text: middleware(
      "{ params: { absent: { guardNonce, headerNonce } = { guardNonce: 'g', headerNonce: 'h' } } }",
      'guardNonce',
      'headerNonce',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'a default of the params each part binds',
    text: middleware(
      '{ params: { projectId, absent: { guardNonce, headerNonce } = { guardNonce: projectId, headerNonce: projectId + "-header" } } }',
      'guardNonce',
      'headerNonce',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'an object default both parts bind and the guard writes',
    text: written(
      '{ params: { projectId, decision = { allowed: false } } }',
      'decision.allowed = project.title.length > 0;',
      'String(decision.allowed)',
    ),
    marker: 'decision =',
    reason: WRITTEN,
  },
  {
    what: 'an array default both parts bind and the guard pushes to',
    text: written(
      '{ params: { projectId, ids = [projectId] } }',
      'ids.push(project.id);',
      "ids.join(',')",
    ),
    marker: 'ids =',
    reason: WRITTEN,
  },
  {
    what: 'a collection a pattern’s default holds that both parts bind and the guard writes',
    text: written(
      '{ params: { projectId, pair: { decision } = { decision: { allowed: false } } } }',
      'decision.allowed = project.title.length > 0;',
      'String(decision.allowed)',
    ),
    marker: 'decision }',
    reason: WRITTEN,
  },
  {
    what: 'an object default both parts bind and only read',
    text: written(
      '{ params: { projectId, decision = { allowed: false } } }',
      'const allowed = project.title.length > 0 && decision.allowed;',
      'String(decision.allowed)',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'an object default the guard alone binds and writes',
    text: written(
      '{ params: { projectId, decision = { allowed: false } } }',
      'decision.allowed = project.title.length > 0; if (!decision.allowed) return new Response(null, { status: 404 });',
      'projectId',
    ),
    marker: undefined,
    reason: undefined,
  },
] as const;

describe('a default of the context’s pattern each split part binds', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const each of apps) {
      await removed(each);
    }
  });

  it.each(CASES)('$what', async ({ text, marker, reason = '' }) => {
    const app = await application({ [FILE]: text, 'nonces.ts': NONCES });
    apps.push(app);
    const compiled = compiledApp(app, api);
    const found = compiled.refusals.map((refusal) => {
      return {
        fileName: refusal.fileName,
        at: [refusal.line, refusal.column],
        reason: refusal.reason.startsWith(reason),
      };
    });
    const at = marker === undefined ? undefined : positionOf(text, marker);
    const expected =
      at === undefined ? [] : [{ fileName: FILE, at: [at.line, at.column], reason: true }];

    expect(found).toStrictEqual(expected);
  });
});
