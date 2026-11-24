import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A computed own method keeps its source return rather than a native method's named result. */
describe('computed own method results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      declaration: 'const KEY = "set"; const store = {[KEY]() { return first; }};',
      expression: 'store.set()',
    },
    {
      declaration:
        'const KEY = "values"; const ALIAS = KEY; const store = {[ALIAS]() { return first; }}; const copy = store;',
      expression: 'copy.values()',
    },
    {
      declaration: 'const KEY = "then"; const store = {[KEY]: () => first};',
      expression: 'store.then()',
    },
    { declaration: 'const store = {set() { return first; }};', expression: 'store.set()' },
    {
      declaration: 'const set = "set"; const store = {[set]() { return first; }};',
      expression: 'store.set()',
    },
  ])('keeps the application method of $expression with $declaration', async (row) => {
    const app = await fixture(row.declaration, row.expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { declaration: 'const store = {[first]() { return first; }};', expression: 'store.set()' },
    {
      declaration: 'const store = new Map<string, string>();',
      expression: 'store.set("entry", first)',
    },
    {
      declaration: 'const set = "other"; const store = {[set]() { return first; }};',
      expression: 'store.set()',
    },
  ])('refuses an unproven or non-JSON result of $expression with $declaration', async (row) => {
    const app = await fixture(row.declaration, row.expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** A source own method answers a page input that the authority must send as its initial state. */
async function fixture(declaration: string, expression: string): Promise<Application> {
  return application({
    'components/computed-method.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function ComputedMethod({projectId, first}: {projectId: string; first: string}) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<string>(${expression});`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;',
      '}',
    ].join('\n'),
  });
}
