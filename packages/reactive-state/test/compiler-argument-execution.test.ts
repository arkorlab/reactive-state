import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Arguments finish executing before a constructor selects a member of an earlier argument. */
describe('metadata argument execution', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(() => { argument.value = items; })()',
    '(function() { argument.value = items; })()',
    'change()',
    'actions.change()',
    'defaults()',
    'defaults(undefined)',
  ])('refuses a constructor argument executing a write: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    '(() => 0)()',
    'pure()',
    'deferred()',
    '() => { argument.value = items; }',
    'Number("0")',
    'local()',
    'defaults([])',
  ])('keeps pure argument execution and suspended code: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The second argument can replace the first argument's selected constructor result. */
async function fixture(expression: string): Promise<Application> {
  const body = [
    'class Identity { constructor({value}: {value: string[]}, _ignored?: unknown) { return value; } }',
    'const argument = {value: [] as string[]};',
    'function change() { argument.value = items; }',
    'const actions = {change() { argument.value = items; }};',
    'function* defaults(value = (argument.value = items)) { yield value; }',
    'function* deferred() { argument.value = items; }',
    'function pure() { return 0; }',
    'function local() { const values: number[] = []; values.push(1); return values.length; }',
    `return String(Object.isFrozen(new Identity(argument, ${expression})));`,
  ].join('\n');
  return application({
    'domain/argument-execution.ts': `export function label(items: string[]): string { ${body} }`,
    'components/argument-execution.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/argument-execution';",
      'export default function ArgumentExecution({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
