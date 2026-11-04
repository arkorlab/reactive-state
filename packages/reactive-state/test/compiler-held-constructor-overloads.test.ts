import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const BASE = 'class Base { n = 0; bump() { return ++this.n; } }';
const PURE = 'super(); return { n: 0, bump() { return 0; } } as Child;';
const WRITES = 'super(); return { n: 0, bump() { return ++this.n; } } as Child;';

/** Erased signatures do not replace a retained instance's implementation or returned methods. */
describe('retained constructor overload implementations', () => {
  const { apps, compile } = compilerApplications();

  async function refusalsOf(
    declaration: string,
    made = 'new Child()',
  ): Promise<readonly unknown[]> {
    const app = await application({
      'domain/constructor-overloads.ts': [
        BASE,
        declaration,
        `const counter = ${made};`,
        'export function label(value: string) { return value + counter.bump(); }',
      ].join('\n'),
      'components/constructor-overloads.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { label } from '@/domain/constructor-overloads';",
        'export default function ConstructorOverloads({projectId, first}: {projectId: string; first: string}) {',
        '  const [selected, setSelected] = useReactiveState(first);',
        '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    return compile(app).refusals;
  }

  it.each([
    { declaration: `class Child extends Base { constructor(); constructor() { ${PURE} } }` },
    {
      declaration: `class Child extends Base { constructor(value: string); constructor(value: number); constructor(value: string | number) { ${PURE} } }`,
      made: "new Child('x')",
    },
    {
      declaration: `const Child = class extends Base { constructor(); constructor() { ${PURE} } }; const Factory = Child;`,
      made: 'new Factory()',
    },
  ])('accepts the pure implementation beneath signatures: $declaration', async (test) => {
    await expect(refusalsOf(test.declaration, test.made)).resolves.toStrictEqual([]);
  });

  it('keeps the equivalent pure implementation without an overload accepted', async () => {
    await expect(
      refusalsOf(`class Child extends Base { constructor() { ${PURE} } }`),
    ).resolves.toStrictEqual([]);
  });

  it.each([
    `class Child extends Base { constructor(); constructor() { ${WRITES} } }`,
    'class Child extends Base { constructor(); constructor() { super(); } }',
    `class Child extends Base { constructor(value: boolean); constructor(value: boolean) { super(); if (value) return this; return { n: 0, bump() { return 0; } } as Child; } }`,
  ])('retains inherited, returned and conditional writers: %s', async (declaration) => {
    const made = declaration.includes('value: boolean') ? 'new Child(true)' : 'new Child()';

    await expect(refusalsOf(declaration, made)).resolves.not.toStrictEqual([]);
  });
});
