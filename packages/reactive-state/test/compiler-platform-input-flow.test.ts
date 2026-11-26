import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Platform input proofs follow repeated reads and the invocation of captured local bindings. */
describe('shared platform input execution order', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'let url="https://example.test/";for(let i=0;i<2;i++){new Request(url);url="/relative";}return text;',
    'let url="https://example.test/";let i=0;while(i++<2){new Request(url);url="/relative";}return text;',
    'let url="https://example.test/";let i=0;do{new Request(url);url="/relative";}while(++i<2);return text;',
    'let url="https://example.test/";for(const item of [0,1]){void item;new Request(url);url="/relative";}return text;',
    'let url="https://example.test/";const make=()=>new Request(url);url="/relative";return text+make().url;',
    'let url="https://example.test/";function make(){return new Request(url);}url="/relative";return text+make().url;',
    'const options:BlobPropertyBag={endings:"transparent"};let answer=0;for(let i=0;i<2;i++){answer+=new Blob([text],options).size;options.endings="native";}return text+answer;',
    'const options:BlobPropertyBag={endings:"transparent"};const make=()=>new Blob([text],options);options.endings="native";return text+make().size;',
    'let url="https://example.test/";for(let i=0;i<2;i++){Response.redirect(url);url="/relative";}return text;',
  ])('refuses a prior write across repeated or deferred reads: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('a shared module that answers otherwise'),
    ]);
  });

  it.each([
    'let url="https://example.test/";const request=new Request(url);url="/relative";return text+request.url;',
    'let url="https://example.test/";const make=()=>new Request(url);const request=make();url="/relative";return text+request.url;',
    'let url="https://example.test/";const make=()=>new Request(url);url="/relative";return text;',
    'let url="https://example.test/";function make(){return new Request(url);}url="/relative";return text;',
    'for(let i=0;i<2;i++){let url="https://example.test/";new Request(url);url="/relative";}return text;',
    'let url="https://example.test/";for(let i=0;i<2;i++){new Request(url);url="https://example.test/next";}return text;',
    'const options:BlobPropertyBag={endings:"transparent"};for(let i=0;i<2;i++){new Blob([text],options);options.type="text/plain";}return text;',
    'let url="https://example.test/";const make=()=>new Request(url);url="https://example.test/next";return text+make().url;',
    'let url="https://example.test/";const make=()=>new Request(url);{let url="/relative";url="/other";}return text+make().url;',
    'let url="https://example.test/";for(let i=0;i<2;i++){{let url="/relative";url="/other";}new Request(url);}return text;',
    'let url="https://example.test/";for(let i=0;i<2;i++){new Request(url);}url="/relative";return text;',
    'let url="https://example.test/";const request=(()=>{try{return new Request(url);}catch{return new Request("https://example.test/fallback");}})();url="/relative";return text+request.url;',
  ])(
    'keeps fresh iterations, unused closures and writes after the final read: %s',
    async (body) => {
      const app = await fixture(body);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

/** A shared function is checked independently of any particular invocation's text. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/platform-input-flow.ts': `export function label(text:string){${body}}`,
    'components/platform-input-flow.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {label} from '@/domain/platform-input-flow';",
      'export default function PlatformInputFlow({projectId,first}:{projectId:string;first:string}){',
      'const [selected,setSelected]=useReactiveState(first);',
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)}/></section>;}',
    ].join('\n'),
  });
}
