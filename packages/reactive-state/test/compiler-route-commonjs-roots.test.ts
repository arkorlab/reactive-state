import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
/** Literal CommonJS roots retain the guarded page's existing association boundary. */
interface Case {
  readonly id: string;
  readonly expected: boolean;
  readonly files: Readonly<Record<string, string>>;
}
const CASES: readonly Case[] = [
  {
    id: 'reported-require-default-root',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'require-namespace-root',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const board=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <board.default projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'require-default-component-alias',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const loaded=require('@/components/public-board.reactive');const Root=loaded.default;const Board=Root;\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'require-named-root-barrel',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const {Board}=require('@/controls/root-export');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/root-export.ts':
        "export{default as Board}from'@/components/public-board.reactive';\n",
    },
  },
  {
    id: 'require-local-render-function',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "function Root({projectId}:{projectId:string}){const {default:Board}=require('@/components/public-board.reactive');return <Board projectId={projectId}/>;}\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Root projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'ordinary-commonjs-root-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const {default:Board}=require('@/controls/ordinary');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/ordinary.tsx':
        'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}\n',
    },
  },
  {
    id: 'shadowed-require-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "function require(_name:string){return{default:({projectId}:{projectId:string})=><p>{projectId}</p>};}\nconst {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    id: 'unguarded-commonjs-root-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'same-chain-associated-commonjs-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "const {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'app/boards/known/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
    },
  },
];

describe('commonjs guarded reactive roots', () => {
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
