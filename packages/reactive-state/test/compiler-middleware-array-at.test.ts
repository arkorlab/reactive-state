import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native selected array elements cannot carry a mutation between independently evaluated parts. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-native-at-zero',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'constant-element-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst selected=decision.at(0)!;\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'whole-array-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst saved=decision;\nawait requirePublishedProject(params.projectId);\nsaved.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'negative-at-index',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(-1)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'constant-at-index',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst index=0;\nawait requirePublishedProject(params.projectId);\ndecision.at(index)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'closed-at-index-spread',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(...([0] as [number]))!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'borrowed-native-at-call',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nArray.prototype.at.call(decision,0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'borrowed-native-at-apply',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nArray.prototype.at.apply(decision,[0])!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'reflected-native-at',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nReflect.apply(Array.prototype.at,decision,[0]).allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'nested-selected-data',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{nested:{allowed:false}}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.nested.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.nested.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'selected-collection-mutator-argument',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction change(value:{allowed:boolean}){value.allowed=true;}\nawait requirePublishedProject(params.projectId);\nchange(decision.at(0)!);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'unknown-index-keeps-possible-identity',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst index=Number(params.projectId);\nawait requirePublishedProject(params.projectId);\ndecision.at(index)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'readonly-at-result',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.at(0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'guard-only-at-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',\"fixed\");\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'primitive-copied-before-at-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst copied=decision[0]!.allowed;\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(copied));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'ordinary-own-at-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst own={at(){return {allowed:false};}};\nawait requirePublishedProject(params.projectId);\nown.at().allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'out-of-bounds-native-at',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(3)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'negative-out-of-bounds-native-at',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(-2)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'direct-element-write-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'own-array-at-replacement-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at=()=>({allowed:false});decision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'unknown-at-primitive-only-stays-scalar',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[0];\nconst index=Number(params.projectId);function change(value:{allowed:boolean}){value.allowed=true;}\nawait requirePublishedProject(params.projectId);\nchange(decision.at(index) as unknown as {allowed:boolean});\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'unknown-at-empty-array-no-identity',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision:{allowed:boolean}[]=[];\nconst index=Number(params.projectId);\nawait requirePublishedProject(params.projectId);\ndecision.at(index)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.length));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'native-array-constructor-alias-replacement',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst Native=Array;Native.prototype.at=()=>({allowed:false});\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
] as const;

describe('native at middleware collection identities', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({ [FILE]: source });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const mutated = expect.stringContaining('mutated');
    const expected = refused ? [mutated] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
