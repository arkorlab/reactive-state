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
 * A middleware inside one with a guard binds its context's defaults where the host runs its part
 * before `next`, ahead of that guard: one that may throw or have an effect is refused there, as a
 * statement is; one of literals, functions, names bound before it and imports is not.
 */

const PARENT = 'app/boards/[projectId]/middleware.ts';
const CHILD = 'app/boards/[projectId]/stats/middleware.ts';

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A guard over the board's routes, of its published project. */
const GUARD = file(
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  "import { requirePublishedProject } from '@/publication';",
  '',
  'export default (async ({ params }, next) => {',
  '  await requirePublishedProject(params.projectId);',
  '  return next();',
  '}) satisfies RouteMiddleware<{ projectId: string }>;',
);

/** A middleware around the board's routes of no guard: what it runs before `next` is its envelope's. */
const ENVELOPE = file(
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  '',
  'export default (async (_context, next) => {',
  '  const response = await next();',
  "  response.headers.set('X-Board', 'yes');",
  '  return response;',
  '}) satisfies RouteMiddleware;',
);

/** A middleware binding `pattern` of its context, reading `read` of it after `next` alone. */
function child(pattern: string, read: string, ...imports: readonly string[]): string {
  return file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    ...imports,
    '',
    `export default (async (${pattern}, next) => {`,
    '  const response = await next();',
    `  response.headers.set('X-Read', String(${read}));`,
    '  return response;',
    '}) satisfies RouteMiddleware<{ projectId: string; missing?: string; tenant?: string }>;',
  );
}

const REASON = "of the context's pattern, is bound before `next` for each request";

