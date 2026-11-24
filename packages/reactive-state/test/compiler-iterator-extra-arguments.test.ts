import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Quiet extra arguments preserve iterator acquisition before mapping or ignored-argument handling. */
describe('iterator consumers with extra arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.from({get [Symbol.iterator](){throw new Error("bad");}},value=>value)',
    'Array.from({[Symbol.iterator](){throw new Error("bad");}},value=>value,null)',
    'Uint8Array.from({get [Symbol.iterator](){throw new Error("bad");}},value=>value)',
    'BigInt64Array.from({[Symbol.iterator](){throw new Error("bad");}},()=>1n)',
    'new Set({get [Symbol.iterator](){throw new Error("bad");}},0)',
    'new Map({[Symbol.iterator](){throw new Error("bad");}},null)',
    'Object.fromEntries({get [Symbol.iterator](){throw new Error("bad");}},0)',
    'Iterator.from({get [Symbol.iterator](){throw new Error("bad");}},0)',
    'Array.from({[Symbol.iterator]:1} as never,()=>0)',
    'new WeakSet({[Symbol.iterator](){throw new Error("bad");}}, {})',
    'Array.from({get [Symbol.iterator](){throw new Error("bad");}},()=>{Array.from=(()=>[]) as never;return 1;})',
  ])('refuses iterator failures before quiet arguments are used: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.from({*[Symbol.iterator](){yield 1;}},value=>value,0)',
    'Uint8Array.from({*[Symbol.iterator](){yield 1;}},value=>value)',
    '(()=>{const source={get [Symbol.iterator](){throw new Error("repaired");}};return Array.from(source,(Object.defineProperty(source,Symbol.iterator,{value:function*(){yield 1;}}),value=>value));})()',
    '(()=>{const source={get [Symbol.iterator](){throw new Error("repaired");}};return Uint8Array.from(source,(Object.defineProperty(source,Symbol.iterator,{value:function*(){yield 1;}}),value=>value));})()',
    '(()=>{const source={get [Symbol.iterator](){throw new Error("repaired");}};return new Set(source,Object.defineProperty(source,Symbol.iterator,{value:function*(){yield 1;}}));})()',
    '(()=>{const source={get [Symbol.iterator](){throw new Error("repaired");}};const repair={get mapper(){Object.defineProperty(source,Symbol.iterator,{value:function*(){yield 1;}});return(value:unknown)=>value;}};return Array.from(source,repair.mapper);})()',
    '(()=>{const source={get [Symbol.iterator](){throw new Error("repaired");}};return new Set(source,class{static{Object.defineProperty(source,Symbol.iterator,{value:function*(){yield 1;}});}});})()',
    'Array.from(first as never,value=>value)',
    '(()=>{try{return Array.from({get [Symbol.iterator](){throw new Error("caught");}},value=>value);}catch{return first;}})()',
    'false&&Array.from({get [Symbol.iterator](){throw new Error("skipped");}},value=>value)',
    '()=>Array.from({get [Symbol.iterator](){throw new Error("deferred");}},value=>value)',
    '(()=>{const saved=Array.from;try{Array.from=(()=>[]) as never;return Array.from({get [Symbol.iterator](){throw new Error("unused");}},value=>value);}finally{Array.from=saved;}})()',
  ])('keeps iterable results, repairs and evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Iterator acquisition occurs before the authority receives the trailing ordinary JSON string. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/iterator-extra-arguments.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function IteratorExtraArguments({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
