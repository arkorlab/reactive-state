import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole inferred tuple rests preserve selected error and application data types. */
const PREFIX = 'type Tail<T> = T extends [unknown, ...infer R] ? R : never; ';
const CASES = [
  {
    name: 'finite inferred rest error',
    declaration: `${PREFIX}type Failure = Tail<[string, Error]>[0];`,
    error: true,
    argument: 'new Error("fixed")',
  },
  {
    name: 'finite inferred rest data excludes prefix error',
    declaration: `${PREFIX}type Failure = Tail<[Error, { stack: string }]>[0];`,
    error: false,
    argument: '{ stack: value }',
  },
  {
    name: 'native array rest inferred error',
    declaration: `${PREFIX}type Failure = Tail<[string, ...Error[]]>[number];`,
    error: true,
    argument: 'new Error("fixed")',
  },
  {
    name: 'native array rest data excludes prefix error',
    declaration: `${PREFIX}type Failure = Tail<[Error, ...{ stack: string }[]]>[number];`,
    error: false,
    argument: '{ stack: value }',
  },
] as const;

describe('tuple-rest inferred selected reader types', () => {
  it.each(CASES)('retains the intended member: $name', (row) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'tuple-rest-inference.ts',
      `${row.declaration} function frames(error: Failure) { return error.stack; }`,
    );
    const observations: string[] = [];
    const pending: Node[] = [parsed.sourceFile];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const framed = framedRead(node);
      if (framed !== undefined) observations.push(framed);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
    const actual = observations.length > 0;

    expect(actual).toBe(row.error);
  });
});

describe('tuple-rest inferred selected actual shared helpers', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('keeps the actual admission boundary: $name', async (row) => {
    const app = await fixture(row.declaration, row.argument);
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((refusal) => refusal.reason);
    const refused = [expect.stringContaining('a shared module that answers otherwise')];

    expect(reasons).toStrictEqual(row.error ? refused : []);
  });
});

/** A helper whose output reaches a dynamic child prop in the existing unchanged fixture. */
async function fixture(declaration: string, argument: string): Promise<Application> {
  return application({
    'domain/error-rest.ts': [
      declaration,
      'function frames(error: Failure): string { return error.stack ?? ""; }',
      `export function label(value: string) { return value + frames(${argument}); }`,
    ].join('\n'),
    'components/error-rest.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/error-rest';",
      'export default function ErrorRest({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
