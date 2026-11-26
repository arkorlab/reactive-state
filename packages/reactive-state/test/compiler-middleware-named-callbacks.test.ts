import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native named callbacks cannot mutate identities retained across split middleware parts. */
const FILE = 'app/boards/[projectId]/middleware.ts';
const CASES = [
  {
    id: 'named-native-forEach',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-map',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.map(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-filter',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.filter(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-every',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.every(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-some',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.some(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-find',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.find(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-findIndex',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.findIndex(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-findLast',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.findLast(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-findLastIndex',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.findLastIndex(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-native-flatMap',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;return item;}\nawait requirePublishedProject(params.projectId);\ndecision.flatMap(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'reported-named-declaration',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-arrow-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst mutate=(item:{allowed:boolean})=>{item.allowed=true;};\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-function-expression',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst mutate=function(item:{allowed:boolean}){item.allowed=true;};\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'closed-callback-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}const saved=mutate;\nawait requirePublishedProject(params.projectId);\ndecision.forEach(saved);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'whole-receiver-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst saved=decision;function mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\nsaved.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'computed-native-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision[\"forEach\"](mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'native-array-parameter',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(_item:{allowed:boolean},_index:number,all:{allowed:boolean}[]){all[0]!.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'destructured-element-parameter',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{nested:{allowed:false}}];\nfunction mutate({nested}:{nested:{allowed:boolean}}){nested.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.nested.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'readonly-named-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction read(item:{allowed:boolean}){return item.allowed;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'readonly-callback-alias',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst read=(item:{allowed:boolean})=>item.allowed;const saved=read;\nawait requirePublishedProject(params.projectId);\ndecision.forEach(saved);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'callback-index-local-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction read(item:{allowed:boolean},index:number){index++;return item.allowed;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'primitive-copy-before-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst copied=decision[0]!.allowed;function mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(copied));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'callback-mutation-guard-only',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',\"fixed\");\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'empty-native-no-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision:{allowed:boolean}[]=[];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.length));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'ordinary-own-callback-method',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={value:{allowed:false},forEach(_fn:(item:{allowed:boolean})=>void){return;}};\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.value.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'inline-mutation-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.forEach(item=>{item.allowed=true;});\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'borrowed-callback-mutation-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\nArray.prototype.forEach.call(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'borrowed-readonly-opaque-pin',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction read(item:{allowed:boolean}){return item.allowed;}\nawait requirePublishedProject(params.projectId);\nArray.prototype.forEach.call(decision,read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-reduce-item',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction mutate(count:number,item:{allowed:boolean}){item.allowed=true;return count+1;}\nawait requirePublishedProject(params.projectId);\ndecision.reduce(mutate,0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-reduceRight-item',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction mutate(count:number,item:{allowed:boolean}){item.allowed=true;return count+1;}\nawait requirePublishedProject(params.projectId);\ndecision.reduceRight(mutate,0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-reduce-original-accumulator',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction mutate(first:{allowed:boolean},_item:{allowed:boolean}){first.allowed=true;return first;}\nawait requirePublishedProject(params.projectId);\ndecision.reduce(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-reduce-array-parameter',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction mutate(count:number,_item:{allowed:boolean},_index:number,all:{allowed:boolean}[]){all[0]!.allowed=true;return count+1;}\nawait requirePublishedProject(params.projectId);\ndecision.reduce(mutate,0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'named-toSorted-comparator',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction mutate(first:{allowed:boolean},_second:{allowed:boolean}){first.allowed=true;_second.allowed=true;return 0;}\nawait requirePublishedProject(params.projectId);\ndecision.toSorted(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'readonly-reduce-initial-local-write',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction read(count:number,item:{allowed:boolean}){count++;return count+Number(item.allowed);}\nawait requirePublishedProject(params.projectId);\ndecision.reduce(read,0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: false,
    reason: 'mutated',
  },
  {
    id: 'single-reduce-no-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(first:{allowed:boolean},_item:{allowed:boolean}){first.allowed=true;return first;}\nawait requirePublishedProject(params.projectId);\ndecision.reduce(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'single-toSorted-no-callback',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(first:{allowed:boolean},_second:{allowed:boolean}){first.allowed=true;return 0;}\nawait requirePublishedProject(params.projectId);\ndecision.toSorted(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
  {
    id: 'readonly-native-comparator',
    source:
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\nfunction read(first:{allowed:boolean},second:{allowed:boolean}){return Number(first.allowed)-Number(second.allowed);}\nawait requirePublishedProject(params.projectId);\ndecision.toSorted(read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    refused: true,
    reason: 'mutated',
  },
] as const;

describe('named native middleware collection handoffs', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused, reason }) => {
    const app = await application({ [FILE]: source });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const contains = expect.stringContaining(reason);
    const expected = refused ? [contains] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
