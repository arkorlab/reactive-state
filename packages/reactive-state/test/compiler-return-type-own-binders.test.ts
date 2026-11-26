import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native ReturnType closes a written signature's own binders without selecting their defaults. */
const CASES = [
  {
    id: 'unconstrained-function',
    declaration:
      'type Failure = ReturnType<<T>() => T extends string ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'ignored-string-default',
    declaration:
      'type Failure = ReturnType<<T = string>() => T extends string ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'ignored-error-default',
    declaration:
      'type Failure = ReturnType<<T = Error>() => T extends Error ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'call-signature',
    declaration:
      'type Failure = ReturnType<{ <T>(): T extends string ? Error : { stack: string } }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'interface-signature',
    declaration:
      'interface Factory { <T>(): T extends string ? Error : { stack: string } } type Failure = ReturnType<Factory>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'callable-alias',
    declaration:
      'type Factory = <T>() => T extends string ? Error : { stack: string }; type Failure = ReturnType<Factory>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'outer-data-binding',
    declaration:
      'type Result<Outer> = ReturnType<<T>() => T extends string ? Error : Outer>; type Failure = Result<{ stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'own-shadowed-name',
    declaration:
      'type Result<T> = ReturnType<<T>() => T extends string ? Error : { stack: string }>; type Failure = Result<string>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'dependent-constraint',
    declaration:
      'type Failure = ReturnType<<T, U extends T>() => U extends string ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'last-generic-overload',
    declaration:
      'type Failure = ReturnType<{ (): Error; <T>(): T extends string ? Error : { stack: string } }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'explicit-unknown-constraint',
    declaration:
      'type Failure = ReturnType<<T extends unknown = string>() => T extends string ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'unknown-error-branch',
    declaration:
      'type Failure = ReturnType<<T>() => T extends string ? { stack: string } : Error>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'ignored-default-error-branch',
    declaration:
      'type Failure = ReturnType<<T = string>() => T extends string ? { stack: string } : Error>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'string-constraint',
    declaration:
      'type Failure = ReturnType<<T extends string>() => T extends string ? Error : { stack: string } >;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'error-constraint',
    declaration: 'type Failure = ReturnType<<T extends Error>() => T>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'error-constraint-default',
    declaration: 'type Failure = ReturnType<<T extends Error = TypeError>() => T>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'outer-error-binding',
    declaration: 'type Result<Outer> = ReturnType<<T>() => Outer>; type Failure = Result<Error>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'own-constraint-shadows-outer',
    declaration:
      'type Result<T> = ReturnType<<T extends Error>() => T>; type Failure = Result<{ stack: string }>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'fixed-error-result',
    declaration: 'type Failure = ReturnType<<T = { stack: string }>() => Error>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'last-generic-error-overload',
    declaration:
      'type Failure = ReturnType<{ (): { stack: string }; <T>(): T extends string ? { stack: string } : Error } >;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'keyof-unknown-error',
    declaration:
      'type Failure = ReturnType<<T>() => keyof T extends never ? Error : { stack: string }>;',
    error: true,
    argument: 'new Error("ours")',
  },
  {
    id: 'unknown-extends-binder',
    declaration:
      'type Failure = ReturnType<<T>() => unknown extends T ? { stack: string } : Error>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'forward-dependent-constraint',
    declaration:
      'type Failure = ReturnType<<T extends U, U>() => T extends string ? Error : { stack: string }>;',
    error: false,
    argument: '{ stack: "fixed" }',
  },
  {
    id: 'constraint-beats-never-default',
    declaration:
      'type Failure = ReturnType<<T extends string = never>() => T extends string ? Error : { stack: string }>;',
    error: true,
    argument: 'new Error("ours")',
  },
] as const;

describe('native ReturnType own generic binders', () => {
  it.each(CASES)('retains the native selected result: $id', ({ declaration, error }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'return-type-own-binders.ts',
      `${declaration} function frames(value: Failure) { return value.stack; }`,
    );

    expect(readsFrames(parsed.sourceFile)).toBe(error);
  });
});

describe('shared helpers with native ReturnType own binders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('classifies the actual shared helper: $id', async (row) => {
    const app = await fixture(row.declaration, row.argument);
    apps.push(app);
    const unsettled = compile(app).refusals.map((refusal) =>
      refusal.reason.includes('a shared module that answers otherwise'),
    );

    expect(unsettled).toStrictEqual(row.error ? [true] : []);
  });
});

/** A stack read identified in its original written lexical environment. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A dynamic child prop consumes the shared function's result. */
async function fixture(declaration: string, argument: string): Promise<Application> {
  return application({
    'domain/return-type-own-binders.ts': [
      declaration,
      'function frames(value: Failure): string { return value.stack ?? ""; }',
      `export function label(value: string) { return value + frames(${argument}); }`,
    ].join('\n'),
    'components/return-type-own-binders.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/return-type-own-binders';",
      'export default function ReturnTypeOwnBinders({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
