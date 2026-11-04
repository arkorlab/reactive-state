import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Serialization callbacks cannot mutate a collection copied into both middleware parts. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'named-function-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'constant-arrow-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nconst mutate=(_key:string,value:unknown)=>{if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;};\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'constant-callback-alias',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}const saved=mutate;\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,saved);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'computed-native-name',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON[\"stringify\"](decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'nested-value-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={nested:{allowed:false}};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.nested.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'array-value-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision=[false];\nfunction mutate(_key:string,value:unknown){if(Array.isArray(value))value.push(true);return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.length));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'readonly-named-function',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction read(_key:string,value:unknown){return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'readonly-constant-arrow',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nconst read=(_key:string,value:unknown)=>value;\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'no-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'null-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,null);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'undefined-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,undefined);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'ignored-primitive-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,\"ignored\" as never);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'property-list-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,[\"allowed\"]);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'ignored-object-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,{} as never);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'inline-mutation-pin',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,(_key,value)=>{if(typeof value===\"object\"&&value!==null)value.allowed=true;return value;});\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'imported-unknown-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nimport { mutate } from '@/serializer';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\n\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'guard-only-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',\"fixed\");\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'primitive-copy-before-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};const copied=decision.allowed;\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(copied));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
  },
  {
    id: 'replaced-callback-binding',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nlet mutate=(_key:string,value:unknown)=>value;mutate=(_key,value)=>{if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;};\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'callback-this-mutation',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(this:{allowed?:boolean},_key:string,value:unknown){this.allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'reassigned-function-declaration',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){return value;}mutate=(_key,value)=>{if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;};\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'closed-argument-spread',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(...([decision,mutate] as const));\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'alias-after-function-reassignment',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){return value;}mutate=(_key,value)=>{if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;};const saved=mutate;\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,saved);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
  {
    id: 'overloaded-mutating-replacer',
    source:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(key:string,value:unknown):unknown;function mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
  },
] as const;

describe('named middleware serialization callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      [FILE]: source,
      'serializer.ts':
        'export function mutate(_key:string,value:unknown){if(typeof value==="object"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\n',
    });
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((refusal) => refusal.reason);
    const found = {
      count: reasons.length,
      mutation: reasons.every((reason) => reason.includes('mutated')),
    };
    const expected = { count: Number(refused), mutation: true };

    expect(found).toStrictEqual(expected);
  });
});
