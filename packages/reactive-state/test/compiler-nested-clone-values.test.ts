import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Cloning consumes enumerable own data values but ignores symbol and inherited fields. */
describe('nested source-written structured clone values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'structuredClone({value:()=>0})',
    'structuredClone({nested:[{value:function(){}}]})',
    'structuredClone([()=>0])',
    "structuredClone({value:Symbol('bad')})",
    'structuredClone([{inner:{value:new WeakMap()}}])',
    '(()=>{const value={entry:()=>0};return structuredClone(value);})()',
    'structuredClone({run(){return 0;}})',
    "(()=>{const key='value';return structuredClone({[key]:()=>0});})()",
  ])('refuses a known uncloneable nested value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "structuredClone({[Symbol('ignored')]:()=>0,value:first})",
    'structuredClone({nested:[{value:first},1n,undefined]})',
    'structuredClone({value:()=>0,value:first})',
    'structuredClone({get value(){return first;}})',
    '(()=>{const value={get first(){this.bad=first as never;return 0;},bad:()=>0};return structuredClone(value);})()',
    'structuredClone({value:()=>0,...{value:first}})',
    '(()=>{try{return structuredClone({value:()=>0});}catch{return first;}})()',
    'false&&structuredClone({value:()=>0})',
    '(()=>structuredClone({value:()=>0}))',
    '(()=>{const saved=structuredClone;try{globalThis.structuredClone=(()=>0) as never;return structuredClone({value:()=>0});}finally{globalThis.structuredClone=saved;}})()',
    'structuredClone({__proto__:{value:()=>0},own:first})',
    'structuredClone({set value(_value:string){}})',
  ])('keeps clone traversal and effect boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

async function fixture(expression: string): Promise<Application> {
  return application({
    'components/nested-clone-values.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function NestedCloneValues({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
