import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native shallow array copies keep original payload identities and independent wrappers. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-values-next-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision.values().next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'saved-native-values-iterator',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const iterator=decision.values();\nawait requirePublishedProject(params.projectId);\niterator.next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'saved-native-result',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst result=decision.values().next();result.value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'advanced-native-cursor',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];const iterator=decision.values();\nawait requirePublishedProject(params.projectId);\niterator.next();iterator.next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'fresh-result-value-replacement',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst result=decision.values().next();result.value={allowed:false};result.value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'fresh-result-done-field',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst result=decision.values().next();result.done=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'readonly-native-result',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nvoid decision.values().next().value!.allowed;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'application-values-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const own={values(){return[{allowed:false}].values();}};\nawait requirePublishedProject(params.projectId);\nown.values().next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'application-next-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const own={next:()=>({value:{allowed:false},done:false})};\nawait requirePublishedProject(params.projectId);\nown.next().value.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'source-own-next',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const iterator=decision.values();iterator.next=()=>({value:{allowed:false},done:false});\nawait requirePublishedProject(params.projectId);\niterator.next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
];

describe('native array iterator middleware identities', () => {
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
