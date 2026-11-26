import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { scanApp, wrappersOf } from '../src/compiler/route-scan.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A route's not-found response cannot introduce a root with no matching authority guard chain. */
const ROOT_SOURCE =
  "import {useReactiveState} from 'framework/react';\nexport default function NotFoundStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n";
const CASES = [
  {
    id: 'guarded-segment-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'guarded-parent-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/not-found.tsx',
  },
  {
    id: 'guarded-root-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/not-found.tsx',
  },
  {
    id: 'guarded-nested-dynamic-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/items/[itemId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/[projectId]/items/[itemId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/items/[itemId]/not-found.tsx',
  },
  {
    id: 'guarded-indirect-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        "import Shell from '@/controls/missing-shell';export default Shell;\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/missing-shell.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'guarded-JSX-not-found-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.jsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/not-found.jsx',
  },
  {
    id: 'not-found-root-registered-under-other-chain',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/status/[projectId]/page.tsx':
        "import NotFoundStatus from '@/components/not-found-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <NotFoundStatus projectId={projectId}/>;}\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'not-found-root-under-extra-child-chain',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/status/[projectId]/page.tsx':
        "import NotFoundStatus from '@/components/not-found-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <NotFoundStatus projectId={projectId}/>;}\n",
      'app/boards/[projectId]/items/[itemId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/items/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/not-found.tsx',
  },
  {
    id: 'unguarded-not-found-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'envelope-only-not-found-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{const response=await next();response.headers.set('X-Envelope','yes');return response;})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'same-chain-registered-not-found-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/status/[projectId]/page.tsx':
        "import NotFoundStatus from '@/components/not-found-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <NotFoundStatus projectId={projectId}/>;}\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'not-found-type-only-import-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        "import type NotFoundStatus from '@/components/not-found-status.reactive';type Props=Parameters<typeof NotFoundStatus>[0];export default function NotFound(){const text:Props['projectId']='fixed';return <p>{text}</p>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/not-found.tsx',
  },
  {
    id: 'private-not-found-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/_private/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/_private/not-found.tsx',
  },
  {
    id: 'sibling-not-found-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/unrelated/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/unrelated/not-found.tsx',
  },
  {
    id: 'nonconvention-not-found-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.preview.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/not-found.preview.tsx',
  },
  {
    id: 'global-unmatched-not-found-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/global-not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/global-not-found.tsx',
  },
] as const;
const SCANS = [
  {
    id: 'same-segment-tsx',
    files: ['boards/[projectId]/not-found.tsx'],
    directory: 'boards/[projectId]',
    expected: ['boards/[projectId]/not-found.tsx'],
  },
  {
    id: 'ancestor-and-dynamic-order',
    files: [
      'not-found.tsx',
      'boards/not-found.tsx',
      'boards/[projectId]/items/[itemId]/not-found.tsx',
    ],
    directory: 'boards/[projectId]/items/[itemId]',
    expected: [
      'not-found.tsx',
      'boards/not-found.tsx',
      'boards/[projectId]/items/[itemId]/not-found.tsx',
    ],
  },
  {
    id: 'JSX-convention',
    files: ['boards/not-found.jsx'],
    directory: 'boards/[projectId]',
    expected: ['boards/not-found.jsx'],
  },
  {
    id: 'JS-convention',
    files: ['boards/not-found.js'],
    directory: 'boards/[projectId]',
    expected: ['boards/not-found.js'],
  },
  {
    id: 'TS-convention',
    files: ['boards/not-found.ts'],
    directory: 'boards/[projectId]',
    expected: ['boards/not-found.ts'],
  },
  {
    id: 'private-file-not-scanned',
    files: ['_private/not-found.tsx'],
    directory: '_private',
    expected: [],
  },
  {
    id: 'sibling-boundary-not-applicable',
    files: ['other/not-found.tsx'],
    directory: 'boards/[projectId]',
    expected: [],
  },
  {
    id: 'global-not-found-not-a-segment-boundary',
    files: ['global-not-found.tsx'],
    directory: 'boards/[projectId]',
    expected: [],
  },
] as const;

describe('not-found root middleware association', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.filter((row) => row.refused))('$id', async ({ files, expectedFile }) => {
    const app = await application({
      'components/not-found-status.reactive.tsx': ROOT_SOURCE,
      ...files,
    });
    apps.push(app);
    const refusals = compile(app).refusals;

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fileName).toBe(expectedFile);
    expect(refusals[0]?.reason).toMatch(
      /the guard would be left out where the root renders|rendered under two chains of route middleware/u,
    );
  });

  it.each(CASES.filter((row) => !row.refused))('$id', async ({ files }) => {
    const app = await application({
      'components/not-found-status.reactive.tsx': ROOT_SOURCE,
      ...files,
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('applicable not-found conventions', () => {
  it.each(SCANS)('$id', async ({ files, directory, expected }) => {
    const appDir = await mkdtemp(path.join(tmpdir(), 'not-found-roots-'));
    onTestFinished(async () => {
      await rm(appDir, { force: true, recursive: true });
    });
    for (const file of files) {
      const target = path.join(appDir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'export default function NotFound(){return null;}\n');
    }
    const layout = scanApp(appDir, path.join(appDir, '.out'));
    const found = wrappersOf(directory, layout)
      .filter((row) => row.kind === 'not-found')
      .map((row) => path.relative(appDir, row.file).split(path.sep).join('/'));

    expect(found).toStrictEqual(expected);
  });
});
