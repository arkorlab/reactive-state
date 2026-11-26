import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, type Application, node, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Authority-evaluated local inputs are sent as values rather than recomputed in the browser. */
describe('page-local state initial globals', () => {
  const { apps, compile } = compilerApplications();

  it.each([{ expression: 'String(Date.now())' }, { expression: 'first+Date.now()', hook: true }])(
    'refuses a site state that reads an impure global: $expression',
    async (row) => {
      const app = await fixture(row);
      apps.push(app);

      const compiled = compile(app);

      expect(compiled.refusals).toHaveLength(1);
      expect(compiled.refusals[0]?.reason).toContain('local state');
    },
  );

  it.each([
    { expression: 'first+Date.now()' },
    { expression: 'first+Date()' },
    { expression: 'first+crypto.randomUUID()' },
    { expression: 'first+String(performance.now())' },
    { expression: 'first+Math.random()' },
    { expression: 'first+stamp', setup: 'const stamp=Date.now();' },
    { expression: 'first' },
    { expression: "first+':fixed'" },
    { expression: 'String(Number(first)+1)' },
    { expression: 'String(Math.abs(Number(first)))' },
    { expression: 'first+JSON.stringify([1])' },
    { expression: 'prepared', setup: "const prepared=first+':fixed';" },
    { expression: 'decorate(first)' },
    { expression: "'fixed'" },
    { expression: 'first+Date.now()', site: false },
  ])('keeps page values and browser-only local state semantics: $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/local-state-starts.client.tsx')).toContain(
      'localOf<States["selected"]>',
    );
  });

  it('uses the emitted initial value for localOf and later site inputs without reading the clock', async () => {
    const app = await fixture({ expression: 'first+Date.now()' });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    const client = output(compiled, app, 'components/local-state-starts.client.tsx');

    expect(client).toContain('localOf<States["selected"]>');
    expect(client).not.toContain('Date.now()');

    writeOutputs(compiled.outputs, app.out);
    const program = path.join(app.out, 'components/local-state-starts.authority.mts');
    const state = fileURLToPath(new URL('../src/react/state.ts', import.meta.url));
    const ran = node(
      [
        "const {registerPaths}=await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const {localOf}=await import(${JSON.stringify(state)});`,
        `const {evaluate}=await import(${JSON.stringify(program)});`,
        'const $={client:part=>part,counted:value=>value,h:(type,props,...children)=>({type,props,children})};',
        'const original=Date.now;let calls=0;Date.now=()=>++calls;',
        'try{',
        "const part=evaluate({projectId:'p',first:'base'},$);",
        'const {d0}=part.sites;',
        'const initial=part.states.selected;',
        'const input=localOf({states:{selected:{value:initial}}},"selected");',
        'const first=d0.render({selected:input.value}).props.id;',
        "const changed=d0.render({selected:'changed'}).props.id;",
        'console.log(JSON.stringify({calls,initial,received:input.value,first,changed}));',
        '}finally{Date.now=original;}',
      ].join('\n'),
      app.root,
    );

    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual({
      calls: 1,
      initial: 'base1',
      received: 'base1',
      first: 'base1',
      changed: 'changed',
    });
  });
});

interface Start {
  readonly expression: string;
  readonly hook?: boolean;
  readonly setup?: string;
  readonly site?: boolean;
}

/** A prop-read first value is evaluated by the authority; the child makes it a dynamic-site input. */
async function fixture(row: Start): Promise<Application> {
  const state =
    row.hook === true
      ? `const {held:selected,setHeld:setSelected}=useLocal(${row.expression});`
      : `const [selected,setSelected]=useReactiveState<string>(${row.expression});`;
  return application({
    'components/local-state-starts.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {decorate} from '@/domain/local-state-start';",
      ...(row.hook === true ? ["import {useLocal} from '@/hooks/use-local-start';"] : []),
      'export default function LocalStateStarts({projectId,first}:{projectId:string;first:string}){',
      row.setup ?? '',
      state,
      'return<section><button onClick={()=>setSelected(first)}>reset</button>',
      row.site === false ? '{selected}' : '<TodoCommands projectId={projectId} id={selected}/>',
      '</section>;}',
    ].join('\n'),
    'domain/local-state-start.ts':
      "export function decorate(input:string):string{return input+':fixed';}",
    'hooks/use-local-start.ts': [
      "import {useReactiveState} from 'framework/react';",
      'export function useLocal(initial:string){',
      'const [held,setHeld]=useReactiveState(initial);',
      'return {held,setHeld};}',
    ].join('\n'),
  });
}
