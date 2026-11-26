import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native copying and iteration invoke source-written accessors and methods synchronously. */
describe('consumed initializer exceptions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: "({ ...{ get value() { throw new Error('bad'); } } })" },
    { expression: "({ ...{ get [Symbol.iterator]() { throw new Error('bad'); } } })" },
    { expression: "({ ...{ get [first]() { throw new Error('bad'); } } })" },
    { expression: "({ ...{ plain: first, get value() { throw new Error('bad'); } } })" },
    { expression: "({ ...{ get value() { return decodeURIComponent('%'); } } })" },
    {
      declaration: "const source = { get value() { throw new Error('bad'); } };",
      expression: '({ ...source })',
    },
    ...['Set', 'Map', 'WeakSet', 'WeakMap'].map((kind) => {
      return {
        expression: `new ${kind}({ [Symbol.iterator]() { throw new Error('bad'); } } as never)`,
      };
    }),
    ...['Object.fromEntries', 'Array.from', 'Iterator.from'].map((callee) => {
      return {
        expression: `${callee}({ [Symbol.iterator]() { throw new Error('bad'); } } as never)`,
      };
    }),
    { expression: "new Set({ get [Symbol.iterator]() { throw new Error('bad'); } } as never)" },
    {
      expression: "new Set({ [Symbol.iterator]: () => decodeURIComponent('%') } as never)",
    },
    {
      declaration:
        "const iterate = () => { throw new Error('bad'); }; const source = { [Symbol.iterator]: iterate }; const Collection = Set;",
      expression: 'new Collection(source as never)',
    },
  ])('refuses synchronously consumed source code: $expression', async ({ expression, ...rest }) => {
    const declaration = 'declaration' in rest ? rest.declaration : '';
    const app = await fixture(expression, declaration);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "({ ...{ get value() { throw new Error('old'); }, value: first } })",
    '({ ...{ value: first } })',
    "({ ...{ get value() { return () => { throw new Error('later'); }; } } })",
    "({ ...{ nested: { get value() { throw new Error('unread'); } } } })",
    "(() => { const source = { get first() { Object.defineProperty(source, 'last', { value: 1 }); return 0; }, get last() { throw new Error('replaced'); } }; return { ...source }; })()",
    "(() => { try { return { ...{ get value() { throw new Error('caught'); } } }; } catch { return first; } })()",
    'new Set({ *[Symbol.iterator]() { yield first; } })',
    'new Map({ [Symbol.iterator]() { return [][Symbol.iterator](); } })',
    "new Set({ [Symbol.iterator]() { return [][Symbol.iterator](); }, get value() { throw new Error('unread'); } })",
    "new Set({ [Symbol.iterator]() { throw new Error('old'); }, [Symbol.iterator]() { return [][Symbol.iterator](); } })",
    "Iterator.from({ *[Symbol.iterator]() { throw new Error('deferred'); } })",
    "Iterator.from({ [Symbol.iterator]() { throw new Error('overwritten'); }, set [Symbol.iterator](_value) {}, next() { return { done: true }; } })",
    "new Set({ [Symbol.iterator]() { throw new Error('overwritten'); }, ...{ *[Symbol.iterator]() {} } })",
    "(() => { const source = { [Symbol.iterator]() { throw new Error('replaced'); } }; return new Set(source as never, Object.defineProperty(source, Symbol.iterator, { value: function* () {} }) as never); })()",
    "(() => { const source = { get value() { throw new Error('replaced'); } }; const earlier = { get change() { Object.defineProperty(source, 'value', { value: 1 }); return 0; } }; return { ...earlier, ...source }; })()",
    "(() => { try { return new Set({ [Symbol.iterator]() { throw new Error('caught'); } }); } catch { return first; } })()",
  ])('keeps unconsumed, overwritten and handled bodies: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A discarded operation still runs when the authority evaluates a prop-dependent initializer. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/consumed-throws.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function ConsumedThrows({ projectId, first }: {projectId: string; first: string}) {',
      declaration,
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
