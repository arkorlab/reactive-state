import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native toSpliced copies keep original payload identities and independent wrappers. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-native-toSpliced',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'whole-spliced-copy-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst copy=decision.toSpliced();\nawait requirePublishedProject(params.projectId);\ncopy[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-negative-at',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced().at(-1)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-native-call',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nArray.prototype.toSpliced.call(decision)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-native-apply',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nArray.prototype.toSpliced.apply(decision,[])[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-native-reflect',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nReflect.apply(Array.prototype.toSpliced,decision,[])[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-native-bound',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=Array.prototype.toSpliced.bind(decision);copy()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-explicit-zero-delete',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,0)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-undefined-delete',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,undefined)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-retained-before-window',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(1,1)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-retained-after-window',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,1)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-negative-start',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(-1,0)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-insertion-shifts-original',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,0,{allowed:false})[1]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-inserted-shared-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst insert={allowed:false};const decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,0,insert)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(insert.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-unknown-start-retains-original',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(Number(params.projectId),0)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-argument-effect-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.toSpliced((decision[0]!.allowed=true,0),0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'spliced-readonly-copy-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.toSpliced()[0]!.allowed;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-fresh-slot-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.toSpliced();copy[0]={allowed:true};\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-fresh-length-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.toSpliced();copy.length=0;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-fresh-inserted-payload-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,0,{allowed:false})[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-replaced-original-slot-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced(0,1,{allowed:false})[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-removed-suffix-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.toSpliced(1);copy[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
    qualification:
      'Conservative shared-collection refusal; the host reads another original slot, so native output itself does not drift.',
  },
  {
    id: 'spliced-own-method-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];const own={toSpliced(){return[{allowed:false}];}};\n\nawait requirePublishedProject(params.projectId);\nown.toSpliced()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'spliced-captured-before-slot-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.toSpliced();const payload=copy[0]!;copy[0]={allowed:false};payload.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
];

describe('native array reordering middleware identities', () => {
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
