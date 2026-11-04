import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  output,
  refusalOf,
  removed,
} from './fixtures/application.ts';

/** Indirect root imports retain the same route and guard checks as direct root imports. */

const MIDDLEWARE = `import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async (_context, next) => {
  await requireUser();
  return await next();
}) satisfies RouteMiddleware;
`;

const WRAPPER = sourceFile(
  "import PublicBoard from '@/components/public-board.reactive';",
  'export default function BoardFrame({ projectId }: { projectId: string }) {',
  '  return <PublicBoard projectId={projectId} />;',
  '}',
);

interface Indirect {
  readonly what: string;
  readonly imported: string;
  readonly tag?: string;
  readonly files: Readonly<Record<string, string>>;
}

const INDIRECT: readonly Indirect[] = [
  {
    what: 'an ordinary default component',
    imported: "import BoardFrame from '@/controls/board-frame';",
    files: { 'controls/board-frame.tsx': WRAPPER },
  },
  {
    what: 'an ordinary named component',
    imported: "import { BoardFrame } from '@/controls/board-frame';",
    files: { 'controls/board-frame.tsx': WRAPPER.replace('export default', 'export') },
  },
  {
    what: 'a default barrel export',
    imported: "import BoardFrame from '@/controls/board-frame';",
    files: {
      'controls/board-frame.ts': "export { default } from '@/components/public-board.reactive';\n",
    },
  },
  {
    what: 'a named barrel export',
    imported: "import { BoardFrame } from '@/controls/board-frame';",
    files: {
      'controls/board-frame.ts':
        "export { default as BoardFrame } from '@/components/public-board.reactive';\n",
    },
  },
  {
    what: 'a transitive namespace barrel',
    imported: "import * as Frames from '@/controls/board-frame';",
    tag: 'Frames.BoardFrame',
    files: {
      'controls/board-frame.ts': "export * from '@/controls/board-exports';\n",
      'controls/board-exports.ts':
        "export { default as BoardFrame } from '@/components/public-board.reactive';\n",
    },
  },
  {
    what: 'a cycle of local barrels',
    imported: "import { BoardFrame } from '@/controls/board-frame';",
    files: {
      'controls/board-frame.ts':
        "export * from '@/controls/board-cycle';\nexport { default as BoardFrame } from '@/controls/board-wrapper';\n",
      'controls/board-cycle.ts': "export * from '@/controls/board-frame';\n",
      'controls/board-wrapper.tsx': WRAPPER,
    },
  },
];

/** A page whose root is reached through an ordinary module, outside the registered page grammar. */
function page(imported: string, tag = 'BoardFrame'): string {
  const element = '<BoardFrame projectId={projectId} />'.replace('BoardFrame', () => tag);
  return sourceFile(
    imported,
    'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
    '  const { projectId } = await params;',
    `  return ${element};`,
    '}',
  );
}

