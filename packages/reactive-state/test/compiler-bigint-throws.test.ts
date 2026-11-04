import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written bigint arithmetic and typed-array element conversions fail before a discarded result. */
describe('written bigint initializer exceptions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '1n / 0n' },
    { expression: '1n % 0n' },
    { expression: '1n ** -1n' },
    { expression: '(1n as never) >>> (1n as never)' },
    { expression: '(1n as never) + 1' },
    { expression: '1 + (1n as never)' },
    { expression: '(1n as never) - 1' },
    { expression: '(1n as never) * 1' },
    { expression: '(1n as never) / 1' },
    { expression: '(1n as never) % 1' },
    { expression: '(1n as never) ** 1' },
    { expression: '(1n as never) << 1' },
    { expression: '(1n as never) >> 1' },
    { expression: '(1n as never) & 1' },
    { expression: '(1n as never) | 1' },
    { expression: '(1n as never) ^ 1' },
    { expression: "(1n as never) - ('1' as never)" },
    { expression: '(1n as never) + (true as never)' },
    { expression: '(1n as never) + (null as never)' },
    { expression: '(1n as never) + (undefined as never)' },
    { expression: '(BigInt(1) as never) + 1' },
    { expression: '1n / BigInt(0)' },
    { expression: '1n ** BigInt(-1)' },
    {
      declaration: 'const integer = globalThis.BigInt; const value = integer(1);',
      expression: '(value as never) * 1',
    },
    { expression: 'new Int32Array([BigInt(1) as never])' },
    { expression: 'new Int32Array([BigInt.asIntN(8, 1n) as never])' },
    { expression: 'new Int32Array([BigInt.asUintN(8, 1n) as never])' },
    { expression: 'Int32Array.of(BigInt(1) as never)' },
    { expression: 'Int32Array.from([BigInt.asIntN(8, 1n) as never])' },
    { expression: 'new Int32Array(1).fill(BigInt(1) as never)' },
    { expression: 'new Int32Array(1).with(0, BigInt.asUintN(8, 1n) as never)' },
    { expression: 'new Int32Array(1).set([BigInt(1) as never])' },
    { expression: 'Atomics.store(new Int32Array(1), 0, BigInt(1) as never)' },
    {
      declaration: 'const trim = globalThis.BigInt.asUintN; const value = trim(8, 1n);',
      expression: 'Int32Array.of(value as never)',
    },
  ])('refuses necessarily throwing bigint work: $expression', async ({ expression, ...rest }) => {
    const declaration = 'declaration' in rest ? rest.declaration : '';
    const app = await fixture(expression, declaration);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    '1n + 2n',
    '1n / 1n',
    '1n % -1n',
    '2n ** 0n',
    '1n << -1n',
    '1n >> -1n',
    '1n & 2n',
    '1n | 2n',
    '1n ^ 2n',
    "1n + 'x'",
    "'x' + BigInt(1)",
    '1n < 2',
    '1n >= 2',
    '(1n as never) == 1',
    '(1n as never) === 1',
    '(first as never) + 1n',
    '(first as never) - 1n',
    'new BigInt64Array([BigInt(1)])',
    'BigUint64Array.of(BigInt.asUintN(8, 1n))',
    'new Int32Array([Number(BigInt(1))])',
    'Int32Array.of(Number(BigInt.asIntN(8, 1n)))',
    'new Int32Array(1).with(0, Number(BigInt(1)))',
    'new Int32Array([first as never])',
  ])('keeps valid arithmetic and conversions or unknown inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A prop read makes the authority evaluate the initializer rather than retain it for the browser. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/bigint-throws.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function BigIntThrows({ projectId, first }: { projectId: string; first: string }) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
