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
    id: 'reported-registered-page-extra-root',
    expected: true,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'registered-page-named-wrapper',
    expected: true,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport {Sidebar} from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'registered-page-barrel-wrapper',
    expected: true,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar-export';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'controls/sidebar-export.ts': "export {default} from '@/controls/sidebar';\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'registered-page-transitive-wrapper',
    expected: true,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        "import Inner from '@/controls/sidebar-inner';export default function Sidebar(){return <Inner/>;}\n",
      'controls/sidebar-inner.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'unguarded-extra-root-pin',
    expected: false,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
    },
  },
  {
    id: 'same-chain-associated-root-pin',
    expected: false,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'app/boards/sidebar/[projectId]/page.tsx':
        "import Sidebar from '@/components/sidebar.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Sidebar projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'different-chain-existing-refusal-pin',
    expected: true,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        'import SidebarRoot from \'@/components/sidebar.reactive\';\nexport default function Sidebar(){return <SidebarRoot projectId="p1"/>;}\n',
      'app/sidebar/[projectId]/page.tsx':
        "import Sidebar from '@/components/sidebar.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Sidebar projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'type-only-extra-root-pin',
    expected: false,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx':
        "import type SidebarRoot from '@/components/sidebar.reactive';export type Props=Parameters<typeof SidebarRoot>[0];export default function Sidebar(){return <aside>fixed</aside>;}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'ordinary-extra-component-pin',
    expected: false,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nimport Sidebar from '@/controls/sidebar';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><Sidebar/></main>;}\n",
      'controls/sidebar.tsx': 'export default function Sidebar(){return <aside>fixed</aside>;}\n',
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'canonical-registration-pin',
    expected: false,
    expectedFile: 'app/boards/[projectId]/page.tsx',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\n\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><Board projectId={projectId}/><span/></main>;}\n",
      'app/boards/middleware.ts':
        "import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context, next) => { await requireUser(); return await next(); }) satisfies RouteMiddleware;\n",
    },
  },
];

describe('middleware association for every root reached by a registered page', () => {
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
