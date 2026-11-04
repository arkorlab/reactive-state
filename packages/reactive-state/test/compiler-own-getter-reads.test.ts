import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** An ordinary property read executes only the getter its final own descriptor retains. */
describe('ordinary own getter reads', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '(({get value(){throw new Error("bad");}} as any).value,"ok")' },
    {
      declaration:
        'const KEY="value";const box={get [KEY](){throw new Error("bad");}};const alias=box;',
      expression: '(alias[KEY],"ok")',
    },
    {
      expression: '({get value(){throw new Error("bad");},set value(value:unknown){}}.value,"ok")',
    },
    {
      expression: '({set value(value:unknown){},get value(){throw new Error("bad");}}.value,"ok")',
    },
    { expression: '({value:"safe",get value(){throw new Error("bad");}}.value,"ok")' },
    { expression: '({get value(){return decodeURIComponent("%");}}.value,"ok")' },
    { expression: '(({get value(){throw new Error("bad");}} as any).value(),"ok")' },
    {
      declaration: 'const box={get value(){throw new Error("bad");},set value(value:unknown){}};',
      expression: '(box.value+=1,"ok")',
    },
  ])('refuses a read that invokes the selected throwing getter: $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    { expression: '({get value(){throw new Error("unused");}},"ok")' },
    { expression: '({get value(){throw new Error("unused");},value:"safe"}.value,"ok")' },
    {
      expression: '({get value(){throw new Error("unused");},value(){return "safe";}}.value,"ok")',
    },
    {
      expression:
        '({get value(){throw new Error("unused");},get value(){return "safe";}}.value,"ok")',
    },
    { expression: '({set value(value:unknown){throw new Error("unused");}}.value,"ok")' },
    {
      expression:
        '(()=>{try{({get value(){throw new Error("caught");}}).value;}catch{}return "ok";})()',
    },
    { expression: '(false&&({get value(){throw new Error("skipped");}}).value,"ok")' },
    { expression: '(()=>({get value(){throw new Error("deferred");}}).value,"ok")' },
    { expression: '({get value(){return "safe";}}.value,"ok")' },
    {
      declaration:
        'const box={get value(){throw new Error("unused");},set value(value:unknown){}};',
      expression: '(box.value=1,"ok")',
    },
    {
      declaration:
        'const box={get value(){throw new Error("unused");},set value(value:unknown){}};',
      expression: '(({value:box.value}={value:1}),"ok")',
    },
    {
      declaration: 'const box={get value(){throw new Error("unused");}};',
      expression: '(delete box.value,"ok")',
    },
    {
      expression:
        '(()=>{const box={get value(){throw new Error("replaced");}};Object.defineProperty(box,"value",{value:"safe"});return(box.value,"ok");})()',
    },
  ])('keeps an unused, replaced, caught or returning getter: $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

interface GetterRead {
  readonly declaration?: string;
  readonly expression: string;
}

/** The authority evaluates the expression before carrying the local input to a dynamic child. */
async function fixture(row: GetterRead): Promise<Application> {
  return application({
    'components/own-getter-read.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function OwnGetterRead({projectId,first}:{projectId:string;first:string}){',
      row.declaration ?? '',
      `const [selected,setSelected]=useReactiveState<string>(first===""?(${row.expression}):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
