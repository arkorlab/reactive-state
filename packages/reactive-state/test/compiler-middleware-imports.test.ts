import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Compiled, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  removed,
} from './fixtures/application.ts';

/** A middleware's source import form retains module evaluation when a part names only its types. */

const SOURCE = 'app/boards/[projectId]/middleware.ts';
const GENERATED = 'middleware/app/boards/[projectId]';
const INITIALIZATION = {
  'startup-state.ts': 'export const state = { ready: false };\n',
  'startup.ts': [
    "import { state } from '@/startup-state';",
    'state.ready = true;',
    'export default class Startup {}',
    'export { Startup };',
    'export interface Shape {}',
  ].join('\n'),
  'startup-check.ts': [
    "import { state } from '@/startup-state';",
    "export function initialization(_value: unknown): string { return state.ready ? 'ready' : 'missing'; }",
  ].join('\n'),
};

interface Imported {
  readonly declaration: string;
  readonly type: string;
}

const RUN_TIME_IMPORTS: readonly Imported[] = [
  { declaration: "import { Startup } from '@/startup';", type: 'Startup' },
  { declaration: "import Startup from '@/startup';", type: 'Startup' },
  { declaration: "import * as Startup from '@/startup';", type: 'Startup.Startup' },
  { declaration: "import { type Startup } from '@/startup';", type: 'Startup' },
];

const ORDERED_IMPORTS = [
  {
    description: 'an erased import before the first runtime import',
    declarations: [
      "import type { Shape } from '@/startup';",
      "import { initialization } from '@/startup-check';",
      "import { Startup } from '@/startup';",
    ],
    type: 'Shape | Startup',
    expected: 'missing',
  },
  {
    description: 'an erased import before duplicate runtime imports',
    declarations: [
      "import type { Shape } from '@/startup';",
      "import { initialization } from '@/startup-check';",
      "import Startup from '@/startup';",
      "import { Startup as Again } from '@/startup';",
    ],
    type: 'Shape | Startup | Again',
    expected: 'missing',
  },
  {
    description: 'an earlier runtime import with an unselected binding',
    declarations: [
      "import { Startup as unused } from '@/startup';",
      "import { initialization } from '@/startup-check';",
      "import { Startup } from '@/startup';",
    ],
    type: 'Startup',
    expected: 'ready',
  },
  {
    description: 'an earlier runtime import of the same file through another specifier',
    declarations: [
      "import { Startup as unused } from '@/startup';",
      "import { initialization } from '@/startup-check';",
      "import { Startup } from '@/startup.ts';",
    ],
    type: 'Startup',
    expected: 'ready',
  },
  {
    description: 'an inline type import that evaluates the module first',
    declarations: [
      "import { type Shape } from '@/startup';",
      "import { initialization } from '@/startup-check';",
      "import { Startup } from '@/startup';",
    ],
    type: 'Shape | Startup',
    expected: 'ready',
  },
  {
    description: 'an explicit type-only import with no runtime import',
    declarations: [
      "import type { Shape } from '@/startup';",
      "import { initialization } from '@/startup-check';",
    ],
    type: 'Shape',
    expected: 'missing',
  },
] as const;

function middleware(
  imported: Imported,
  side: 'guard' | 'envelope',
  declarations: readonly string[] = [
    imported.declaration,
    "import { initialization } from '@/startup-check';",
  ],
): string {
  const typed = `  const typed: ${imported.type} | undefined = undefined;`;
  return [
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    ...declarations,
    '',
    'export default (async (_context, next) => {',
    ...(side === 'guard'
      ? [
          typed,
          "  if (initialization(typed) !== 'ready') return new Response('missing', { status: 503 });",
        ]
      : []),
    '  const response = await next();',
    ...(side === 'envelope'
      ? [typed, "  response.headers.set('X-Startup', initialization(typed));"]
      : []),
    '  return response;',
    '}) satisfies RouteMiddleware;',
  ].join('\n');
}

