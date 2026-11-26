import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Value-bearing page re-exports preserve their original guarded root association. */
interface Case {
  readonly id: string;
  readonly expected: boolean;
  readonly files: Readonly<Record<string, string>>;
}
const CASES: readonly Case[] = [
  {
    id: 'reported-default-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-page';",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'named-default-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export {BoardPage as default} from '@/controls/board-page';",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export async function BoardPage({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'value-star-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export * from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export async function BoardPage({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'value-namespace-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export * as Pages from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export async function BoardPage({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'local-barrel-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-barrel';",
      'controls/board-barrel.ts': "export {default} from './board-page';",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'cyclic-value-barrel-page-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-barrel';",
      'controls/board-barrel.ts':
        "export {default} from './board-page'; export {marker} from './cycle'; export const value=1;",
      'controls/cycle.ts': "export {value} from './board-barrel'; export const marker=1;",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'direct-reactive-default-reexport',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export {default} from '@/components/public-board.reactive';",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'whole-type-only-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export type {default} from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'inline-type-only-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export {type BoardPage} from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export async function BoardPage({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'empty-value-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "export {} from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'ordinary-default-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/ordinary';",
      'controls/ordinary.tsx': 'export default function Page(){return <p>fixed</p>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'shadowed-wrapper-require-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-page';",
      'controls/board-page.tsx':
        "function require(_name:string){return {default:({projectId}:{projectId:string})=><p>{projectId}</p>};}\nconst {default:Board}=require('@/components/public-board.reactive');export default function Page(){return <Board projectId='fixed'/>;}",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'unguarded-page-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-page';",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'same-chain-page-reexport-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/board-page';",
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/known/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'direct-native-import-equals-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Board = require('@/components/equal-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board.default projectId={projectId}/>;}\n",
      'components/equal-board.reactive.tsx':
        'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}\n',
      'app/boards/middleware.ts':
        "import{requireUser,type RouteMiddleware}from'@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
    expected: true,
  },
  {
    id: 'wrapper-native-import-equals-root',
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/equal-wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'components/equal-board.reactive.tsx':
        'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}\n',
      'app/boards/middleware.ts':
        "import{requireUser,type RouteMiddleware}from'@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/equal-wrapper.tsx':
        "import Board = require('@/components/equal-board.reactive');\nexport default function Wrapper({projectId}:{projectId:string}){return <Board.default projectId={projectId}/>;}\n",
    },
    expected: true,
  },
  {
    id: 'type-only-import-equals-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import type Board = require('@/components/equal-board.reactive');\nexport default function Page(){return <p>fixed</p>;}\n",
      'components/equal-board.reactive.tsx':
        'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}\n',
      'app/boards/middleware.ts':
        "import{requireUser,type RouteMiddleware}from'@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
];

describe('page value reexport root association', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.filter(({ expected }) => expected))('$id', async ({ files }) => {
    const app = await application(files);
    apps.push(app);
    const refusals = compile(app).refusals;

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fileName).toBe('app/boards/[projectId]/page.tsx');
    expect(refusals[0]?.reason).toMatch(/the guard would be left out where the root renders/u);
  });

  it.each(CASES.filter(({ expected }) => !expected))('$id', async ({ files }) => {
    const app = await application(files);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
