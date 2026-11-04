import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native reflective data selections keep a collection's identity across a middleware split. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'reported-singular-descriptor',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'reflect-singular-descriptor',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.getOwnPropertyDescriptor(decision,'nested')!.value!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'plural-descriptor-data',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptors(decision).nested!.value!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'native-Reflect-get',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested').allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'descriptor-bracket-value',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!['value']['allowed']=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'reflect-get-bracket-child',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested')['allowed']=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-descriptor-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptor=Object.getOwnPropertyDescriptor(decision,'nested')!;const project=await requirePublishedProject(params.projectId);descriptor.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'saved-payload-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const nested=Object.getOwnPropertyDescriptor(decision,'nested')!.value;const project=await requirePublishedProject(params.projectId);nested.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'whole-descriptor-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const original=Object.getOwnPropertyDescriptor(decision,'nested')!;const descriptor=original;const project=await requirePublishedProject(params.projectId);descriptor.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'plural-map-alias',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptors=Object.getOwnPropertyDescriptors(decision);const project=await requirePublishedProject(params.projectId);descriptors.nested!.value!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'Reflect-get-descriptor-value',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.get(Object.getOwnPropertyDescriptor(decision,'nested')!,'value').allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'Object-assign-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.assign(Object.getOwnPropertyDescriptor(decision,'nested')!.value,{allowed:true});const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'local-writer-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};function change(value:{allowed:boolean}){value.allowed=true;}const project=await requirePublishedProject(params.projectId);change(Object.getOwnPropertyDescriptor(decision,'nested')!.value);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'local-readonly-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};function read(value:{allowed:boolean}){return value.allowed;}const project=await requirePublishedProject(params.projectId);read(Object.getOwnPropertyDescriptor(decision,'nested')!.value);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'readonly-descriptor',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptor=Object.getOwnPropertyDescriptor(decision,'nested')!;const project=await requirePublishedProject(params.projectId);void descriptor.value;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'descriptor-value-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!.value={allowed:true};const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'descriptor-metadata-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!.writable=false;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'plural-descriptor-value-replacement',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptors(decision).nested!.value={allowed:true};const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'saved-descriptor-value-replaced',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptor=Object.getOwnPropertyDescriptor(decision,'nested')!;const project=await requirePublishedProject(params.projectId);descriptor.value={allowed:false};descriptor.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'saved-descriptor-defineProperty',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptor=Object.getOwnPropertyDescriptor(decision,'nested')!;const project=await requirePublishedProject(params.projectId);Object.defineProperty(descriptor,'value',{value:{allowed:false}});descriptor.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'getter-fresh-result',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={get nested(){return{allowed:false};}};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested').allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'direct-ordinary-alias-existing',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const nested=decision.nested;const project=await requirePublishedProject(params.projectId);nested.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'reflect-get-array-push',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:[false]};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested').push(true);const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.length));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'descriptor-array-count',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:[0]};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!.value[0]++;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested[0]));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'descriptor-delete-child',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision:{nested:{allowed?:boolean}}={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);delete Object.getOwnPropertyDescriptor(decision,'nested')!.value.allowed;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'native-Reflect-get-saved-payload',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const nested=Reflect.get(decision,'nested');const project=await requirePublishedProject(params.projectId);nested.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'guard-only-reflected-write',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested').allowed=true;const response=await next();response.headers.set(\"X-Decision\",\"unchanged\");return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'descriptor-primitive-snapshot',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={allowed:false};const allowed=Object.getOwnPropertyDescriptor(decision,"allowed")!.value;const project=await requirePublishedProject(params.projectId);decision.allowed=true;const response=await next();response.headers.set("X-Decision",String(allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: false,
    mutation: false,
  },
  {
    id: 'Reflect-get-primitive-snapshot',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={allowed:false};const allowed=Reflect.get(decision,"allowed");const project=await requirePublishedProject(params.projectId);decision.allowed=true;const response=await next();response.headers.set("X-Decision",String(allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: false,
    mutation: false,
  },
  {
    id: 'saved-descriptor-metadata-read',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptor=Object.getOwnPropertyDescriptor(decision,"nested")!;void descriptor.writable;const project=await requirePublishedProject(params.projectId);descriptor.value.allowed=true;const response=await next();response.headers.set("X-Decision",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: true,
    mutation: true,
  },
  {
    id: 'nested-payload-holder',
    source:
      'import type{RouteMiddleware}from \'@arkorlab/reactive-state/server\';\nimport{requirePublishedProject}from \'@/publication\';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const holder={nested:Reflect.get(decision,"nested")};const project=await requirePublishedProject(params.projectId);holder.nested.allowed=true;const response=await next();response.headers.set("X-Decision",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n',
    refused: true,
    mutation: true,
  },
  {
    id: 'unselected-fresh-data',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false},fresh:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'fresh')!.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'overridden-native-descriptor',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{Object.getOwnPropertyDescriptor=(()=>({value:{allowed:false}}))as typeof Object.getOwnPropertyDescriptor;const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Object.getOwnPropertyDescriptor(decision,'nested')!.value.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'overridden-native-Reflect-get',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{Reflect.get=(()=>({allowed:false}))as typeof Reflect.get;const decision={nested:{allowed:false}};const project=await requirePublishedProject(params.projectId);Reflect.get(decision,'nested').allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: false,
  },
  {
    id: 'map-slot-replaced-before-descriptor-capture',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptors=Object.getOwnPropertyDescriptors(decision);descriptors.nested={value:{allowed:false}};const descriptor=descriptors.nested;const project=await requirePublishedProject(params.projectId);descriptor.value!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    mutation: false,
  },
  {
    id: 'map-slot-replaced-after-descriptor-capture',
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision={nested:{allowed:false}};const descriptors=Object.getOwnPropertyDescriptors(decision);const descriptor=descriptors.nested;descriptors.nested={value:{allowed:false}};const project=await requirePublishedProject(params.projectId);descriptor.value!.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(decision.nested.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    mutation: true,
  },
  {
    id: 'Reflect-get-evaluated-receiver-replaces-primitive',
    refused: true,
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision:{item:boolean|{allowed:boolean}}={item:false};const copied=Reflect.get(decision,'item',(decision.item={allowed:false},decision))as{allowed:boolean};const project=await requirePublishedProject(params.projectId);copied.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(copied.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    mutation: true,
  },
  {
    id: 'descriptor-ignored-tail-replaces-primitive',
    refused: true,
    source:
      "import type{RouteMiddleware}from '@arkorlab/reactive-state/server';\nimport{requirePublishedProject}from '@/publication';\nexport default(async({params},next)=>{const decision:{item:boolean|{allowed:boolean}}={item:false};const copied=(Object.getOwnPropertyDescriptor as(...args:unknown[])=>PropertyDescriptor|undefined)(decision,'item',decision.item={allowed:false})!.value as{allowed:boolean};const project=await requirePublishedProject(params.projectId);copied.allowed=true;const response=await next();response.headers.set(\"X-Decision\",String(copied.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;\n",
    mutation: true,
  },
] as const;

describe('reflective middleware collection identities', () => {
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
