import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A proven application-owned method keeps its source result's JSON boundary. */
describe('written own callable results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      declaration: 'const KEY="set";const store={[KEY](){return new Date(0);}};',
      expression: 'store.set()',
    },
    {
      declaration: 'const KEY="then";const store={[KEY]:async()=>first};',
      expression: 'store.then()',
    },
    {
      declaration: 'const KEY="values";const store={*[KEY](){yield first;}};',
      expression: 'store.values()',
    },
    {
      declaration: 'const KEY="set";const store={[KEY](input:unknown){return input;}};',
      expression: 'store.set(new Date(0))',
    },
    {
      declaration: 'const store={[first](){return first;}};',
      expression: 'store.set()',
    },
    {
      declaration:
        'const KEY="set";const store={[KEY](){return first;}};store.set=()=>new Date(0) as never;',
      expression: 'store.set()',
    },
  ])('refuses a non-JSON or unproven result: $expression with $declaration', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    {
      declaration: 'const KEY="set";const store={[KEY](){return first;}};',
      expression: 'store.set()',
    },
    {
      declaration: 'const store={set(){return first;}};',
      expression: 'store.set()',
    },
    {
      declaration: 'const KEY="then";const store={[KEY]:()=>first};',
      expression: 'store.then()',
    },
    {
      declaration:
        'const KEY="set";const store={[KEY](){return new Date(0);},set(){return first;}};',
      expression: 'store.set()',
    },
    {
      declaration: 'const KEY="set";const store={[KEY](input:string){return input;}};',
      expression: 'store.set(first)',
    },
    {
      declaration: 'const KEY="set";const echo=(input:string)=>input;const store={[KEY]:echo};',
      expression: 'store.set(first)',
    },
  ])('keeps a source JSON result: $expression with $declaration', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

interface OwnCall {
  readonly declaration: string;
  readonly expression: string;
}

/** The state is evaluated by the authority and used as a dynamic child's input. */
async function fixture(row: OwnCall): Promise<Application> {
  return application({
    'components/own-call-results.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function OwnCallResults({projectId,first}:{projectId:string;first:string}){',
      row.declaration,
      `const [selected,setSelected]=useReactiveState<string>(${row.expression} as unknown as string);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
