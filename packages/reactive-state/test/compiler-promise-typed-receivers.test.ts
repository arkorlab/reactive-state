import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Typed-array construction never initializes the functions of a new Promise capability. */
describe('promise factories with typed-array constructors', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Promise.resolve.call(Uint8Array,1)',
    'Promise.reject.call(BigInt64Array,1)',
    'Promise.all.call(Float64Array,[])',
    'Promise.allSettled.call(Uint16Array,[])',
    'Promise.any.call(Int8Array,[])',
    'Promise.race.call(Uint8ClampedArray,[])',
    'Promise.resolve.apply(Float16Array,[1])',
    'Reflect.apply(Promise.resolve,BigUint64Array,[1])',
    '(()=>{const Receiver=Uint32Array;return Promise.resolve.call(Receiver,1);})()',
  ])('refuses missing capability initialization: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Promise.resolve.call(Promise,1)',
    'Promise.all.call(class extends Promise{},[])',
    'Uint8Array.of.call(Uint8Array,1)',
    'Uint16Array.from.call(Uint8Array,[1,2])',
    '(()=>{function keep(value:unknown){return Promise.resolve.call(Uint8Array,value);}const value=Promise.resolve(first);Object.defineProperty(value,"constructor",{value:Uint8Array});return keep(value);})()',
    '(()=>{const saved=Promise.resolve;try{Promise.resolve=(()=>first) as never;return Promise.resolve.call(Uint8Array,1);}finally{Promise.resolve=saved;}})()',
    '(()=>{try{return Promise.resolve.call(Uint8Array,1);}catch{return first;}})()',
    'false&&Promise.resolve.call(Uint8Array,1)',
    '()=>Promise.resolve.call(Uint8Array,1)',
    '(()=>{class Uint8Array{constructor(executor:Function){executor(()=>{},()=>{});}}return Promise.resolve.call(Uint8Array,1);})()',
    '(()=>{let Receiver=Uint8Array;Receiver=class{constructor(executor:Function){executor(()=>{},()=>{});}} as never;return Promise.resolve.call(Receiver,1);})()',
  ])('keeps valid factories, early returns and runtime boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The factory runs before an authority-started ordinary JSON string is produced. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/promise-typed-receivers.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function PromiseTypedReceivers({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