const CASES = [
  {
    what: 'a default that throws',
    parent: GUARD,
    text: child("{ params: { missing = JSON.parse('bad') } }", 'missing'),
    marker: "JSON.parse('bad')",
  },
  {
    what: 'a default of a global’s call',
    parent: GUARD,
    text: child('{ params: { tenant = crypto.randomUUID() } }', 'tenant'),
    marker: 'crypto.randomUUID()',
  },
  {
    what: 'a default calling a method of a param',
    parent: GUARD,
    text: child('{ params: { projectId, tenant = projectId.trim() } }', 'tenant'),
    marker: 'projectId.trim()',
  },
  {
    what: 'a default of an import’s call',
    parent: GUARD,
    text: child(
      '{ params: { tenant = fallbackTenant() } }',
      'tenant',
      "import { fallbackTenant } from '@/defaults';",
    ),
    marker: 'fallbackTenant()',
  },
  {
    what: 'a default of an object holding a call',
    parent: GUARD,
    text: child('{ params: { projectId } = { projectId: String(Date.now()) } }', 'projectId'),
    marker: '{ projectId: String(Date.now()) }',
  },
  {
    what: 'a default of an operation of a BigInt',
    parent: GUARD,
    text: child('{ params: { tenant = 1n + 1 } }', 'tenant'),
    marker: '1n + 1',
  },
  {
    what: 'a default of a name the pattern binds after it',
    parent: GUARD,
    text: child('{ params: { tenant = missing, missing } }', 'tenant + missing'),
    marker: 'missing,',
  },
  {
    what: 'a literal default',
    parent: GUARD,
    text: child("{ params: { missing = 'none' } }", 'missing'),
    marker: undefined,
  },
  {
    what: 'a default of a name bound before it and a literal',
    parent: GUARD,
    text: child("{ params: { projectId, tenant = projectId + '-default' } }", 'tenant'),
    marker: undefined,
  },
  {
    what: 'a template of names bound before it',
    parent: GUARD,
    text: child(`{ params: { projectId, tenant = \`\${projectId}-\${projectId}\` } }`, 'tenant'),
    marker: undefined,
  },
  {
    what: 'a default of an import',
    parent: GUARD,
    text: child(
      '{ params: { tenant = DEFAULT_TENANT } }',
      'tenant',
      "import { DEFAULT_TENANT } from '@/defaults';",
    ),
    marker: undefined,
  },
  {
    what: 'a default of a literal object',
    parent: GUARD,
    text: child("{ params: { projectId } = { projectId: 'none' } }", 'projectId'),
    marker: undefined,
  },
  {
    what: 'a default of a function',
    parent: GUARD,
    text: child("{ params: { tenant = (() => 'main') as unknown as string } }", 'tenant'),
    marker: undefined,
  },
  {
    what: 'a default that throws under a middleware of no guard',
    parent: ENVELOPE,
    text: child("{ params: { missing = JSON.parse('bad') } }", 'missing'),
    marker: undefined,
  },
  {
    what: 'a default that throws read only by the guard’s own part',
    parent: GUARD,
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      "export default (async ({ params: { missing = JSON.parse('bad') } }, next) => {",
      '  await requirePublishedProject(missing);',
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string; missing?: string }>;',
    ),
    marker: undefined,
  },
  {
    what: 'an operation of a name a BigInt defaults',
    parent: GUARD,
    text: child('{ params: { missing = 1n, tenant = missing + 1 } }', 'tenant'),
    marker: 'missing + 1',
  },
  {
    what: 'a sign taken of a name a BigInt defaults',
    parent: GUARD,
    text: child('{ params: { seed = 1n, header = +seed } }', 'header'),
    marker: '+seed',
  },
  {
    what: 'an operation of a name an object defaults',
    parent: GUARD,
    text: child('{ params: { missing = { valueOf: () => 1 }, tenant = missing + 1 } }', 'tenant'),
    marker: 'missing + 1',
  },
  {
    what: 'an operation of a name an import defaults',
    parent: GUARD,
    text: child(
      "{ params: { missing = MARKER, tenant = missing + '' } }",
      'tenant',
      "import { MARKER } from '@/defaults';",
    ),
    marker: "missing + ''",
  },
  {
    what: 'an operation of a name a pattern’s default holds',
    parent: GUARD,
    text: child('{ params: { missing: { id } = { id: 1n }, tenant = id + 1 } }', 'tenant'),
    marker: 'id + 1',
  },
  {
    what: 'an operation of a name a literal defaults',
    parent: GUARD,
    text: child("{ params: { missing = 'x', tenant = missing + '-y' } }", 'tenant'),
    marker: undefined,
  },
  {
    what: 'a name an import or a BigInt defaults, read whole',
    parent: GUARD,
    text: child(
      '{ params: { missing = MARKER, tenant = missing, projectId = 1n, other = projectId } }',
      'String(tenant) + String(other)',
      "import { MARKER } from '@/defaults';",
    ),
    marker: undefined,
  },
  {
    what: 'an operation of the request',
    parent: GUARD,
    text: child("{ request, params: { tenant = request + '' } }", 'tenant'),
    marker: undefined,
  },
  {
    what: 'a pattern taking apart a param that may be absent',
    parent: GUARD,
    text: child('{ params: { missing: { length } } }', 'length'),
    marker: '{ length }',
  },
  {
    what: 'an array pattern taking apart a param that may be absent',
    parent: GUARD,
    text: child('{ params: { missing: [first] } }', 'first'),
    marker: '[first]',
  },
  {
    what: 'an array pattern of an object default',
    parent: GUARD,
    text: child('{ params: { missing: [first] = {} } }', 'first'),
    marker: '[first]',
  },
  {
    what: 'a pattern taking apart a member of the request',
    parent: GUARD,
    text: child('{ request: { body: { locked } = {} } }', 'locked'),
    marker: '{ locked }',
  },
  {
    what: 'a pattern within a pattern of a param',
    parent: GUARD,
    text: child("{ params: { missing: { length: { toFixed } } = '' } }", 'toFixed'),
    marker: '{ toFixed }',
  },
  {
    what: 'an array pattern of a param given a list',
    parent: GUARD,
    text: child('{ params: { missing: [first] = [] } }', 'first'),
    marker: undefined,
  },
  {
    what: 'a pattern of a param given text',
    parent: GUARD,
    text: child("{ params: { missing: { length } = '' } }", 'length'),
    marker: undefined,
  },
  {
    what: 'a pattern of a param given an object',
    parent: GUARD,
    text: child("{ params: { missing: { id } = { id: 'x' } } }", 'id'),
    marker: undefined,
  },
  {
    what: 'a sign taken of a pattern’s own undefined',
    parent: GUARD,
    text: child('{ params: { undefined = 1n, header = +undefined } }', 'header'),
    marker: '+undefined',
  },
  {
    what: 'a read of a pattern’s undefined before it is bound',
    parent: GUARD,
    text: child('{ params: { header = undefined, undefined } }', 'header'),
    marker: 'undefined,',
  },
  {
    what: 'a sign taken of the global undefined',
    parent: GUARD,
    text: child('{ params: { header = +undefined } }', 'header'),
    marker: undefined,
  },
  {
    what: 'a sign taken of a pattern’s undefined of no default',
    parent: GUARD,
    text: child('{ params: { undefined, header = +undefined } }', 'header'),
    marker: undefined,
  },
  {
    what: 'a pattern of a param given an object of the request’s prototype',
    parent: GUARD,
    text: child(
      '{ request, params: { missing: { headers } = { __proto__: request } } }',
      'headers',
    ),
    marker: '{ headers }',
  },
  {
    what: 'a pattern of a param given an object of an import’s prototype',
    parent: GUARD,
    text: child(
      "{ params: { missing: { id } = { '__proto__': HOLDER } } }",
      'id',
      "import { HOLDER } from '@/defaults';",
    ),
    marker: '{ id }',
  },
  {
    what: 'a pattern of a param given an object of its own data',
    parent: GUARD,
    text: child("{ params: { missing: { id, other } = { id: 'x', other: 'y' } } }", 'id + other'),
    marker: undefined,
  },
  {
    what: 'a key computed of an import',
    parent: GUARD,
    text: child('{ params: { [KEY]: tenant } }', 'tenant', "import { KEY } from '@/defaults';"),
    marker: 'KEY]',
  },
  {
    what: 'a key computed of an object',
    parent: GUARD,
    text: child(
      "{ params: { [{ toString: () => 'tenant' } as unknown as string]: tenant } }",
      'tenant',
    ),
    marker: '{ toString',
  },
  {
    what: 'a key written as text in brackets',
    parent: GUARD,
    text: child("{ params: { ['tenant']: tenant } }", 'tenant'),
    marker: undefined,
  },
  {
    what: 'a key computed of a param',
    parent: GUARD,
    text: child('{ params: { projectId, [projectId]: tenant } }', 'tenant'),
    marker: undefined,
  },
  {
    what: 'a default of an import of a type alone',
    parent: GUARD,
    text: child(
      '{ params: { tenant = (DEFAULT_TENANT) } }',
      'tenant',
      "import type { DEFAULT_TENANT } from '@/defaults';",
    ),
    marker: '(DEFAULT_TENANT)',
  },
  {
    what: 'a default of an import named as a type alone',
    parent: GUARD,
    text: child(
      '{ params: { tenant = (DEFAULT_TENANT) } }',
      'tenant',
      "import { type DEFAULT_TENANT } from '@/defaults';",
    ),
    marker: '(DEFAULT_TENANT)',
  },
] as const;

describe('a middleware’s context defaults under a guard around it', () => {
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

  it.each(CASES)('$what', async ({ parent, text, marker }) => {
    const app = await application({
      [PARENT]: parent,
      [CHILD]: text,
      'defaults.ts': file(
        "export const DEFAULT_TENANT = 'main';",
        "export const MARKER = Symbol('marker');",
        "export const HOLDER = { get id(): string { throw new Error('read'); } };",
        "export const KEY = 'tenant';",
        "export function fallbackTenant(): string { return 'main'; }",
      ),
    });
    apps.push(app);
    const compiled = compiledApp(app, api);
    const found = compiled.refusals.map((refusal) => {
      return {
        fileName: refusal.fileName,
        at: [refusal.line, refusal.column],
        reason: refusal.reason.includes(REASON),
      };
    });
    const at = marker === undefined ? undefined : positionOf(text, marker);
    const expected =
      at === undefined ? [] : [{ fileName: CHILD, at: [at.line, at.column], reason: true }];

    expect(found).toStrictEqual(expected);
  });
});
