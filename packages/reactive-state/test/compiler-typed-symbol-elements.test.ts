import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native typed element conversion never accepts a symbol, for either numeric element kind. */
describe('symbols in native typed array elements', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new Uint8Array([Symbol('value') as never])",
    "new BigInt64Array([Symbol('value') as never])",
    'new Int16Array([Symbol.iterator as never])',
    "(()=>{const value=Symbol('held');return new Float64Array([value as never]);})()",
    "Uint8Array.of(Symbol('value') as never)",
    "BigUint64Array.from([Symbol('value') as never])",
    "new Uint8Array(1).set([Symbol('value') as never])",
    "new BigInt64Array(1).fill(Symbol('value') as never)",
  ])('refuses a source-written symbol element: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    'new Uint8Array([1,true as never])',
    "new BigInt64Array(['3' as never,true as never])",
    "Uint8Array.from([Symbol('value')],()=>1)",
    "(()=>{try{return new Uint8Array([Symbol('value') as never]);}catch{return first;}})()",
    "false&&new BigInt64Array([Symbol('value') as never])",
    "(()=>{const saved=Symbol;try{globalThis.Symbol=(()=>1) as never;return new Uint8Array([Symbol('replaced') as never]);}finally{globalThis.Symbol=saved;}})()",
  ])('keeps conversion and evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

async function fixture(expression: string): Promise<Application> {
  return application({
    'components/typed-symbol-elements.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function TypedSymbolElements({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
