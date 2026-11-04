import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** An ordinary object's inherited instance hook can be installed before its literal is created. */
describe('written inherited instance hooks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});',
    'Reflect.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});',
    '(Object.prototype as any)[Symbol.hasInstance]=()=>false;',
    'function install(){Object.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});}install();',
  ])('keeps a source-installed inherited callable hook: %s', async (setup) => {
    const app = await fixture(setup);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'Math.max(0,1);',
    'Object.defineProperty({},Symbol.hasInstance,{value(){return false;},configurable:true});',
    'Object.defineProperty(Object.prototype,"reviewMarker",{value:1,configurable:true});',
    'Object.defineProperty(Object.prototype,Symbol.hasInstance,{value:1,configurable:true});',
    'Object.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});delete(Object.prototype as any)[Symbol.hasInstance];',
    'function unused(){Object.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});}',
  ])('still refuses a target with no callable inherited hook: %s', async (setup) => {
    const app = await fixture(setup);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it('keeps a null prototype separate from an earlier ordinary inherited hook', async () => {
    const app = await fixture(
      'Object.defineProperty(Object.prototype,Symbol.hasInstance,{value(){return false;},configurable:true});',
      '{__proto__:null}',
    );
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** Each source probe restores the prototype, so successful and failing operations stay isolated. */
async function fixture(setup: string, target = '{}'): Promise<Application> {
  return application({
    'components/instanceof-inheritance.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function InstanceofInheritance({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(()=>{${setup}try{return(1 instanceof(${target} as never),'ok');}finally{delete(Object.prototype as any)[Symbol.hasInstance];delete(Object.prototype as any).reviewMarker;}})():first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
