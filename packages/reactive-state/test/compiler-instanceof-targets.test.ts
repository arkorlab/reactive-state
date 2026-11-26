import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A noncallable object needs a callable Symbol.hasInstance method to be an instanceof target. */
describe('written instanceof object targets', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '1 instanceof ({} as never)' },
    { expression: '1 instanceof ({held:1} as never)' },
    { expression: '({}) instanceof ({} as never)' },
    { expression: '1 instanceof ({__proto__:null} as never)' },
    { expression: '1 instanceof ({[Symbol.hasInstance]:1} as never)' },
    { expression: '1 instanceof ({[Symbol.hasInstance]:null} as never)' },
    { expression: '1 instanceof (matcher as never)', declaration: 'const matcher={};' },
    { expression: '1 instanceof ({"Symbol.hasInstance":true} as never)' },
  ])('refuses a noncallable object with no instance hook: $expression', async (row) => {
    const app = await fixture(row.expression, 'declaration' in row ? row.declaration : '');
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '({}) instanceof (function(){})',
    '({}) instanceof (class {})',
    '1 instanceof (()=>0)',
    '1 instanceof ({[Symbol.hasInstance](){return true;}} as never)',
    '1 instanceof ({[Symbol.hasInstance]:()=>true} as never)',
    '1 instanceof ({__proto__:{[Symbol.hasInstance](){return true;}}} as never)',
    '1 instanceof ({get [Symbol.hasInstance](){return ()=>true;}} as never)',
    '1 instanceof ((()=>{void first;return class {};})() as never)',
    '(()=>{try{return 1 instanceof ({} as never);}catch{return false;}})()',
    '(()=>1 instanceof ({} as never))',
    'false && (1 instanceof ({} as never))',
    '(()=>{try{return 1 instanceof ({noise:Object.defineProperty(Object.prototype,Symbol.hasInstance,{value:()=>true,configurable:true})} as never);}finally{Reflect.deleteProperty(Object.prototype,Symbol.hasInstance);}})()',
  ])('keeps callable hooks and unknown, caught or deferred targets: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The discarded membership result is computed before a JSON state value is selected. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/instanceof-targets.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function InstanceofTargets({projectId,first}:{projectId:string;first:string}){',
      declaration,
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
