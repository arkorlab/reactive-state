import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Result shape depends on surviving properties, while evaluation can still fail first. */
describe('final selected JSON object properties', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "({value:new Date(0),...{value:'ok'}})",
    "({...{value:new Date(0)},value:'ok'})",
    "({...{value:new Date(0)},...{value:'ok'}})",
    "({value:()=>0,value:'ok'})",
    "({run(){return 0;},...{run:'ok'}})",
    "(()=>{const more={value:'ok'};return{value:new Date(0),...more};})()",
    "({value:new Date(0),...{...{value:'ok'}}})",
    "(()=>{const key='value';return{[key]:new Date(0),...{value:'ok'}};})()",
    "({get value(){throw new Error('unused');},...{value:'ok'}})",
    "({value:undefined,...{value:'ok'}})",
    "({['__proto__']:new Date(0),...{['__proto__']:'safe'}})",
    "({__proto__:null,value:new Date(0),...{value:'ok'}})",
  ])('accepts overwritten non-JSON property values: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "({value:'ok',...{value:new Date(0)}})",
    "({value:new Date(0),...{other:'ok'}})",
    "({value:new Date(0),...{[first]:'ok'}})",
    "(()=>{function other(){return{other:'ok'};}return{value:new Date(0),...other()};})()",
    "({value:decodeURIComponent('%'),...{value:'ok'}})",
    "({value:new Date(0),...{get value(){throw new Error('read');}}})",
    "({__proto__:{custom:true},...{__proto__:null},value:'ok'})",
    "({[Symbol('bad')]:new Date(0),...{value:'ok'}})",
  ])('refuses surviving non-JSON or creation-time exceptions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([
      expect.objectContaining({ reason: expect.stringContaining('no JSON holds') }),
    ]);
  });
});

async function fixture(expression: string): Promise<Application> {
  return application({
    'components/json-final-properties.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function JsonFinalProperties({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression}) as never:first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
