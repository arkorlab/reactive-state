import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Iteration syntax requests an iterator even when its resulting value is discarded. */
describe('written iteration syntax failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '[...(null as never)]' },
    { expression: '[...(undefined as never)]' },
    { expression: '[...(false as never)]' },
    { expression: '[...(1 as never)]' },
    { expression: '[...(1n as never)]' },
    { expression: '[...(Symbol() as never)]' },
    { expression: '[...({} as never)]' },
    { expression: '[...({length:0} as never)]' },
    { expression: '((_value: unknown)=>0)(...(null as never))' },
    { expression: 'new (class {})(...(null as never))' },
    { expression: '(()=>{for(const entry of (null as never)){void entry;}return 0;})()' },
    { expression: '(()=>{for(const entry of ({} as never)){void entry;}return 0;})()' },
    { expression: 'new Set({*[Symbol.iterator](){yield* (null as never);}})' },
    { expression: '[...(missing as never)]', declaration: 'const missing=null;' },
  ])('refuses a written non-iterable source: $expression', async (row) => {
    const app = await fixture(row.expression, 'declaration' in row ? row.declaration : '');
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '[..."abc"]',
    '[...[]]',
    '[...new Set([0])]',
    '[...new Uint8Array([0])]',
    '[...{*[Symbol.iterator](){yield 0;}}]',
    '({...null})',
    '[...first]',
    '(()=>{try{for(const entry of (null as never)){void entry;}}catch{}return 0;})()',
    '(function*(){yield* (null as never);})()',
    '(()=>{if(false){for(const entry of (null as never)){void entry;}}return 0;})()',
    '(null as unknown as ((...args:unknown[])=>void)|null)?.(...(null as never))',
  ])(
    'keeps iterables, object copies, caught failures and deferred work: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

/** The authority checks the evaluated first branch because it reads a page prop. */
async function fixture(expression: string, declaration = ''): Promise<Application> {
  return application({
    'components/iteration-syntax.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function IterationSyntax({projectId, first}: {projectId: string; first: string}) {',
      declaration,
      `  const [value, setValue] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
      '  return <section><button onClick={() => setValue(first)}>reset</button><TodoCommands projectId={projectId} id={value} /></section>;',
      '}',
    ].join('\n'),
  });
}
