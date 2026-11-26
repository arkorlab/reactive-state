import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Computed names and member accesses coerce their keys before answering a discarded value. */
describe('written property key coercions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '({[Object.create(null) as never]: 1})' },
    { expression: '({[Object.create(null) as never]() {}})' },
    { expression: '({get [Object.create(null) as never]() { return 1; }})' },
    { expression: '({set [Object.create(null) as never](_value: unknown) {}})' },
    { expression: '({})[Object.create(null) as never]' },
    { expression: 'delete ({} as Record<string, unknown>)[Object.create(null) as never]' },
    { expression: '(({} as Record<string, unknown>)[Object.create(null) as never] = 1)' },
    { expression: '(Object.create(null) as never) in {}' },
    { expression: '({[({__proto__: null}) as never]: 1})' },
    {
      declaration:
        'const make = globalThis.Object.create; const key = make(null); const alias = key;',
      expression: '({[alias as never]: 1})',
    },
  ])('refuses a key with no primitive conversion: $expression', async ({ expression, ...rest }) => {
    const app = await fixture(expression, 'declaration' in rest ? rest.declaration : '');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    '({[{} as never]: 1})',
    '({[Symbol("key")]: 1})',
    '({[({__proto__: null, toString() { return "key"; }}) as never]: 1})',
    '({[Object.create(null, {toString: {value: () => "key"}}) as never]: 1})',
    '(null as null | Record<string, unknown>)?.[Object.create(null) as never]',
    '({[first]: 1})',
  ])(
    'keeps valid or unknown key conversions and optional short-circuiting: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

/** A discarded key operation inside a state whose initial value the authority evaluates. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/property-keys.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function PropertyKeys({projectId, first}: {projectId: string; first: string}) {',
      `  ${declaration}`,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
