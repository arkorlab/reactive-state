import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const FILE = 'app/boards/[projectId]/middleware.ts';
const DENIED = "return new Response('Denied', { status: 403 });";

function middleware(body: string, parameters = '_context, next', ordinary = false): string {
  const declaration = ordinary
    ? `export default async function middleware(${parameters}) { ${body} }`
    : `export default (async (${parameters}) => { ${body} }) satisfies RouteMiddleware<{ projectId: string }>;`;
  return `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\n${declaration}\n`;
}

describe('the receiver of extracted middleware', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) await removed(app);
  });

  async function reasons(text: string): Promise<readonly string[]> {
    const app = await application({ [FILE]: text });
    apps.push(app);
    return compiledApp(app, api).refusals.map((refusal) => refusal.reason);
  }

  it.each([
    middleware(`if (typeof this === 'undefined') ${DENIED} return next();`),
    middleware(`if (typeof this === 'undefined') ${DENIED} return next();`, '_context, next', true),
    middleware(
      `const read = () => this; if (typeof read() === 'undefined') ${DENIED} return next();`,
    ),
    middleware(
      `const own = { read: () => this }; if (typeof own.read() === 'undefined') ${DENIED} return next();`,
    ),
    middleware(
      "const response = await next(); response.headers.set('X-Receiver', String(this)); return response;",
    ),
    middleware(
      `if (projectId === 'undefined') ${DENIED} return next();`,
      '{ params: { projectId = String(this) } }, next',
    ),
    middleware(
      `const rule = { [typeof this]() { return true; } }; if ('undefined' in rule) ${DENIED} return next();`,
    ),
    middleware(
      `class Rule { [typeof this] = true; } if ('undefined' in new Rule()) ${DENIED} return next();`,
    ),
    middleware(`class Rule extends (this ?? Object) {} if (!new Rule()) ${DENIED} return next();`),
  ])('refuses this inherited from the middleware invocation: %s', async (text) => {
    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('middleware-bound `this`'),
    ]);
  });

  it.each([
    `function allowed(this: { allowed: boolean }) { return this.allowed; } if (!allowed.call({ allowed: true })) ${DENIED} return next();`,
    `function allowed(this: { allowed: boolean }) { const read = () => this.allowed; return read(); } if (!allowed.call({ allowed: true })) ${DENIED} return next();`,
    `const rule = { allowed: true, read() { return this.allowed; } }; if (!rule.read()) ${DENIED} return next();`,
    `class Rule { allowed = true; read() { return this.allowed; } } if (!new Rule().read()) ${DENIED} return next();`,
    `class Rule { allowed = true; read = () => this.allowed; } if (!new Rule().read()) ${DENIED} return next();`,
    `class Rule { static allowed = true; static read() { return this.allowed; } } if (!Rule.read()) ${DENIED} return next();`,
    `const rule = { this: true }; if (!rule.this) ${DENIED} return next();`,
    `type Receiver = typeof this; const allowed = true; if (!allowed) ${DENIED} return next();`,
  ])('keeps ordinary function and class receivers and data properties: %s', async (body) => {
    await expect(reasons(middleware(body))).resolves.toStrictEqual([]);
  });
});
