import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A conjunction contributes only its left operand's falsy values, which a disjunction replaces. */
describe('list key conjunction fallbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { gate: 'boolean', key: '(panel.gate && panel.id) || panel.todoId' },
    { gate: 'boolean | undefined', key: '(panel.gate && panel.id) || panel.todoId' },
    { gate: '{ active: boolean }', key: '(panel.gate && panel.id) || panel.todoId' },
    { gate: 'readonly string[]', key: '(panel.gate && panel.id) || panel.todoId' },
    { gate: '{ active: boolean }', key: 'panel.gate && panel.id' },
    { gate: 'readonly string[]', key: 'panel.gate && panel.id' },
    { gate: '{ active: boolean } | undefined', key: '(panel.gate && panel.id) ?? panel.todoId' },
    { gate: 'boolean', key: '(panel.gate && (panel.ready && panel.id)) || panel.todoId' },
    { gate: 'true', key: 'panel.gate && panel.id' },
    { gate: 'boolean', key: '((panel.gate && panel.id) ?? panel.todoId) || panel.todoId' },
  ])('keeps $key with a $gate condition', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { gate: 'boolean', key: 'panel.gate && panel.id' },
    { gate: 'boolean', key: '(panel.gate && panel.id) ?? panel.todoId' },
    { gate: '{ active: boolean }', key: '(panel.gate && panel.bad) || panel.todoId' },
    { gate: 'boolean', key: '(panel.gate && panel.ready) || panel.todoId' },
    { gate: '{ active: boolean } | undefined', key: 'panel.gate && panel.id' },
    { gate: 'boolean', key: 'panel.gate || panel.id' },
    { gate: '{ active: boolean }', key: 'panel.gate || panel.id' },
    { gate: 'readonly string[]', key: 'panel.gate ?? panel.id' },
    { gate: 'string | boolean', key: 'panel.gate && panel.id' },
  ])('refuses a possible non-key result in $key with $gate', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining("The key of a list's item"),
    ]);
  });
});

/** The list and its item types come from one local JSON array state. */
async function fixture(row: { readonly gate: string; readonly key: string }): Promise<Application> {
  return application({
    'components/key-fallbacks.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      `export default function KeyFallbacks({projectId, first}: {projectId: string; first: readonly {gate: ${row.gate}; ready: boolean; id: string; todoId: string; bad: {value: string}}[]}) {`,
      'const [panels,setPanels]=useReactiveState(first);',
      [
        'return<section><button onClick={()=>setPanels([])}>clear</button>{panels.map(panel=><TodoCommands key={',
        row.key,
        '} projectId={projectId} id="t1"/>)}</section>;}',
      ].join(''),
    ].join('\n'),
  });
}
