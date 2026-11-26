import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** JSON.stringify unwraps primitive boxes and still throws on a boxed bigint. */
describe('json primitive wrapper results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: "JSON.stringify(Object('x'))" },
    { expression: 'JSON.stringify(Object(1))' },
    { expression: 'JSON.stringify(Object(true))' },
    { expression: "JSON.stringify(Object(Symbol('x')))" },
    { expression: 'JSON.stringify(Object(null))' },
    { expression: 'JSON.stringify(Object(undefined))' },
    { expression: 'JSON.stringify(Object(void 0))' },
    { expression: 'JSON.stringify(Object())' },
    { expression: "JSON.stringify(new String('x'))" },
    { expression: 'JSON.stringify(new Number(1))' },
    { expression: 'JSON.stringify(new Boolean(false))' },
    {
      declaration: "const text = 'x'; const boxed = Object(text);",
      expression: 'JSON.stringify(boxed)',
    },
    {
      declaration: "const Object = (_value: string) => ({id: 'own'});",
      expression: "JSON.stringify(Object('x'))",
    },
  ])('keeps deterministic primitive-wrapper serialization: $expression', async (test) => {
    const app = await fixture(test.expression, 'declaration' in test ? test.declaration : '');
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'JSON.stringify(Object(1n))',
    'JSON.stringify(Object(BigInt(1)))',
    'JSON.stringify(new Object(1n))',
    "JSON.stringify(Symbol('x'))",
    'JSON.stringify(undefined)',
  ])('refuses a bigint wrapper or an omitted top-level result: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });
});

/** The authority starts the string consumed by a dynamic child. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/json-wrapper.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function JsonWrapper({projectId, first}: {projectId: string; first: string}) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? ${expression} as never : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
