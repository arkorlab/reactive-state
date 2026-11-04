import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const KEY_REFUSAL = expect.stringContaining("The key of a list's item");

/** List keys keep intermediate assertions and the declaring hook's type parameter scope. */
describe('list key reading context', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { type: '{ a?: { b: string } }', key: 'panel.a!.b', taken: true },
    { type: '{ a?: { b: string } }', key: '(panel.a!).b', taken: true },
    { type: '{ a?: { b: string } }', key: "panel['a']!['b']", taken: true },
    { type: '{ a?: { b?: { c: string } } }', key: 'panel.a!.b!.c', taken: true },
    { type: '{ a?: { b?: string } }', key: 'panel.a!.b!', taken: true },
    { type: '{ a?: { b?: string } }', key: "panel.a!.b ?? 'fallback'", taken: true },
    { type: '{ a?: { b: string | undefined } }', key: "panel.a!.b ?? 'fallback'", taken: true },
    { type: '{ a?: { b: string } }', key: 'panel.a.b', taken: false },
    { type: '{ a?: { b?: string } }', key: 'panel.a!.b', taken: false },
    { type: '{ a?: { b: string | null } }', key: 'panel.a!.b', taken: false },
    { type: '{ a?: { b: boolean } }', key: 'panel.a!.b', taken: false },
    { type: '{ a?: { b: { c: string } } }', key: 'panel.a!.b', taken: false },
    {
      type: '{ id: string; value?: string }',
      key: '(panel.value as unknown) ?? panel.id',
      taken: true,
    },
  ])('reads an intermediate assertion in $key of $type', async ({ type, key, taken }) => {
    const app = await fixture(type, key);
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals.map((refusal) => refusal.reason)).toStrictEqual(
      taken ? [] : [KEY_REFUSAL],
    );
  });

  it.each([
    { constraint: 'boolean', array: 'readonly T[]', binding: 'state', taken: false },
    { constraint: 'boolean', array: 'ReadonlyArray<T>', binding: 'state', taken: false },
    { constraint: 'boolean', array: 'readonly T[]', binding: 'constant', taken: false },
    { constraint: 'boolean', array: 'ReadonlyArray<T>', binding: 'constant', taken: false },
    { constraint: 'string', array: 'readonly T[]', binding: 'state', taken: true },
    { constraint: 'number', array: 'ReadonlyArray<T>', binding: 'state', taken: true },
    { constraint: 'string', array: 'readonly T[]', binding: 'constant', taken: true },
    { constraint: 'string', array: 'ReadonlyArray<T>', binding: 'constant', taken: true },
  ])('keeps $constraint hook types through $binding of $array', async (row) => {
    const { constraint, array, binding, taken } = row;
    const body = hookBody(array, binding);
    const app = await application({
      'hooks/use-key-values.ts': `import { useReactiveState } from 'framework/react'; export function useKeyValues<T extends ${constraint}>(initial: ${array}) { ${body} }`,
      'components/key-values.reactive.tsx': [
        "import { useKeyValues } from '@/hooks/use-key-values';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        `export default function KeyValues({projectId, first}: {projectId: string; first: readonly ${constraint}[]}) {`,
        `  const { values${binding === 'constant' ? ', selected' : ''} } = useKeyValues(first);`,
        [
          '  return <section>{',
          binding === 'constant' ? 'selected' : 'values',
          '.map((panel) => <TodoCommands key={panel} projectId={projectId} id="t1" />)}</section>;',
        ].join(''),
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals.map((refusal) => refusal.reason)).toStrictEqual(
      taken ? [] : [KEY_REFUSAL],
    );
  });
});

/** A hook fixture keeps its state returned alongside any derived list. */
function hookBody(array: string, binding: string): string {
  const state = `const [values, setValues] = useReactiveState<${array}>(initial);`;
  return binding === 'constant'
    ? `${state} const selected = values.slice(); return { values, selected, clear: () => setValues([]) };`
    : `${state} return { values, clear: () => setValues([]) };`;
}

/** A typed local list with a state-backed dynamic subtree at each key. */
async function fixture(type: string, key: string): Promise<Application> {
  return application({
    'components/key-reading.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      `export default function KeyReading({projectId, first}: {projectId: string; first: readonly ${type}[]}) {`,
      '  const [panels, setPanels] = useReactiveState(first);',
      [
        '  return <section><button onClick={() => setPanels([])}>clear</button>{panels.map((panel) => <TodoCommands key={',
        key,
        '} projectId={projectId} id="t1" />)}</section>;',
      ].join(''),
      '}',
    ].join('\n'),
  });
}
