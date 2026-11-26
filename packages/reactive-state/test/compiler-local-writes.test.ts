import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Production checks of values copied within a constant, and cycles or non-JSON writes beside them. */

describe('local writes read through their own constants', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "const result = { a: first, b: '' }; result.b = result.a; return result;",
    "const result = [first, '']; result[1] = result[0]; return result;",
    'const result = { a: { text: first }, b: null }; result.b = result.a; return result;',
    "const result = { a: first, b: '' }; const alias = result; result.b = alias.a; return result;",
    "const result = { a: first, b: '', c: '' }; result.b = result.a; result.c = result.b; return result;",
  ])('accepts an ordinary JSON member copied within the same constant: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'const shared = { text: first }; const result = { a: shared, b: null }; result.b = result.a; return result;',
    'const shared = { text: first }; const result = [shared, null]; result[1] = result[0]; return result;',
  ])(
    'keeps a shared JSON reference copied between root members without a cycle: %s',
    async (body) => {
      const app = await fixture(body);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );

  it.each([
    'const shared = { text: first }; const result = { a: shared, b: shared }; result.b.self = result.a; return result;',
    'const shared = { text: first }; const result = { a: shared, b: shared }; result.a.self = result.b; return result;',
    'const child = { text: first }; const parent = { child }; const result = { a: parent, b: child }; result.b.parent = result.a; return result;',
    'const shared = { text: first }; const result = [shared, shared]; result[1].self = result[0]; return result;',
  ])(
    'refuses a cycle through shared objects selected by different sibling paths: %s',
    async (body) => {
      const app = await fixture(body);
      apps.push(app);

      const reasons = compile(app).refusals.map((refusal) => refusal.reason);

      expect(reasons).toStrictEqual([expect.stringContaining('which no JSON holds')]);
    },
  );

  it.each([
    'const result = { a: first }; result.self = result; return result;',
    'const result = { a: { text: first } }; result.a.self = result.a; return result;',
    'const result = { a: first }; const other = { b: first }; result.other = other; other.result = result; return result;',
    "const result = { a: first, b: '' }; result.b = result.a; result.bad = () => first; return result;",
    "const result = { a: first, b: '' }; const alias = result; result.b = result.a; alias.bad = Symbol('bad'); return result;",
    'const result = [first]; result[0] = result[0]; result.length = 2; return result;',
    'const result = { a: { text: first }, b: { text: first } }; result.a.next = result.b; result.b.next = result.a; return result;',
    'const result = { a: { text: first } }; const alias = result.a; alias.self = result.a; return result;',
    'const result = { a: first }; const alias = result; result.self = alias; return result;',
    'const result = { a: { text: first, values: [] } }; result.a.values.push(result.a); return result;',
  ])('still refuses a cycle or non-JSON mutation: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    const reasons = compile(app).refusals.map((refusal) => refusal.reason);

    expect(reasons).toStrictEqual([expect.stringContaining('which no JSON holds')]);
  });
});

/** A state initialized by the shared function, read by a dynamic site's element. */
async function fixture(body: string): Promise<Application> {
  const type = body.startsWith('const result = [')
    ? 'string[]'
    : '{ a: string | { text: string } }';
  return application({
    'domain/local-copies.ts': `export function initial(first: string) { ${body} }\n`,
    'components/local-copies.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { initial } from '@/domain/local-copies';",
      'export default function LocalCopies({ projectId, first }: { projectId: string; first: string }) {',
      `  const [value, setValue] = useReactiveState<${type}>(initial(first));`,
      '  return <section><button onClick={() => setValue(value)}>keep</button><TodoCommands projectId={projectId} id={JSON.stringify(value)} /></section>;',
      '}',
    ].join('\n'),
  });
}