/** Loads one generated part in a fresh process, so only its retained imports initialize the fixture. */
function ran(app: Application, side: 'guard' | 'envelope'): string {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const part = path.join(app.out, `${GENERATED}.${side === 'guard' ? 'guard.mts' : 'envelope.ts'}`);
  const result = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const part = await import(${JSON.stringify(part)});`,
      ...(side === 'guard'
        ? [
            'const answer = await part.guard();',
            "const value = answer === undefined ? 'ready' : answer.body;",
          ]
        : [
            'const response = new Response();',
            'await part.after({}, response);',
            "const value = response.headers.get('X-Startup');",
          ]),
      'process.stdout.write(JSON.stringify(value));',
    ].join('\n'),
    app.root,
  );

  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout) as string;
}

/** The source middleware's result in its own process, with the same module initialization fixture. */
function ranSource(app: Application, side: 'guard' | 'envelope'): string {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const result = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const part = await import(${JSON.stringify(path.join(app.src, SOURCE))});`,
      "const response = await part.default({}, async () => new Response('ready'));",
      `const value = ${side === 'guard' ? 'await response.text()' : "response.headers.get('X-Startup')"};`,
      'process.stdout.write(JSON.stringify(value));',
    ].join('\n'),
    app.root,
  );

  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  return JSON.parse(result.stdout) as string;
}

describe('route middleware imports named only by types', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) {
      await removed(app);
    }
  });

  async function compiledWith(
    source: string,
    files: Readonly<Record<string, string>> = {},
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application({ ...INITIALIZATION, ...files, [SOURCE]: source });
    apps.push(app);
    return { app, compiled: compiledApp(app, api) };
  }

  describe.each(['guard', 'envelope'] as const)('the %s imports', (side) => {
    it.each(ORDERED_IMPORTS)(
      'preserves module evaluation order for $description',
      async (ordered) => {
        const imported = { declaration: ordered.declarations.join('\n'), type: ordered.type };
        const { app, compiled } = await compiledWith(
          middleware(imported, side, ordered.declarations),
          {
            'startup-check.ts': [
              "import { state } from '@/startup-state';",
              'const ready = state.ready;',
              "export function initialization(_value: unknown): string { return ready ? 'ready' : 'missing'; }",
            ].join('\n'),
          },
        );

        expect(compiled.refusals).toStrictEqual([]);

        writeOutputs(compiled.outputs, app.out);

        expect(ranSource(app, side)).toBe(ordered.expected);
        expect(ran(app, side)).toBe(ordered.expected);
      },
    );

    it.each(RUN_TIME_IMPORTS)(
      `evaluates a source import in the ${side}: $declaration`,
      async (imported) => {
        const { app, compiled } = await compiledWith(middleware(imported, side));

        expect(compiled.refusals).toStrictEqual([]);

        writeOutputs(compiled.outputs, app.out);

        expect(ran(app, side)).toBe('ready');
      },
    );

    it(`erases an explicit import type in the ${side}`, async () => {
      const imported = {
        declaration: "import type { Startup } from '@/startup';",
        type: 'Startup',
      };
      const { app, compiled } = await compiledWith(middleware(imported, side));

      expect(compiled.refusals).toStrictEqual([]);

      const part = output(
        compiled,
        app,
        `${GENERATED}.${side === 'guard' ? 'guard.mts' : 'envelope.ts'}`,
      );

      expect(part).toContain(imported.declaration);

      writeOutputs(compiled.outputs, app.out);

      expect(ran(app, side)).toBe('missing');
    });
  });

  describe.each([
    { side: 'guard', specifier: 'next/server', exported: 'NextRequest', type: 'Startup' },
    {
      side: 'envelope',
      specifier: '@arkorlab/reactive-state/server',
      exported: 'currentUser',
      type: 'typeof Startup',
    },
  ] as const)('imports from the other side in the $side', ({ side, specifier, exported, type }) => {
    it.each(['value', 'inline type'] as const)(
      `refuses a %s import whose evaluation cannot run in the ${side}`,
      async (form) => {
        const imported = {
          declaration: `import { ${form === 'inline type' ? 'type ' : ''}${exported} as Startup } from '${specifier}';`,
          type,
        };
        const { compiled } = await compiledWith(middleware(imported, side));

        expect(compiled.refusals.map((refusal) => refusal.reason)).toStrictEqual([
          expect.stringContaining('Use `import type`'),
        ]);
      },
    );

    it(`keeps an explicit import type from the other side erased in the ${side}`, async () => {
      const imported = {
        declaration: `import type { ${exported} as Startup } from '${specifier}';`,
        type,
      };
      const { app, compiled } = await compiledWith(middleware(imported, side));

      expect(compiled.refusals).toStrictEqual([]);

      const part = output(
        compiled,
        app,
        `${GENERATED}.${side === 'guard' ? 'guard.mts' : 'envelope.ts'}`,
      );

      expect(part).toContain(imported.declaration);

      writeOutputs(compiled.outputs, app.out);

      expect(ran(app, side)).toBe('missing');
    });
  });
});
