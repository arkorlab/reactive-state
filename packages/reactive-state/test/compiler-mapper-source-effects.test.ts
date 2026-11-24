import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source creation and the first consumed getter run before a native factory invokes its mapper. */
describe('native mapper source effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.from({get 0(){globalThis.decodeURIComponent=()=>"ok";return first;},length:1},()=>decodeURIComponent("%"))',
    'Array.from([(globalThis.decodeURIComponent=()=>"ok")],()=>decodeURIComponent("%"))',
    'Array.from({get 0(){globalThis.decodeURIComponent=()=>"ok";return first;},set 0(value:unknown){},length:1},()=>decodeURIComponent("%"))',
    'Uint8Array.from({get 0(){globalThis.decodeURIComponent=()=>"0";return 1;},length:1},()=>decodeURIComponent("%"))',
    'Array.from({0:first,get length(){globalThis.decodeURIComponent=()=>"ok";return 1;}},()=>decodeURIComponent("%"))',
  ])('keeps prior source effects that can repair a later mapper: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'Array.from([()=>decodeURIComponent("%")],()=>{throw new Error("mapper");})',
    'Array.from({0:first,length:1,get unused(){globalThis.decodeURIComponent=()=>"ok";return first;}},()=>decodeURIComponent("%"))',
    'Array.from({0:first,get 1(){globalThis.decodeURIComponent=()=>"ok";return first;},length:2},()=>decodeURIComponent("%"))',
    'Array.from({set 0(value:unknown){globalThis.decodeURIComponent=()=>"ok";},length:1},()=>decodeURIComponent("%"))',
    'Array.from({get 0(){globalThis.decodeURIComponent=()=>"ok";return first;},0:first,length:1},()=>decodeURIComponent("%"))',
  ])(
    'still refuses before an unused, deferred or overwritten source effect: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
        expect.stringContaining('no JSON holds'),
      ]);
    },
  );
});

/** Restoring the intrinsic isolates the native witnesses while the authority discards the result. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/mapper-source-effects.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function MapperSourceEffects({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(()=>{const original=decodeURIComponent;try{return(${expression},'ok');}finally{globalThis.decodeURIComponent=original;}})():first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
