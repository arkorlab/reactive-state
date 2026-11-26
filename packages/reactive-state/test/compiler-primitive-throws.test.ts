import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Object/callback brands and unary plus retain their distinct primitive requirements. */
describe('primitive constructor and unary coercion exceptions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: "new Proxy(Symbol('x') as never, {})" },
    { expression: "new Proxy({}, Symbol('x') as never)" },
    { expression: "new Promise(Symbol('x') as never)" },
    { expression: "new FinalizationRegistry(Symbol('x') as never)" },
    { expression: 'new Proxy(Symbol.iterator as never, {})' },
    { expression: "new Promise(Symbol.for('registered') as never)" },
    {
      declaration: "const token = globalThis.Symbol('x'); const again = token;",
      expression: 'new globalThis.FinalizationRegistry(again as never)',
    },
    {
      declaration: 'const Wrapper = globalThis.Proxy;',
      expression: "new Wrapper(Symbol('x') as never, {})",
    },
    { expression: '+(1n as never)' },
    { expression: '+(-1n as never)' },
    { expression: '+(BigInt(1) as never)' },
    { expression: '+(globalThis.BigInt(1) as never)' },
    { expression: '+(BigInt.asIntN(8, 1n) as never)' },
    { expression: '+(BigInt.asUintN(8, 1n) as never)' },
    { declaration: 'const value = 1n; const again = value;', expression: '+(again as never)' },
    { declaration: 'const integer = globalThis.BigInt;', expression: '+(integer(1) as never)' },
  ])(
    'refuses a synchronously invalid primitive operand: $expression',
    async ({ expression, ...rest }) => {
      const declaration = 'declaration' in rest ? rest.declaration : '';
      const app = await fixture(expression, declaration);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
    },
  );

  it.each([
    '-1n',
    '~1n',
    'Number(1n)',
    'new Number(1n)',
    '+Number(1n)',
    "new WeakRef(Symbol('x'))",
    "new WeakMap([[Symbol('x'), first]])",
    'new WeakSet([Symbol.iterator])',
    "new Proxy(Object(Symbol('x')), {})",
    "new Proxy({}, Object(Symbol('x')))",
    'new Promise(() => {})',
    'new FinalizationRegistry(() => {})',
    "new FinalizationRegistry(() => {}).register(Symbol('target'), first)",
  ])('keeps valid conversions and weak symbol operands: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A discarded operand inside a state initializer that the authority must evaluate. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/primitive-throws.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function PrimitiveThrows({ projectId, first }: { projectId: string; first: string }) {',
      `  ${declaration}`,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
