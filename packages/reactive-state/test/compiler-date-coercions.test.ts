import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Numeric Date coercion uses the stored time, while addition keeps Date's string default. */
describe('written date numeric coercions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: "+new Date('bad')" },
    { expression: "-new Date('bad')" },
    { expression: "(new Date('bad') as never) - 0" },
    { expression: "0 - (new Date('bad') as never)" },
    { expression: "(new Date('bad') as never) * 1" },
    { expression: "(new Date('bad') as never) / 1" },
    { expression: "(new Date('bad') as never) % 1" },
    { expression: "(new Date('bad') as never) ** 1" },
    { expression: "Number(new Date('bad'))" },
    { expression: '(new Date(9e15) as never) * 1' },
    { expression: "Number(new Date('bad')) ?? 0" },
    {
      declaration: "const date = new Date('bad'); const alias = date;",
      expression: 'Number(alias)',
    },
    { declaration: "const date = new Date('bad');", expression: '+date' },
    { declaration: 'const convert = Number;', expression: "convert(new Date('bad'))" },
    { expression: "new Date('bad').getTime()" },
    { expression: "Number('bad')" },
  ])('refuses a written non-finite numeric result: $expression', async (test) => {
    const app = await fixture(test.expression, 'declaration' in test ? test.declaration : '');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    '+new Date(0)',
    '-new Date(0)',
    '(new Date(0) as never) - 0',
    '(new Date(0) as never) * 1',
    'Number(new Date(0))',
    "(new Date('bad') as never) ** 0",
    { expression: "new Date('bad') + ''", kind: 'string' },
    { expression: "0 + (new Date('bad') as never)", kind: 'string' },
    "+new Date('bad') || 0",
    { expression: "Number(new Date('bad')) || first", kind: 'string' },
    "(() => { const date = new Date('bad'); date.setTime(0); return Number(date); })()",
    "(() => { const date = new Date('bad'); date.valueOf = () => 7; return Number(date); })()",
    "Number(Object.assign(new Date('bad'), { valueOf: () => 7 }))",
    "(() => { const Number = (_value: unknown) => 7; return Number(new Date('bad')); })()",
    '(() => { class Date { valueOf() { return 7; } } return Number(new Date()); })()',
  ])('keeps finite results, repaired values and application coercions: %s', async (test) => {
    const expression = typeof test === 'string' ? test : test.expression;
    const kind = typeof test === 'string' ? 'number' : test.kind;
    const app = await fixture(expression, '', kind);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A numeric or string first value consumed by an authority-rendered child. */
async function fixture(
  expression: string,
  declaration = '',
  kind = 'number',
): Promise<Application> {
  return application({
    'components/date-coercions.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function DateCoercions({projectId, first}: {projectId: string; first: string}) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<${kind}>(first === '' ? ${expression} as never : ${kind === 'number' ? '0' : 'first'});`,
      '  return <section><button onClick={() => setSelected(selected)}>keep</button><TodoCommands projectId={projectId} id={String(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