/** An application's source lines, with a final newline as a source file has. */
function sourceFile(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('guard association for indirectly reached reactive roots', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    for (const app of apps) await removed(app);
    api[Symbol.dispose]();
  });

  async function compiledWith(files: Readonly<Record<string, string>>, keepBoard = false) {
    const app = await application(files);
    apps.push(app);
    if (!keepBoard) await rm(path.join(app.src, 'app/boards'), { recursive: true });
    return { app, compiled: compiledApp(app, api) };
  }

  it.each(INDIRECT)('refuses an unregistered guarded root through $what', async (indirect) => {
    const { compiled } = await compiledWith({
      ...indirect.files,
      'app/private/[projectId]/page.tsx': page(indirect.imported, indirect.tag),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });
    const refusal = refusalOf(compiled);

    expect(refusal.fileName).toBe('app/private/[projectId]/page.tsx');
    expect(refusal.reason).toContain('`components/public-board`');
    expect(refusal.reason).toContain('the guard would be left out where the root renders');
  });

  it('refuses an indirectly reached root owned by a different middleware chain', async () => {
    const { compiled } = await compiledWith(
      {
        'controls/board-frame.tsx': WRAPPER,
        'app/private/[projectId]/page.tsx': page(
          "import BoardFrame from '@/controls/board-frame';",
        ),
        'app/private/[projectId]/middleware.ts': MIDDLEWARE,
      },
      true,
    );

    expect(refusalOf(compiled).reason).toContain('rendered under two chains of route middleware');
  });

  it('refuses an unregistered guarded root through a literal dynamic module load', async () => {
    const { compiled } = await compiledWith({
      'controls/board-frame.tsx': WRAPPER,
      'app/private/[projectId]/page.tsx': sourceFile(
        'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
        '  const { projectId } = await params;',
        "  const { default: BoardFrame } = await import('@/controls/board-frame');",
        '  return <BoardFrame projectId={projectId} />;',
        '}',
      ),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(refusalOf(compiled).reason).toContain(
      'the guard would be left out where the root renders',
    );
  });

  it('preserves an indirect root under no middleware', async () => {
    const { app, compiled } = await compiledWith({
      'controls/board-frame.tsx': WRAPPER,
      'app/private/[projectId]/page.tsx': page("import BoardFrame from '@/controls/board-frame';"),
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/public-board.root.tsx')).not.toContain('route:');
  });

  it('preserves the canonical guarded registration and its nested reactive components', async () => {
    const { app, compiled } = await compiledWith({
      'app/private/[projectId]/page.tsx': page(
        "import BoardFrame from '@/components/public-board.reactive';",
      ),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/public-board.root.tsx')).toContain(
      'route: "/private/[projectId]"',
    );
  });

  it('preserves an indirect render of a root already registered under the same middleware', async () => {
    const { app, compiled } = await compiledWith(
      {
        'controls/board-frame.tsx': WRAPPER,
        'app/boards/demo/page.tsx': `import BoardFrame from '@/controls/board-frame';
export default function Demo() { return <BoardFrame projectId="p1" />; }
`,
        'app/boards/middleware.ts': MIDDLEWARE,
      },
      true,
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/public-board.root.tsx')).toContain(
      'route: "/boards/[projectId]"',
    );
  });

  it('ignores roots imported only as types by an ordinary local component', async () => {
    const { compiled } = await compiledWith({
      'controls/board-frame.tsx': sourceFile(
        "import type PublicBoard from '@/components/public-board.reactive';",
        'type Props = Parameters<typeof PublicBoard>[0];',
        'export default function BoardFrame({ projectId }: Props) { return <p>{projectId}</p>; }',
      ),
      'app/private/[projectId]/page.tsx': page("import BoardFrame from '@/controls/board-frame';"),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('ignores an all-type named import from a barrel that exports a reactive root', async () => {
    const { compiled } = await compiledWith({
      'controls/board-frame.ts': `export { default as BoardFrame } from '@/components/public-board.reactive';
export type Props = { projectId: string };
`,
      'app/private/[projectId]/page.tsx': `import { type Props } from '@/controls/board-frame';
export default function Page() { return <p>ordinary page</p>; }
`,
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it.each([
    "import { type default as PublicBoard } from '@/components/public-board.reactive';",
    "export { type default as PublicBoard } from '@/components/public-board.reactive';",
  ])('ignores a nested named type-only declaration: %s', async (declaration) => {
    const { compiled } = await compiledWith({
      'controls/board-frame.tsx': sourceFile(
        declaration,
        'export default function BoardFrame({ projectId }: { projectId: string }) {',
        '  return <p>{projectId}</p>;',
        '}',
      ),
      'app/private/[projectId]/page.tsx': page("import BoardFrame from '@/controls/board-frame';"),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('ignores a nested type-only path through a barrel with a value export', async () => {
    const { compiled } = await compiledWith({
      'controls/board-exports.ts': sourceFile(
        "export { default as PublicBoard } from '@/components/public-board.reactive';",
        'export type Props = { projectId: string };',
      ),
      'controls/board-frame.tsx': sourceFile(
        "import { type Props } from '@/controls/board-exports';",
        'export default function BoardFrame({ projectId }: Props) { return <p>{projectId}</p>; }',
      ),
      'app/private/[projectId]/page.tsx': page("import BoardFrame from '@/controls/board-frame';"),
      'app/private/[projectId]/middleware.ts': MIDDLEWARE,
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it.each([
    "import '@/controls/side-effect';",
    "export {} from '@/controls/side-effect';",
    "import { type Thing } from '@/controls/side-effect';",
    "export { type Thing } from '@/controls/side-effect';",
  ])('retains the effects of a runtime module declaration: %s', async (declaration) => {
    const { app, compiled } = await compiledWith({
      'controls/side-effect.ts':
        'export type Thing = string;\nexport const sampled = Date.now();\n',
      'controls/board-frame.ts': `${declaration}\nexport const label = 'board';\n`,
      'app/private/[projectId]/page.tsx': page(
        "import BoardFrame from '@/components/public-board.reactive';\nimport { label } from '@/controls/board-frame';",
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'routes.ts')).toContain('reads `Date`');
  });
});
