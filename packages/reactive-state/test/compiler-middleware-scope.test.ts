import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/** Invocation and parameter work that extracted middleware functions must preserve. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const DENIED = "return new Response('Denied', { status: 403 });";

function guarded(condition: string): string {
  return `if (${condition}) ${DENIED} return next();`;
}

function middleware(body: string, parameters = '_context, next', form = 'arrow'): string {
  let declaration: string;
  switch (form) {
    case 'function': {
      declaration = `export default async function middleware(${parameters}) { ${body} }`;
      break;
    }
    case 'named expression': {
      declaration = `export default (async function middleware(${parameters}) { ${body} }) satisfies RouteMiddleware<{ projectId: string }>;`;
      break;
    }
    case 'expression': {
      declaration = `export default (async (${parameters}) => next()) satisfies RouteMiddleware<{ projectId: string }>;`;
      break;
    }
    default: {
      declaration = `export default (async (${parameters}) => { ${body} }) satisfies RouteMiddleware<{ projectId: string }>;`;
    }
  }
  return [
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { forbidden } from '@arkorlab/reactive-state/server';",
    "import { requirePublishedProject } from '@/publication';",
    declaration,
    '',
  ].join('\n');
}

describe('the invocation and lexical scope of extracted middleware', () => {
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
    ['function', guarded("typeof middleware === 'function'")],
    ['named expression', guarded("typeof middleware === 'function'")],
    ['function', `const own = () => middleware; ${guarded("typeof own() === 'function'")}`],
    [
      'function',
      "const response = await next(); response.headers.set('X-Self', middleware.name); return response;",
    ],
  ])('refuses the extracted function’s own name in a %s', async (form, body) => {
    const text = middleware(body, '_context, next', form);

    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('its own function name'),
    ]);
  });

  it('refuses an own function name that shadows an imported value', async () => {
    const text = `import { middleware } from '@/domain/own-function';\n${middleware(guarded("typeof middleware === 'function'"), '_context, next', 'named expression')}`;
    const app = await application({
      [FILE]: text,
      'domain/own-function.ts': "export const middleware = 'data';",
    });
    apps.push(app);

    expect(compiledApp(app, api).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('its own function name'),
    ]);
  });

  it('refuses the own name in a default outside a body-local binding', async () => {
    const text = middleware(
      `const middleware = 'data'; ${guarded("projectId === 'function'")}`,
      '{ params: { projectId = typeof middleware } }, next',
      'function',
    );

    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('its own function name'),
    ]);
  });

  it.each(['typeof next', '(() => typeof next)()'])(
    'refuses a context default whose next binding extraction removes: %s',
    async (value) => {
      const text = middleware(
        guarded("projectId === 'function'"),
        `{ params: { projectId = ${value} } }, next`,
      );

      await expect(reasons(text)).resolves.toStrictEqual([
        expect.stringContaining('context pattern reads `next`'),
      ]);
    },
  );

  it.each([
    ['middleware, next', guarded("middleware.params.projectId === 'denied'")],
    ['_context, next', `var middleware = 'data'; ${guarded("middleware === 'denied'")}`],
    ['_context, next', `const middleware = 'data'; ${guarded("middleware === 'denied'")}`],
    [
      '_context, next',
      `function read(middleware: () => number) { return middleware(); } ${guarded('read(() => 1) === 0')}`,
    ],
    [
      '_context, next',
      `const value = { middleware: 'data' }; ${guarded("value.middleware === 'denied'")}`,
    ],
  ])('keeps a function name shadowed by ordinary data: %s', async (parameters, body) => {
    await expect(reasons(middleware(body, parameters, 'function'))).resolves.toStrictEqual([]);
  });

  it.each([
    guarded('arguments.length === 2'),
    `const count = () => arguments.length; ${guarded('count() === 2')}`,
    guarded("typeof arguments[1] === 'function'"),
    `const record = { arguments }; ${guarded('record.arguments.length === 2')}`,
  ])('refuses the middleware’s own arguments read: %s', async (body) => {
    const text = middleware(body, '_context, next', 'function');

    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('middleware’s own `arguments`'),
    ]);
  });

  it('refuses an arrow inheriting arguments from its surrounding invocation', async () => {
    const text = middleware(guarded('arguments.length > 0'));

    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('middleware’s own `arguments`'),
    ]);
  });

  it.each([
    "eval('typeof next')",
    "((eval))('typeof next')",
    "(eval as typeof eval)('typeof next')",
    "(eval satisfies typeof eval)('typeof next')",
    "(eval!)('typeof next')",
    "(<typeof eval>eval)('typeof next')",
  ])('refuses a direct eval whose scope would change: %s', async (call) => {
    const text = middleware(guarded(`${call} === 'function'`));

    await expect(reasons(text)).resolves.toStrictEqual([expect.stringContaining('direct `eval`')]);
  });

  it('refuses direct eval in nested ordinary functions', async () => {
    const text = middleware(
      `function inspect() { return eval('typeof next'); } ${guarded("inspect() === 'function'")}`,
    );

    await expect(reasons(text)).resolves.toStrictEqual([expect.stringContaining('direct `eval`')]);
  });

  it('does not let an unrelated nested parameter hide a global eval call', async () => {
    const text = middleware(
      `const inspect = (eval: () => number) => eval(); void inspect; ${guarded("eval('typeof next') === 'function'")}`,
    );

    await expect(reasons(text)).resolves.toStrictEqual([expect.stringContaining('direct `eval`')]);
  });

  it.each([
    ['{ params: { tenant = forbidden() } }, next', '', 'expression'],
    ['{ request = forbidden() }, next', '', 'expression'],
    [
      '{ params: { projectId, tenant = forbidden() } }, next',
      'await requirePublishedProject(projectId); return next();',
      'arrow',
    ],
    ['{ params: { missing: { tenant } } }, next', '', 'expression'],
    ['{ request: [unused] }, next', '', 'expression'],
    [
      '{ params: { projectId, missing: { tenant } } }, next',
      'await requirePublishedProject(projectId); return next();',
      'arrow',
    ],
    ['{ params: { [forbidden()]: tenant } }, next', '', 'expression'],
    ['{ params: { optional: [first = forbidden()] } }, next', '', 'expression'],
  ])('refuses omitted parameter work: %s', async (parameters, body, form) => {
    const text = middleware(body, parameters, form);

    await expect(reasons(text)).resolves.toStrictEqual([
      expect.stringContaining('unused context binding'),
    ]);
  });

  it.each([
    `function count() { return arguments.length; } ${guarded('count(1, 2) === 2')}`,
    `const record = { count() { return arguments.length; } }; ${guarded('record.count(1, 2) === 2')}`,
    `const record = { arguments: 2 }; ${guarded('record.arguments === 2')}`,
    `const inspect = (eval: () => number) => eval(); ${guarded('inspect(() => 1) === 1')}`,
    `const record = { eval: () => 1 }; ${guarded('record.eval() === 1')}`,
    guarded("(0, eval)('1') === 1"),
    guarded("globalThis.eval('1') === 1"),
    guarded("eval?.('1') === 1"),
  ])('keeps local invocations and indirect eval intact: %s', async (body) => {
    await expect(reasons(middleware(body, '_context, next', 'function'))).resolves.toStrictEqual(
      [],
    );
  });

  it.each([
    ['{ params, request }, next', '', 'expression'],
    ["{ params: { projectId = 'fallback' } }, next", guarded("projectId === 'denied'"), 'arrow'],
    ['{ params: { projectId = forbidden() } }, next', guarded("projectId === 'denied'"), 'arrow'],
    [
      '{ params: { projectId: [first, second = crypto.randomUUID()] } }, next',
      "const response = await next(); response.headers.set('X-First', first); return response;",
      'arrow',
    ],
  ])(
    'keeps retained patterns and unused plain context names: %s',
    async (parameters, body, form) => {
      await expect(reasons(middleware(body, parameters, form))).resolves.toStrictEqual([]);
    },
  );
});
