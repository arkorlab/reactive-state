import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only Proxy values that reach a site's measured expressions require a static refusal. */
describe('source Proxy origins in dynamic sites', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { declaration: 'const carrier=new Proxy({value:first},{});' },
    {
      declaration:
        'const Wrap=globalThis.Proxy;const original=new Wrap({value:first},{});const carrier=original;',
    },
    {
      declaration: 'function create(){return new Proxy({value:first},{});}const carrier=create();',
    },
    { declaration: 'const box={nested:new Proxy({value:first},{})};const carrier=box.nested;' },
    {
      declaration:
        'const box={get nested(){return new Proxy({value:first},{});}};const carrier=box.nested;',
    },
    {
      declaration: 'const carrier=new Proxy({value:first},{});',
      jsx: '{identity(carrier,text).value&&<TodoCommands projectId={projectId} id={text}/>}',
      reason: 'computed in the server part',
    },
    {
      declaration: 'const carrier=new Proxy([{id:first}],{});',
      jsx: '{identity(carrier,text).map(item=><TodoCommands key={item.id} projectId={projectId} id={item.id}/>)}',
    },
  ])('refuses a component Proxy reaching a measured site: $declaration', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('reason' in row ? row.reason : 'Proxy'),
    ]);
  });

  // A written arrow's answer reaches the site as a measured call's would: the arrow with a body
  // of an expression answers it, as `() => carrier` does.
  it.each([
    '<TodoCommands projectId={projectId} id={[text].map(()=>carrier)[0]!.value}/>',
    '<TodoCommands projectId={projectId} id={identity(()=>carrier,text)().value}/>',
  ])('refuses a component Proxy a written arrow answers into a measured site: %s', async (jsx) => {
    const app = await fixture({ declaration: 'const carrier=new Proxy({value:first},{});', jsx });
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  // What the measured arrow answers is read in its own scope: its parameter is the element `map`
  // hands it, here an ordinary object, and not the Proxy the component holds beside it.
  it('keeps a concise arrow that answers its own parameter, beside a component Proxy', async () => {
    const app = await fixture({
      declaration: 'const carrier=new Proxy({value:first},{});void carrier;',
      jsx: '<TodoCommands projectId={projectId} id={[{value:text}].map((each)=>each)[0]!.value}/>',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  // A write of the parameter under a condition is not read as the one value the helper answers:
  // what it was handed stays among them, whatever the condition is.
  it('refuses a component Proxy the helper replaces under a condition', async () => {
    const app = await fixture({
      declaration: 'const carrier=new Proxy({value:first},{});',
      domain:
        'export function identity(input:{value:string},_text:string){if(true){input={value:"safe"};}return input;}',
    });
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  it.each([
    { declaration: 'const carrier=true?{value:first}:new Proxy({value:first},{});' },
    { declaration: 'const carrier={value:new Proxy({},{}),value:first};' },
    {
      declaration:
        'const holder={value:new Proxy({value:first},{})};[holder.value]=[{value:first}];const carrier=holder.value;',
    },
    {
      declaration:
        'const unused=new Proxy({value:first},{});const carrier={value:first};void unused;',
    },
    {
      declaration:
        'function create(){new Proxy({},{});return {value:first};}const carrier=create();',
    },
    { declaration: 'const carrier={value:String(new Proxy({toString(){return first;}},{}))};' },
    { declaration: 'const carrier={value:first,get unused(){return new Proxy({},{});}};' },
    {
      declaration: 'const carrier={value:first};',
      handler: 'const copy=new Proxy({value:first},{});setText(copy.value);',
    },
    {
      declaration: 'function Proxy<T>(value:T):T{return value;}const carrier=Proxy({value:first});',
    },
    {
      declaration: 'const carrier={value:first};',
      domain:
        'export function identity(input:{value:string},_text:string){const proxy=new Proxy({toString(){return input.value;}},{});return {value:String(proxy)};}',
    },
  ])(
    'keeps Proxy work whose result does not reach the measured value: $declaration',
    async (row) => {
      const app = await fixture(row);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

interface ProxySite {
  readonly declaration: string;
  readonly domain?: string;
  readonly jsx?: string;
  readonly handler?: string;
}

/** A shared identity exposes its argument's actual value at the counted call boundary. */
async function fixture(row: ProxySite): Promise<Application> {
  return application({
    'domain/site-proxy.ts':
      row.domain ?? 'export function identity<T>(input:T,_text:string):T{return input;}',
    'components/site-proxy.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {identity} from '@/domain/site-proxy';",
      'export default function SiteProxy({projectId,first}:{projectId:string;first:string}){',
      row.declaration,
      'const [text,setText]=useReactiveState<string>(first);',
      `return<section><button onClick={()=>{${row.handler ?? 'setText(first);'}}}>reset</button>${row.jsx ?? '<TodoCommands projectId={projectId} id={identity(carrier,text).value}/>'}</section>;}`,
    ].join('\n'),
  });
}
