import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Symbol conversions keep their behavior when the callable is held under another name. */
describe('written Symbol conversion callee aliases', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const convert=Number;return convert(Symbol("x") as never);})()',
    '(()=>{const convert=Number.parseInt;return convert(Symbol("x") as never,10);})()',
    '(()=>{const convert=Number.parseFloat;return convert(Symbol("x") as never);})()',
    '(()=>{const convert=parseInt;return convert(Symbol("x") as never,10);})()',
    '(()=>{const math=Math;return math.abs(Symbol("x") as never);})()',
    '(()=>{const globals=globalThis;return globals.Number(Symbol("x") as never);})()',
    '(()=>{const Native=Number;return new Native(Symbol("x") as never);})()',
    '(()=>{const Native=String;return new Native(Symbol("x") as never);})()',
    '(()=>{const Native=Date;return new Native(Symbol("x") as never);})()',
    '(()=>{const convert=encodeURIComponent;return convert(Symbol("x") as never);})()',
  ])('refuses the native conversion through an unchanged alias: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const convert=String;return convert(Symbol("x"));})()',
    '(()=>{const Native=Boolean;return new Native(Symbol("x"));})()',
    '(()=>{const Number=(_value:unknown)=>0;return Number(Symbol("x"));})()',
    '(()=>{let convert=(value:unknown):unknown=>Number(value);convert=()=>0;return convert(Symbol("x"));})()',
    '(()=>{const Number={parseInt:(_value:unknown)=>0};return Number.parseInt(Symbol("x"));})()',
    '(()=>{const convert=Number;return ()=>convert(Symbol("x") as never);})()',
    '(()=>{const convert=Number;try{convert(Symbol("x") as never);}catch{}return first;})()',
    '(()=>{const convert=Number;return false&&convert(Symbol("x") as never);})()',
    '(()=>{const convert=Number.parseFloat;return (convert as Function)("1",Symbol("ignored"));})()',
    '(()=>{const convert=Number.parseInt;return (convert as Function)("1",10,Symbol("ignored"));})()',
    '(()=>{let convert:(value:unknown)=>unknown=Number;convert=()=>0;return convert(Symbol("changed"));})()',
    '(()=>{const math=Math;const saved=math.abs;try{math.abs=(()=>0) as never;return math.abs(Symbol("changed") as never);}finally{math.abs=saved;}})()',
  ])('keeps valid, shadowed, changed, ignored and deferred conversions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The authority evaluates the conversion before receiving the trailing JSON string. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/symbol-callee-alias.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function SymbolCalleeAlias({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
