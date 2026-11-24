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
 * An object the context hands both split parts — its `params`, the context bound whole — is each
 * part's own: one the middleware writes, or hands to a call that may write it, where both bind it
 * is refused, as the guard's write would be absent from what the envelope reads.
 */

const FILE = 'app/boards/[projectId]/middleware.ts';

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A middleware of `parameters` and `body` (lines of it), with the imports a case reads. */
function middleware(parameters: string, ...body: readonly string[]): string {
  return file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { stamp } from '@/stamps';",
    '',
    `export default (async (${parameters}, next) => {`,
    ...body.map((line) => `  ${line}`),
    '}) satisfies RouteMiddleware<{ projectId: string }>;',
  );
}

const BUSY = "if (params.projectId === 'busy') return new Response('busy', { status: 503 });";
const WRITE = "(params as Record<string, string>).title = 'from the guard';";
const READ = "response.headers.set('X-Title', String((params as Record<string, string>).title));";
const HANDED = 'an object the context hands both the guard';

const CASES = [
  {
    what: 'params the guard writes and the envelope reads',
    text: middleware(
      '{ params }',
      BUSY,
      WRITE,
      'const response = await next();',
      READ,
      'return response;',
    ),
    marker: 'params }',
    reason: HANDED,
  },
  {
    what: 'params the guard hands to a call that may write it',
    text: middleware(
      '{ params }',
      BUSY,
      'stamp(params as Record<string, string>);',
      'const response = await next();',
      READ,
      'return response;',
    ),
    marker: 'params }',
    reason: HANDED,
  },
  {
    what: 'params bound by another name, written by the guard',
    text: middleware(
      '{ params: held }',
      "if (held.projectId === 'busy') return new Response('busy', { status: 503 });",
      "(held as Record<string, string>).title = 'from the guard';",
      'const response = await next();',
      "response.headers.set('X-Title', String((held as Record<string, string>).title));",
      'return response;',
    ),
    marker: 'held }',
    reason: HANDED,
  },
  {
    what: 'the context bound whole, its params written by the guard',
    text: middleware(
      'context',
      "if (context.params.projectId === 'busy') return new Response('busy', { status: 503 });",
      "(context.params as Record<string, string>).title = 'from the guard';",
      'const response = await next();',
      "response.headers.set('X-Title', String((context.params as Record<string, string>).title));",
      'return response;',
    ),
    marker: 'context, next',
    reason: HANDED,
  },
  {
    what: 'params both parts only read',
    text: middleware(
      '{ params }',
      BUSY,
      'const response = await next();',
      "response.headers.set('X-Project', params.projectId);",
      'return response;',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'params the guard alone binds and writes',
    text: middleware(
      '{ params }',
      BUSY,
      WRITE,
      "if ((params as Record<string, string>).title !== 'from the guard') return new Response(null, { status: 404 });",
      'const response = await next();',
      "response.headers.set('X-Static', 'yes');",
      'return response;',
    ),
    marker: undefined,
    reason: undefined,
  },
  {
    what: 'the context bound whole, both parts only read',
    text: middleware(
      'context',
      "if (context.params.projectId === 'busy') return new Response('busy', { status: 503 });",
      'const response = await next();',
      "response.headers.set('X-Project', context.params.projectId);",
      'return response;',
    ),
    marker: undefined,
    reason: undefined,
  },
] as const;

describe('an object the context hands each split part', () => {
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
    const app = await application({
      [FILE]: text,
      'stamps.ts': file(
        'export function stamp(value: Record<string, string>): void {',
        "  value.title = 'from the guard';",
        '}',
      ),
    });
    apps.push(app);
    const compiled = compiledApp(app, api);
    const found = compiled.refusals.map((refusal) => {
      return {
        fileName: refusal.fileName,
        at: [refusal.line, refusal.column],
        reason: refusal.reason.includes(reason),
      };
    });
    const at = marker === undefined ? undefined : positionOf(text, marker);
    const expected =
      at === undefined ? [] : [{ fileName: FILE, at: [at.line, at.column], reason: true }];

    expect(found).toStrictEqual(expected);
  });
});
