import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Literal containers retain selected original payloads and their capture positions. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-object-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'explicit-own-data-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={payload:decision};\nawait requirePublishedProject(params.projectId);\nbox.payload.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'literal-array-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision];\nawait requirePublishedProject(params.projectId);\nbox[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'whole-object-holder-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const alias=box;\nawait requirePublishedProject(params.projectId);\nalias.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'whole-array-holder-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision];const alias=box;\nawait requirePublishedProject(params.projectId);\nalias[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'nested-object-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={nested:{decision}};\nawait requirePublishedProject(params.projectId);\nbox.nested.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'nested-array-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[[decision]];\nawait requirePublishedProject(params.projectId);\nbox[0]![0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'nested-holder-binding',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst nested={decision};const box={nested};\nawait requirePublishedProject(params.projectId);\nbox.nested.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'payload-captured-before-holder-replace',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const selected=box.decision;box.decision={allowed:false};\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'captured-payload-alias-chain',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const first=box.decision;const selected=first;box.decision={allowed:false};\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'array-payload-captured-before-length',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision];const selected=box[0]!;box.length=0;\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'object-wrapper-replaced-before-read',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};box.decision={allowed:false};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'array-wrapper-replaced-before-read',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision];box[0]={allowed:false};\nawait requirePublishedProject(params.projectId);\nbox[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'whole-holder-alias-after-replace',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const alias=box;box.decision={allowed:false};\nawait requirePublishedProject(params.projectId);\nalias.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'array-length-before-read',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision];box.length=0;\nawait requirePublishedProject(params.projectId);\nconst selected=box[0];if(selected)selected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'unrelated-object-field-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision,extra:0};box.extra=1;\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'unrelated-array-slot-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[decision,{allowed:false}];box[1]={allowed:false};\nawait requirePublishedProject(params.projectId);\nbox[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'fresh-object-payload-independent',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision:{allowed:false}};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'fresh-array-payload-independent',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nbox[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'copied-primitive-holder-independent',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={allowed:decision.allowed};\nawait requirePublishedProject(params.projectId);\nbox.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'primitive-snapshot-through-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const copied=box.decision.allowed;\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(copied));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'readonly-object-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};\nawait requirePublishedProject(params.projectId);\nvoid box.decision;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'selected-payload-handoff',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};function change(value:{allowed:boolean}){value.allowed=true;}\nawait requirePublishedProject(params.projectId);\nchange(box.decision);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'getter-holder-stays-independent',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={get decision(){return {allowed:false};}};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'prototype-holder-stays-independent',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={__proto__:{decision:{allowed:false}}};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'computed-key-fresh-holder',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst key=\"decision\";const box={[key]:{allowed:false}};\nawait requirePublishedProject(params.projectId);\nbox[key].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'literal-bracket-read',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};\nawait requirePublishedProject(params.projectId);\nbox[\"decision\"].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'captured-replacement-side-identity',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const fresh={allowed:false};box.decision=fresh;const selected=box.decision;\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(fresh.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'captured-nested-local-replace',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};function replace(){box.decision={allowed:false};}replace();\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'whole-holder-nested-mutation',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};function update(holder:{decision:{allowed:boolean}}){holder.decision.allowed=true;}\nawait requirePublishedProject(params.projectId);\nupdate(box);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
  {
    id: 'whole-holder-readonly-callee',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};function read(holder:{decision:{allowed:boolean}}){return holder.decision.allowed;}\nawait requirePublishedProject(params.projectId);\nvoid read(box);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    nativeExpected: 'false',
  },
  {
    id: 'nested-holder-handoff',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={inner:{decision}};function update(holder:{decision:{allowed:boolean}}){holder.decision.allowed=true;}\nawait requirePublishedProject(params.projectId);\nupdate(box.inner);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    nativeExpected: 'true',
  },
] as const;

describe('literal container middleware identities', () => {
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
