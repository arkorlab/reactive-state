import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Shared function parameters keep their lexical identity when a module declares the same name. */
describe('shared module callable shadowing', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'function make(){return new Date(0);}function invoke(make:()=>string){return make();}export function selected(input:string){return invoke(()=>input);}',
    'import {make} from "./shadowed-maker";function invoke(make:()=>string){return make();}export function selected(input:string){return invoke(()=>input);}',
    'function make(){return new Date(0);}export function selected(input:string){return ((make:()=>string)=>make())(()=>input);}',
    'function make(){return new Date(0);}function invoke({make}:{make:()=>string}){return make();}export function selected(input:string){return invoke({make:()=>input});}',
    'function make(){return new Date(0);}function invoke(make:()=>string){return (()=>make())();}export function selected(input:string){return invoke(()=>input);}',
    'const make=()=>new Date(0);function invoke(make:()=>string){return make();}export function selected(input:string){return invoke(()=>input);}',
    'function make(){return new Date(0);}export function selected(input:string){const make=()=>input;return make();}',
    'function make(){return new Date(0);}function invoke(other:()=>string){return other();}export function selected(input:string){return invoke(()=>input);}',
  ])('keeps a JSON call through its own local binding: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'function make(){return new Date(0);}export function selected(_input:string){return make();}',
    'import {make} from "./shadowed-maker";export function selected(_input:string){return make();}',
    'function make(){return new Date(0);}function unused(make:()=>string){return make();}export function selected(_input:string){return make();}',
    'export function selected(_input:string){function make(){return new Date(0);}return make();}',
  ])('still refuses the non-JSON function that the call actually names: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** A shared result is used directly as an authority-started state's input. */
async function fixture(module: string): Promise<Application> {
  return application({
    'domain/shadowed-maker.ts': 'export function make(){return new Date(0);}',
    'domain/module-call-shadowing.ts': module,
    'components/module-call-shadowing.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import {selected as initial} from '@/domain/module-call-shadowing';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function ModuleCallShadowing({projectId,first}:{projectId:string;first:string}){',
      'const [selected,setSelected]=useReactiveState<string>(initial(first) as never);',
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
