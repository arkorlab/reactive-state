import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
/** Transitive native module loads retain the original guarded root association. */
interface Case {
  readonly id: string;
  readonly expected: boolean;
  readonly files: Readonly<Record<string, string>>;
}
const CASES: readonly Case[] = [
  {
    id: 'reported-imported-commonjs-wrapper',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'named-barrel-commonjs-wrapper',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import{Wrapper}from'@/controls/wrapper-export';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper-export.ts': "export{default as Wrapper}from'./wrapper';",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'wrapper-local-render-commonjs-root',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "export default function Wrapper({projectId}:{projectId:string}){function Inner(){const{default:Board}=require('@/components/public-board.reactive');return <Board projectId={projectId}/>;}return <Inner/>;}\n",
    },
  },
  {
    id: 'transitive-commonjs-wrapper-chain',
    expected: true,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Inner}=require('@/controls/inner');export default function Wrapper({projectId}:{projectId:string}){return <Inner projectId={projectId}/>;}",
      'controls/inner.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'ordinary-commonjs-wrapper-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/controls/ordinary');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}",
      'controls/ordinary.tsx':
        'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}',
    },
  },
  {
    id: 'shadowed-wrapper-require-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "function require(_name:string){return{default:({projectId}:{projectId:string})=><p>{projectId}</p>};}\nconst{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'type-only-commonjs-wrapper-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import type Wrapper from '@/controls/wrapper';export default function Page(){return <p>fixed</p>;}",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    id: 'associated-commonjs-wrapper-pin',
    expected: false,
    files: {
      'app/boards/[projectId]/page.tsx':
        "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
      'app/boards/known/[projectId]/page.tsx':
        "import Board from '@/components/public-board.reactive';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
    },
  },
];

describe('commonjs wrapper root association', () => {
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
