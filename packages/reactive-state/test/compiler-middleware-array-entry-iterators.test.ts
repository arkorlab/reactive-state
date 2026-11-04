import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native shallow array copies keep original payload identities and independent wrappers. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-entries-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision.entries().next().value![1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'saved-entry-alias-before-pair-replace',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const iterator=decision.entries();const again=iterator;\nawait requirePublishedProject(params.projectId);\nconst result=again.next();const saved=result;const pair=saved.value!;const payload=pair[1];pair[1]={allowed:false};payload.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'advanced-entry-cursor',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];const iterator=decision.entries();\nawait requirePublishedProject(params.projectId);\niterator.next();iterator.next().value![1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'default-symbol-iterator-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision[Symbol.iterator]().next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'fresh-entry-key-slot',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst pair=decision.entries().next().value!;pair[0]=1;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'fresh-entry-payload-replacement',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst pair=decision.entries().next().value!;pair[1]={allowed:false};pair[1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'fresh-result-entry-replacement',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst result=decision.entries().next();result.value=[0,{allowed:false}];result.value[1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'readonly-whole-entry-pair',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst pair=decision.entries().next().value!;void pair;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'fresh-own-next-entry-pair',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const iterator=decision.entries();iterator.next=()=>({value:[0,{allowed:false}],done:false});\nawait requirePublishedProject(params.projectId);\niterator.next().value![1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
];

describe('native array entry iterator middleware identities', () => {
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
