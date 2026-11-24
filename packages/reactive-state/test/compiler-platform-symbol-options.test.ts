import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native platform dictionaries convert consumed values while ignoring other symbol entries. */
describe('written platform symbol options', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new Response(null,{status:Symbol("bad") as never})',
    'new Response(null,{statusText:Symbol("bad") as never})',
    'new Response(null,{status:Symbol.iterator as never})',
    'new Request("https://example.test",{method:Symbol("bad") as never})',
    'new Blob([],{type:Symbol("bad") as never})',
    'new Blob([],{endings:Symbol("bad") as never})',
    'new File([],"entry",{lastModified:Symbol("bad") as never})',
    'new ByteLengthQueuingStrategy({highWaterMark:Symbol("bad") as never})',
    'new CountQueuingStrategy({highWaterMark:Symbol("bad") as never})',
    'new ReadableStream(undefined,{highWaterMark:Symbol("bad") as never})',
    'new Headers({entry:Symbol("bad")} as never)',
    '(()=>{const marker=Symbol;return new Response(null,{status:marker("bad") as never});})()',
  ])('refuses a consumed symbol conversion: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new Response(null,{status:200,statusText:"ok"})',
    'new Response(null,{unused:Symbol("ignored")} as never)',
    'new Response(null,{status:Symbol("overwritten"),status:200})',
    'new Event("ready",{bubbles:Symbol("truthy") as never})',
    'new TextDecoder("utf-8",{fatal:Symbol("truthy") as never})',
    'new Blob([],{unused:Symbol("ignored")} as never)',
    'new CountQueuingStrategy({highWaterMark:1,unused:Symbol("ignored")} as never)',
    '(()=>{class Response{constructor(...given:unknown[]){void given;}}return new Response(null,{status:Symbol("raw")});})()',
    '(()=>{const saved=Response;try{globalThis.Response=class{} as never;return new Response(null,{status:Symbol("raw") as never});}finally{globalThis.Response=saved;}})()',
    '(()=>{const saved=Response;try{return(globalThis.Response=class{} as never,(()=>new Response(null,{status:Symbol("raw") as never}))());}finally{globalThis.Response=saved;}})()',
    '(()=>{const saved=Symbol;try{globalThis.Symbol=Object.setPrototypeOf((()=>200) as never,saved);return new Response(null,{status:Symbol("numeric") as never});}finally{globalThis.Symbol=saved;}})()',
    '(()=>{const options:any={status:Symbol("repaired")};options.status=200;return new Response(null,options);})()',
    '(()=>{const options:any={status:Symbol("repaired")};return new Response(null,options,options.status=200);})()',
    'new Response(null,{status:{[Symbol.toPrimitive](){return 200;}} as never})',
    'new Response(null,{[Symbol("ignored")]:1} as never)',
    'new Response(null,{status:200},Symbol("ignored"))',
    'new Response(null,{status:first as never})',
    '(()=>{try{return new Response(null,{status:Symbol("caught") as never});}catch{return first;}})()',
    'false&&new Response(null,{status:Symbol("skipped") as never})',
    '()=>new Response(null,{status:Symbol("deferred") as never})',
  ])('keeps ignored, boolean, replaced and handled symbol values: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The constructor runs before an authority-started ordinary JSON string is produced. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/platform-symbol-options.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function PlatformSymbolOptions({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
