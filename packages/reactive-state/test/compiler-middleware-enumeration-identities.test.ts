import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native value enumerations keep a collection's identity across a middleware split. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-native-values',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'global-native-values',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);globalThis.Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'native-entry-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.entries(decision)[0]![1].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-values-array',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const project=await requirePublishedProject(params.projectId);values[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'whole-values-array-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const original=Object.values(decision);const values=original;const project=await requirePublishedProject(params.projectId);values[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-selected-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const payload=Object.values(decision)[0]!;const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-entry-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const entry=Object.entries(decision)[0]!;const project=await requirePublishedProject(params.projectId);entry[1].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-entry-payload-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const payload=Object.entries(decision)[0]![1];const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'payload-captured-before-array-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const payload=values[0]!;values[0]={allowed:false};const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'entry-payload-captured-before-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const entry=Object.entries(decision)[0]!;const payload=entry[1];entry[1]={allowed:false};const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'source-whole-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const source=decision;const project=await requirePublishedProject(params.projectId);Object.values(source)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'inline-holder-data',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values({nested:decision.nested})[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'dense-array-values',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision=[{allowed:false}];const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision[0]!.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'dense-array-entry-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision=[{allowed:false}];const project=await requirePublishedProject(params.projectId);Object.entries(decision)[0]![1].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision[0]!.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'enumerated-array-push',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:[false]};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.push(true);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.length));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'enumerated-child-count',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{count:0}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.count++;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.count));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'enumerated-child-delete',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision:{nested:{allowed?:boolean}}={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);delete Object.values(decision)[0]!.allowed;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'native-writer-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.assign(Object.values(decision)[0]!,{allowed:true});const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'local-writer-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};function change(value:{allowed:boolean}){value.allowed=true;}const project=await requirePublishedProject(params.projectId);change(Object.values(decision)[0]!);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'local-reader-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};function read(value:{allowed:boolean}){return value.allowed;}const project=await requirePublishedProject(params.projectId);read(Object.values(decision)[0]!);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'readonly-enumeration',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const project=await requirePublishedProject(params.projectId);void values[0]!.allowed;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'fresh-array-slot-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const project=await requirePublishedProject(params.projectId);values[0]={allowed:false};values[0].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'fresh-array-length-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const project=await requirePublishedProject(params.projectId);values.length=0;values.push({allowed:false});values[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'fresh-entry-value-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const entry=Object.entries(decision)[0]!;const project=await requirePublishedProject(params.projectId);entry[1]={allowed:false};entry[1].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'fresh-entry-key-metadata',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const entry=Object.entries(decision)[0]!;const project=await requirePublishedProject(params.projectId);entry[0]="changed";const response=await next();response.headers.set("X-Decision",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: false,
    mutation: false,
  },
  {
    id: 'guard-only-enumerated-write',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set("X-Decision","unchanged");return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: false,
    mutation: false,
  },
  {
    id: 'native-key-array-is-fresh',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const keys=Object.keys(decision);const project=await requirePublishedProject(params.projectId);keys.push("fresh");const response=await next();response.headers.set("X-Decision",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: false,
    mutation: false,
  },
  {
    id: 'primitive-values-copy-existing-refusal',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={allowed:false};const allowed=Object.values(decision)[0];const project=await requirePublishedProject(params.projectId);decision.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'getter-fresh-values-existing-refusal',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={get nested(){return{allowed:false};}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'local-values-shadow-existing-refusal',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const Object={values:(_value:unknown)=>[{allowed:false}]};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'array-replaced-before-payload-capture',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);values[0]={allowed:false};const payload=values[0]!;const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'entry-replaced-before-payload-capture',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const entry=Object.entries(decision)[0]!;entry[1]={allowed:false};const payload=entry[1];const project=await requirePublishedProject(params.projectId);payload.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'fresh-values-array-push',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const values=Object.values(decision);const project=await requirePublishedProject(params.projectId);values.push({allowed:true});const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'second-native-value',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={first:{allowed:false},nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[1]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'second-native-entry-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={first:{allowed:false},nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.entries(decision)[1]![1].allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'const-literal-value-position',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const position=0;const project=await requirePublishedProject(params.projectId);Object.values(decision)[position]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'prototype-setter-is-not-an-entry',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={__proto__:null,nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'prototype-shorthand-is-own-data',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const __proto__={allowed:false};const decision={__proto__,nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.__proto__.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'numeric-keys-precede-identifier-keys',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false},0:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'sparse-arrays-compact-the-enumerated-list',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision=[,{allowed:false},{allowed:false}];const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision[2]!.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'symbol-keys-are-not-enumerated',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const key=Symbol("hidden");const decision={nested:{allowed:false},[key]:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set("X-Decision",String(decision[key].allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: true,
    mutation: false,
  },
  {
    id: 'ignored-argument-runs-before-enumeration',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);(Object.values as(input:object,...ignored:unknown[])=>{allowed:boolean}[])({nested:decision.nested},decision.nested={allowed:false})[0]!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'native-callee-own-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};Object.defineProperty(Object,'values',{value:(_value:unknown)=>[{allowed:false}]});const project=await requirePublishedProject(params.projectId);Object.values(decision)[0]!.allowed=true;const response=await next();response.headers.set('X-Decision',String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
] as const;

describe('enumerated middleware collection identities', () => {
  const { apps, compile } = compilerApplications();

  async function fixture(source: string) {
    const app = await application({ [FILE]: source });
    apps.push(app);
    return compile(app);
  }

  it.each(CASES.filter((each) => each.mutation))('refuses $id', async ({ source }) => {
    const compiled = await fixture(source);

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain('mutated');
  });

  it.each(CASES.filter((each) => each.refused && !each.mutation))(
    'retains the prior refusal: $id',
    async ({ source }) => {
      const compiled = await fixture(source);

      expect(compiled.refusals).toHaveLength(1);
    },
  );

  it.each(CASES.filter((each) => !each.refused))('preserves $id', async ({ source }) => {
    const compiled = await fixture(source);

    expect(compiled.refusals).toStrictEqual([]);
  });
});
