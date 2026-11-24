import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Constructor formals shadow outer constants only inside their constructor body. */
describe('constructed source parameter scope', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      outer: 'const flag=true;',
      expression: 'new(class{constructor(flag:boolean){if(flag){throw new Error("bad");}}})(false)',
    },
    {
      outer: 'const flag=true;',
      expression: 'new(class{constructor(flag=false){if(flag){throw new Error("bad");}}})()',
    },
    {
      outer: 'const flag=true;',
      expression:
        'new(class{constructor(flag:boolean){if(flag){throw new Error("bad");}}})(first === "unsafe")',
    },
    {
      outer: 'const flag=true;',
      expression:
        'new(class{constructor(flag:boolean){(()=>{if(flag){throw new Error("bad");}})();}})(false)',
    },
    {
      outer: 'const flag=true;',
      expression:
        'new(class{constructor(flag:boolean){{const flag=false;if(flag){throw new Error("bad");}}}})(true)',
    },
    {
      outer: 'const flag=false;',
      expression:
        'new(class{constructor(flag:boolean){if(flag){throw new Error("unproven");}}})(true)',
    },
    {
      outer: 'const flag=false;',
      expression: 'new(class{constructor(flag=true){if(flag){throw new Error("unproven");}}})()',
    },
    {
      outer: 'const flag=false;',
      expression:
        'new(class{value=(()=>{if(flag){throw new Error("field");}})();constructor(flag:boolean){}})(true)',
    },
    {
      outer: 'const flag=true;',
      expression: '(class{constructor(flag:boolean){if(flag){throw new Error("deferred");}}})',
    },
    {
      outer: 'const flag=true;',
      expression:
        '(()=>{try{return new(class{constructor(flag:boolean){if(flag){throw new Error("caught");}}})(true);}catch{return 0;}})()',
    },
    {
      outer: 'const replacer=()=>{throw new Error("outer");};',
      expression:
        'new(class{constructor(replacer:()=>number){JSON.stringify({},replacer);}})(()=>0)',
    },
  ])('keeps a valid or unproven construction: $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    {
      outer: 'const flag=false;',
      expression: 'new(class{constructor(flag:boolean){throw new Error("bad");}})(false)',
    },
    {
      outer: 'const flag=true;',
      expression: 'new(class{constructor(flag:boolean){throw new Error("bad");}})(true)',
    },
    {
      outer: 'const flag=true;',
      expression:
        'new(class{value=(()=>{if(flag){throw new Error("field");}})();constructor(flag:boolean){}})(false)',
    },
    {
      outer: 'const flag=false;',
      expression:
        'new(class{static value=(()=>{throw new Error("definition");})();constructor(flag:boolean){}})(false)',
    },
  ])('refuses known throwing body or definition work: $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** Module constants reach the construction check through the initializer's outer resolver. */
async function fixture(row: {
  readonly outer: string;
  readonly expression: string;
}): Promise<Application> {
  return application({
    'domain/constructor-parameters.ts': [
      row.outer,
      `export function make(first:string){return (${row.expression},'ok');}`,
    ].join('\n'),
    'components/constructor-parameters.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {make} from '@/domain/constructor-parameters';",
      'export default function ConstructorParameters({projectId,first}:{projectId:string;first:string}){',
      'const [selected,setSelected]=useReactiveState<string>(make(first));',
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
