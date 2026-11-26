import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { scanApp, wrappersOf } from '../src/compiler/route-scan.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native authorization response boundaries retain each rendered root’s route guard association. */
const KINDS = ['forbidden', 'unauthorized'] as const;
const ROOT_SOURCE =
  "import {useReactiveState} from 'framework/react';\nexport default function BoundaryStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n";
const CASES = [
  {
    id: 'guarded-segment-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'guarded-parent-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/BOUNDARY.tsx',
  },
  {
    id: 'guarded-root-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/BOUNDARY.tsx',
  },
  {
    id: 'guarded-nested-dynamic-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/items/[itemId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/[projectId]/items/[itemId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/items/[itemId]/BOUNDARY.tsx',
  },
  {
    id: 'guarded-indirect-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        "import Shell from '@/controls/missing-shell';export default Shell;\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/missing-shell.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'guarded-JSX-BOUNDARY-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.jsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.jsx',
  },
  {
    id: 'BOUNDARY-root-registered-under-other-chain',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/status/[projectId]/page.tsx':
        "import BoundaryStatus from '@/components/boundary-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <BoundaryStatus projectId={projectId}/>;}\n",
    },
    refused: true,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'BOUNDARY-root-under-extra-child-chain',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/status/[projectId]/page.tsx':
        "import BoundaryStatus from '@/components/boundary-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <BoundaryStatus projectId={projectId}/>;}\n",
      'app/boards/[projectId]/items/[itemId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/items/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/BOUNDARY.tsx',
  },
  {
    id: 'unguarded-BOUNDARY-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'envelope-only-BOUNDARY-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{const response=await next();response.headers.set('X-Envelope','yes');return response;})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'same-chain-registered-BOUNDARY-root-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/status/[projectId]/page.tsx':
        "import BoundaryStatus from '@/components/boundary-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <BoundaryStatus projectId={projectId}/>;}\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'BOUNDARY-type-only-import-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.tsx':
        "import type BoundaryStatus from '@/components/boundary-status.reactive';type Props=Parameters<typeof BoundaryStatus>[0];export default function Boundary(){const text:Props['projectId']='fixed';return <p>{text}</p>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.tsx',
  },
  {
    id: 'private-BOUNDARY-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/_private/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/_private/BOUNDARY.tsx',
  },
  {
    id: 'sibling-BOUNDARY-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/unrelated/BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/unrelated/BOUNDARY.tsx',
  },
  {
    id: 'nonconvention-BOUNDARY-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/boards/[projectId]/BOUNDARY.preview.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/boards/[projectId]/BOUNDARY.preview.tsx',
  },
  {
    id: 'global-unmatched-BOUNDARY-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import {BOUNDARY} from 'next/navigation';export default function Page(){BOUNDARY();}\n",
      'app/global-BOUNDARY.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: 'app/global-BOUNDARY.tsx',
  },
] as const;
const SCANS = [
  {
    id: 'same-segment-tsx',
    files: ['boards/[projectId]/BOUNDARY.tsx'],
    directory: 'boards/[projectId]',
    expected: ['boards/[projectId]/BOUNDARY.tsx'],
  },
  {
    id: 'ancestor-and-dynamic-order',
    files: [
      'BOUNDARY.tsx',
      'boards/BOUNDARY.tsx',
      'boards/[projectId]/items/[itemId]/BOUNDARY.tsx',
    ],
    directory: 'boards/[projectId]/items/[itemId]',
    expected: [
      'BOUNDARY.tsx',
      'boards/BOUNDARY.tsx',
      'boards/[projectId]/items/[itemId]/BOUNDARY.tsx',
    ],
  },
  {
    id: 'JSX-convention',
    files: ['boards/BOUNDARY.jsx'],
    directory: 'boards/[projectId]',
    expected: ['boards/BOUNDARY.jsx'],
  },
  {
    id: 'JS-convention',
    files: ['boards/BOUNDARY.js'],
    directory: 'boards/[projectId]',
    expected: ['boards/BOUNDARY.js'],
  },
  {
    id: 'TS-convention',
    files: ['boards/BOUNDARY.ts'],
    directory: 'boards/[projectId]',
    expected: ['boards/BOUNDARY.ts'],
  },
  {
    id: 'private-file-not-scanned',
    files: ['_private/BOUNDARY.tsx'],
    directory: '_private',
    expected: [],
  },
  {
    id: 'sibling-boundary-not-applicable',
    files: ['other/BOUNDARY.tsx'],
    directory: 'boards/[projectId]',
    expected: [],
  },
  {
    id: 'global-BOUNDARY-not-a-segment-boundary',
    files: ['global-BOUNDARY.tsx'],
    directory: 'boards/[projectId]',
    expected: [],
  },
] as const;

/** Convention names are substituted only in fixture paths and the native interrupt call. */
function boundaryFiles(
  files: Readonly<Record<string, string>>,
  kind: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([file, source]) => {
      const target = file.replaceAll('BOUNDARY', () => kind);
      const contents = source.replaceAll('BOUNDARY', () => kind);
      return [target, contents];
    }),
  );
}

describe.each(KINDS)('authorization boundary %s association', (kind) => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.filter((row) => row.refused))('$id', async ({ files, expectedFile }) => {
    const app = await application({
      '../next.config.mjs': 'export default {experimental:{authInterrupts:true}};\n',
      'components/boundary-status.reactive.tsx': ROOT_SOURCE,
      ...boundaryFiles(files, kind),
    });
    apps.push(app);
    const refusals = compile(app).refusals;

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fileName).toBe(expectedFile.replaceAll('BOUNDARY', () => kind));
    expect(refusals[0]?.reason).toMatch(
      /the guard would be left out where the root renders|rendered under two chains of route middleware/u,
    );
  });

  it.each(CASES.filter((row) => !row.refused))('$id', async ({ files }) => {
    const app = await application({
      '../next.config.mjs': 'export default {experimental:{authInterrupts:true}};\n',
      'components/boundary-status.reactive.tsx': ROOT_SOURCE,
      ...boundaryFiles(files, kind),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it('keeps the static association check when the runtime feature is disabled', async () => {
    const app = await application({
      '../next.config.mjs': 'export default {experimental:{authInterrupts:false}};\n',
      'components/boundary-status.reactive.tsx': ROOT_SOURCE,
      ...boundaryFiles(CASES[0].files, kind),
    });
    apps.push(app);
    const refusals = compile(app).refusals;

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toMatch(/the guard would be left out where the root renders/u);
  });
});

describe.each(KINDS)('authorization boundary %s convention scan', (kind) => {
  it.each(SCANS)('$id', async ({ files, directory, expected }) => {
    const appDir = await mkdtemp(path.join(tmpdir(), 'auth-boundary-roots-'));
    onTestFinished(async () => {
      await rm(appDir, { force: true, recursive: true });
    });
    for (const file of files) {
      const target = path.join(
        appDir,
        file.replaceAll('BOUNDARY', () => kind),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'export default function Boundary(){return null;}\n');
    }
    const layout = scanApp(appDir, path.join(appDir, '.out'));
    const found = wrappersOf(directory, layout)
      .filter((row) => row.kind === kind)
      .map((row) => path.relative(appDir, row.file).split(path.sep).join('/'));

    expect(found).toStrictEqual(expected.map((file) => file.replaceAll('BOUNDARY', () => kind)));
  });
});
