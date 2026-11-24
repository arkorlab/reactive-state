import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Applicable layouts, templates and loading files retain their route's guard association checks. */
const SIDE_ROOT = `import { useReactiveState } from 'framework/react';
export default function Sidebar({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useReactiveState<string>(projectId);
  return <section><button onClick={() => setSelected('next')}>{String(selected)}</button></section>;
}
`;

const CASES = [
  {
    id: 'guarded-layout-unregistered-root',
    expected: true,
    files: {
      'app/boards/layout.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
    expectedFile: 'app/boards/layout.tsx',
  },
  {
    id: 'unguarded-layout-root-pin',
    expected: false,
    files: {
      'app/boards/layout.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
    },
  },
  {
    id: 'guarded-template-unregistered-root',
    expected: true,
    files: {
      'app/boards/template.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
    expectedFile: 'app/boards/template.tsx',
  },
  {
    id: 'unguarded-template-root-pin',
    expected: false,
    files: {
      'app/boards/template.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
    },
  },
  {
    id: 'guarded-loading-unregistered-root',
    expected: true,
    files: {
      'app/boards/loading.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
    expectedFile: 'app/boards/loading.tsx',
  },
  {
    id: 'unguarded-loading-root-pin',
    expected: false,
    files: {
      'app/boards/loading.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
    },
  },
  {
    id: 'guarded-indirect-layout-root',
    expected: true,
    files: {
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
      'controls/sidebar-frame.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/boards/layout.tsx':
        "import Frame from '@/controls/sidebar-frame';export default Frame;\n",
    },
    expectedFile: 'app/boards/layout.tsx',
  },
  {
    id: 'wrapper-different-owner-chain',
    expected: true,
    files: {
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
      'app/boards/layout.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/sidebar/[projectId]/page.tsx':
        "import Sidebar from '@/components/sidebar.reactive';\nexport default async function Page({ params }: { params: Promise<{ projectId: string }> }) {\n  const { projectId } = await params;\n  return <Sidebar projectId={projectId} />;\n}\n",
    },
    expectedFile: 'app/boards/layout.tsx',
  },
  {
    id: 'wrapper-same-owner-chain-pin',
    expected: false,
    files: {
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
      'app/boards/layout.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
      'app/boards/sidebar/[projectId]/page.tsx':
        "import Sidebar from '@/components/sidebar.reactive';\nexport default async function Page({ params }: { params: Promise<{ projectId: string }> }) {\n  const { projectId } = await params;\n  return <Sidebar projectId={projectId} />;\n}\n",
    },
  },
  {
    id: 'wrapper-type-only-root-pin',
    expected: false,
    files: {
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
      'app/boards/layout.tsx':
        "import type { ReactNode } from 'react';import type Sidebar from '@/components/sidebar.reactive';type Props={children?:ReactNode;preview?:Parameters<typeof Sidebar>[0]};export default function Frame({children}:Props){return <section>{children}</section>;}\n",
    },
  },
  {
    id: 'private-folder-wrapper-pin',
    expected: false,
    files: {
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
      'app/_private/layout.tsx':
        "import type { ReactNode } from 'react';\nimport Sidebar from '@/components/sidebar.reactive';\nexport default function Frame({ children }: { children?: ReactNode }) {\n  return <section><Sidebar projectId=\"p1\" />{children}</section>;\n}\n",
    },
  },
];

describe('middleware association for wrapper roots', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.filter(({ expected }) => expected))('$id', async ({ files, expectedFile }) => {
    const app = await application({ 'components/sidebar.reactive.tsx': SIDE_ROOT, ...files });
    apps.push(app);
    const refusals = compile(app).refusals;

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fileName).toBe(expectedFile);
    expect(refusals[0]?.reason).toMatch(
      /the guard would be left out where the root renders|rendered under two chains of route middleware/u,
    );
  });

  it.each(CASES.filter(({ expected }) => !expected))('$id', async ({ files }) => {
    const app = await application({ 'components/sidebar.reactive.tsx': SIDE_ROOT, ...files });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
