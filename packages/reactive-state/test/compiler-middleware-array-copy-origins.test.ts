import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native shallow array copies keep original payload identities and independent wrappers. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-native-concat',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'whole-concat-copy-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst copy=decision.concat();\nawait requirePublishedProject(params.projectId);\ncopy[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-negative-at',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat().at(-1)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-original-before-argument',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat([{allowed:false}])[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-fresh-argument-slot',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat([{allowed:false}])[1]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'concat-shared-argument-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst insert={allowed:false};const decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat([insert])[1]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(insert.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-native-reflect',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nReflect.apply(Array.prototype.concat,decision,[])[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-native-bound',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=Array.prototype.concat.bind(decision);copy()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-fresh-slot',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.concat();copy[0]={allowed:true};\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'concat-fresh-length',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.concat();copy.length=0;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'concat-readonly',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.concat()[0]!.allowed;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'concat-captured-before-slot-change',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.concat();const payload=copy[0]!;copy[0]={allowed:false};payload.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-own-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst own={concat(){return[{allowed:false}];}};\nawait requirePublishedProject(params.projectId);\nown.concat()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'concat-unknown-argument',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst extra=params.projectId==='x'?[{allowed:false}]:[];\nawait requirePublishedProject(params.projectId);\ndecision.concat(extra)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-argument-write-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.concat((decision[0]!.allowed=true,[]));\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'with-retained-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.with(1,fresh)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'true',
    originalPayloadExpectedToChange: true,
    refused: true,
  },
  {
    id: 'filter-retained-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.filter(()=>true)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'true',
    originalPayloadExpectedToChange: true,
    refused: true,
  },
  {
    id: 'map-retained-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.map(item=>item)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'true',
    originalPayloadExpectedToChange: true,
    refused: true,
  },
  {
    id: 'flat-retained-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\nconst nested=[decision];nested.flat()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'true',
    originalPayloadExpectedToChange: true,
    refused: true,
  },
  {
    id: 'flatmap-retained-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.flatMap(item=>[item])[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'true',
    originalPayloadExpectedToChange: true,
    refused: true,
  },
  {
    id: 'map-fresh-payload-control',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.map(()=>fresh)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'false',
    originalPayloadExpectedToChange: false,
    refused: false,
  },
  {
    id: 'with-fresh-payload-control',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.with(0,fresh)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    nativeExpected: 'false',
    originalPayloadExpectedToChange: false,
    refused: true,
  },
  {
    id: 'concat-nonspreadable-literal-child',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false,child:{allowed:false}}];\nconst arg={allowed:false,child:decision[0]!,[Symbol.isConcatSpreadable]:false};\nawait requirePublishedProject(params.projectId);\ndecision.concat(arg)[1]!.child.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'concat-negative-at-fresh-slot',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.concat();copy[0]={allowed:false};copy.at(-1)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'false',
  },
  {
    id: 'map-negative-at-original-payload',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.map(item=>item).at(-1)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
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
