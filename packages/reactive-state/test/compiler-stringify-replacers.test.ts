import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Ignored JSON replacers do not hand a server constant to an unknown writing callback. */
describe('stringify replacers and local state inputs', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'null',
    'false',
    'true',
    '0',
    '1',
    '"ignored"',
    'undefined',
    '[]',
    '["id"]',
    '[0,"id"]',
  ])('keeps a local input serialized with a non-calling replacer: %s', async (replacer) => {
    const app = await fixture(replacer);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { replacer: '(key:string,value:unknown)=>value' },
    { declaration: 'const replace=(key:string,value:unknown)=>value;', replacer: 'replace' },
  ])('keeps a source callback whose writes remain visible: $replacer', async (row) => {
    const app = await fixture(row.replacer, row.declaration);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { replacer: '(key:string,value:unknown)=>{initial.id="changed";return value;}' },
    {
      declaration: 'const replace=(key:string,value:unknown)=>value;const alias=replace;',
      replacer: 'alias',
    },
    {
      declaration:
        'const keys=["id"];Object.defineProperty(keys,"0",{get(){initial.id="changed";return "id";}});',
      replacer: 'keys',
    },
    {
      declaration:
        'const key=new String("id");key.toString=()=>{initial.id="changed";return "id";};',
      replacer: '[key]',
    },
  ])('preserves writes and unproven callback or property-list effects: $replacer', async (row) => {
    const app = await fixture(row.replacer, row.declaration);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('could be a field'),
    ]);
  });
});

/** A discarded server stringify call must leave a page-valued initial constant local. */
async function fixture(replacer: string, declaration = ''): Promise<Application> {
  return application({
    'components/stringify-replacer.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function StringifyReplacer({projectId,first}:{projectId:string;first:string}){',
      'const initial={id:first};',
      declaration,
      `JSON.stringify(initial,${replacer});`,
      'const [selected,setSelected]=useReactiveState<{id:string}>(initial);',
      'return<section><button onClick={()=>setSelected({id:first})}>reset</button><TodoCommands projectId={projectId} id={selected.id}/></section>;}',
    ].join('\n'),
  });
}
