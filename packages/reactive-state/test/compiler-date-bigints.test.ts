import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Date's numeric primitive is a number even when its stored time is invalid. */
describe('written dates mixed with bigint operands', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '(new Date(0) as never) ** 0n' },
    { expression: "(new Date('bad') as never) ** 0n" },
    { expression: '(new Date(0) as never) - 0n' },
    { expression: '0n - (new Date(0) as never)' },
    { expression: "(new Date('bad') as never) * 1n" },
    { expression: "1n / (new Date('bad') as never)" },
    { expression: '(new Date(0) as never) % 1n' },
    { expression: '(new Date(0) as never) << 1n' },
    { expression: '(new Date(0) as never) | 1n' },
    {
      declaration: 'const date = new Date(0); const alias = date;',
      expression: '(alias as never) - 1n',
    },
    {
      declaration: 'const integer = globalThis.BigInt;',
      expression: '(new Date(0) as never) * integer(1)',
    },
    { expression: '(new Date(first) as never) - 1n' },
    { expression: '(new Date(first) as never) ** 0n' },
    {
      expression:
        '(() => { const Clock = globalThis.Date; return (new Clock(0) as never) * 1n; })()',
    },
    {
      declaration: 'const Clock = Date; const date = new Clock(first);',
      expression: '1n / (date as never)',
    },
    { expression: '(1n as never) - 1' },
    { expression: '1n / 0n' },
    { expression: '1n ** -1n' },
  ])('refuses necessarily mixed numeric work: $expression', async ({ expression, ...rest }) => {
    const app = await fixture(expression, 'declaration' in rest ? rest.declaration : '');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    { expression: '(new Date(0) as never) + 1n' },
    { expression: "1n + (new Date('bad') as never)" },
    { expression: '(new Date(0) as never) < 1n' },
    { expression: "(new Date('bad') as never) == 1n" },
    { expression: '1n + 2n' },
    { expression: '(first as never) - 1n' },
    { expression: '(new Date(first) as never) + 1n' },
    {
      expression:
        '(() => { class Date { valueOf() { return 1n; } } return (new Date() as never) - 1n; })()',
    },
    {
      expression:
        '(() => { class Date { valueOf() { return 1n; } } const Clock = Date; return (new Clock() as never) * 1n; })()',
    },
    {
      expression:
        '(() => { let Clock = globalThis.Date; Clock = class { valueOf() { return 1n; } } as never; return (new Clock(0) as never) * 1n; })()',
    },
    {
      expression:
        '(() => { const Clock = globalThis.Date; const saved = Object.getOwnPropertyDescriptor(Clock.prototype, Symbol.toPrimitive); try { Object.defineProperty(Clock.prototype, Symbol.toPrimitive, { value: () => 1n }); return (new Clock(0) as never) * 1n; } finally { Object.defineProperty(Clock.prototype, Symbol.toPrimitive, saved!); } })()',
    },
    {
      expression:
        '(() => { const date = new Date(0); date.valueOf = () => 1n as never; return (date as never) - 1n; })()',
    },
    {
      expression:
        '(() => { const date = new Date(0); Object.defineProperty(date, Symbol.toPrimitive, { value: () => 1n }); return (date as never) - 1n; })()',
    },
    {
      expression: '(Object.assign(new Date(0), { valueOf: () => 1n }) as never) - 1n',
    },
  ])('keeps default addition and unknown or application coercions: $expression', async (test) => {
    const app = await fixture(test.expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Discarding the operation's result isolates an exception from JSON's bigint value restriction. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/date-bigints.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function DateBigInts({projectId, first}: {projectId: string; first: string}) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
