import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { scanApp } from '../src/compiler/route-scan.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Parallel slot defaults retain the existing middleware association without registering slot routes. */
const ROOT_SOURCE =
  "import {useReactiveState} from 'framework/react';export default function SlotStatus({projectId}:{projectId:string}){const [value,setValue]=useReactiveState<string>(projectId);return <section><button onClick={()=>setValue('next')}>{value}</button></section>;}\n";
const CASES = [
  {
    id: 'guarded-slot-default-root',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
  },
  {
    id: 'guarded-slot-default-wrapper',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        "import Default from '@/controls/slot-default';export default Default;\n",
      'controls/slot-default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
  },
  {
    id: 'guarded-JSX-slot-default',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.jsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.jsx',
  },
  {
    id: 'same-chain-registered-default',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/status/[projectId]/page.tsx':
        "import SlotStatus from '@/components/slot-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <SlotStatus projectId={projectId}/>;}\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
    conservativeUnsupportedSlotPolicy: true,
  },
  {
    id: 'unguarded-slot-default-root',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
    },
    refused: false,
    expectedFile: null,
  },
  {
    id: 'guarded-plain-slot-default',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
    conservativeUnsupportedSlotPolicy: true,
  },
  {
    id: 'guarded-type-only-slot-default',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        "import type SlotStatus from '@/components/slot-status.reactive';export default function Default(){return null;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
    conservativeUnsupportedSlotPolicy: true,
  },
  {
    id: 'private-slot-default-pin',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/_hidden/@panel/default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: null,
  },
  {
    id: 'nonconvention-slot-file-pin',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/fallback.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: false,
    expectedFile: null,
  },
  {
    id: 'other-chain-registered-default',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/status/[projectId]/page.tsx':
        "import SlotStatus from '@/components/slot-status.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <SlotStatus projectId={projectId}/>;}\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
  },
  {
    id: 'ordinary-unknown-default-pin',
    files: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'app/boards/@panel/default.tsx':
        'export default function Default({panel}:{panel:unknown}){return null;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    refused: true,
    expectedFile: 'app/boards/@panel/default.tsx',
    conservativeUnsupportedSlotPolicy: true,
  },
] as const;

describe('parallel slot default association', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ files, expectedFile }) => {
    const app = await application({ 'components/slot-status.reactive.tsx': ROOT_SOURCE, ...files });
    apps.push(app);
    const compiled = compile(app);
    const found = compiled.refusals.map((refusal) => {
      return {
        file: refusal.fileName,
        association:
          /the guard would be left out where the root renders|rendered under two chains of route middleware|but no rewrite places it exactly/u.test(
            refusal.reason,
          ),
      };
    });
    const expected = expectedFile === null ? [] : [{ file: expectedFile, association: true }];

    expect(found).toStrictEqual(expected);
  });
});

describe('parallel slot default scan', () => {
  it.each(['default.tsx', 'default.jsx'])('keeps %s unregistered', async (name) => {
    const appDir = await mkdtemp(path.join(tmpdir(), 'parallel-slot-default-'));
    onTestFinished(async () => {
      await rm(appDir, { force: true, recursive: true });
    });
    const slot = path.join(appDir, 'boards/@panel');
    await mkdir(slot, { recursive: true });
    await writeFile(path.join(slot, name), 'export default function Default(){return null;}');
    const layout = scanApp(appDir, path.join(appDir, '.out'));
    const entry = layout.pages.find((page) => path.basename(page.file) === name);

    expect({
      found: entry !== undefined,
      served: entry?.served,
      route: entry?.route,
    }).toStrictEqual({ found: true, served: undefined, route: undefined });
  });
});
