import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error results selected from native utilities and named method signatures. */
const ERRORS = [
  'type Result<T> = T extends { value: infer R } ? R : never; type Failure = Result<{ get value(): Error; set value(next: unknown) }>;',
  'type Failure = ReturnType<() => Error>;',
  'type Result<T> = () => T; type Failure = ReturnType<Result<Error>>;',
  'type Result<T = Error> = () => T; type Failure = ReturnType<Result>;',
  'type Result<T> = ReturnType<() => T>; type Failure = Result<Error>;',
  'type Failure = ReturnType<ReturnType<() => () => Error>>;',
  'type Failure = ReturnType<(() => Error) | (() => { stack: string })>;',
  'type Failure = ReturnType<(() => { stack: string }) & (() => Error)>;',
  'type Call<T> = () => T; type Failure = ReturnType<Call<{ stack: string }> & Call<Error>>;',
  'type Failure = ReturnType<{ (): { stack: string }; (): Error }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): Error }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Factory<T> = { make(): T }; type Failure = Result<Factory<Error>>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make: () => Error }>;',
  'type Result<T> = T extends { make: () => infer R } ? R : never; type Failure = Result<{ make(): Error }>;',
  'type Result<T> = T extends { make(value: string): infer R } ? R : never; type Failure = Result<{ make(): Error }>;',
  'type Result<T> = T extends { make(value: infer P): unknown } ? P : never; type Failure = Result<{ make(value: Error): void }>;',
  'type Result<T> = T extends { make(value: { nested: infer P }): unknown } ? P : never; type Failure = Result<{ make(value: { nested: Error }): void }>;',
  'type Result<T> = T extends { make(value?: string): infer R } ? R : never; type Failure = Result<{ make(value: string): Error }>;',
  'type Result<T> = T extends { make(value: string | number): infer R } ? R : never; type Failure = Result<{ make(value: string): Error }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): { stack: string }; make(): Error }>;',
] as const;

const DATA = [
  'type Result<T> = T extends { value: infer R } ? R : never; type Failure = Result<{ get value(): { stack: string }; set value(next: Error | { stack: string }) }>;',
  'type Failure = ReturnType<() => { stack: string }>;',
  'type Result<T> = () => T; type Failure = ReturnType<Result<{ stack: string }>>;',
  'type Result<T = { stack: string }> = () => T; type Failure = ReturnType<Result>;',
  'type ReturnType<T> = { stack: string }; type Failure = ReturnType<() => Error>;',
  'type Failure = ReturnType<ReturnType<() => () => { stack: string }>>;',
  'type Loop = ReturnType<() => Loop>; type Failure = Loop;',
  'type Failure = ReturnType<(() => Error) & (() => { stack: string })>;',
  'type Call<T> = () => T; type Failure = ReturnType<Call<Error> & Call<{ stack: string }>>;',
  'type Failure = ReturnType<{ (): Error; (): { stack: string } }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): { stack: string } }>;',
  'type Result<T> = T extends { make(): infer R } ? R : Error; type Failure = Result<{ make(): { stack: string } }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Factory<T> = { make(): T }; type Failure = Result<Factory<{ stack: string }>>;',
  'type Result<T> = T extends { make(): infer R } ? R : { stack: string }; type Failure = Result<{ make(value: string): Error }>;',
  'type Result<T> = T extends { make(): infer R } ? R : { stack: string }; type Failure = Result<{ make?(): Error }>;',
  'type Result<T> = T extends { make: infer R } ? R : never; type Failure = Result<{ make(): Error }>;',
  'type Result<T> = T extends { make(): infer R } ? R : { stack: string }; type Failure = Result<{ other(): Error }>;',
  'type Result<T> = T extends { make(): infer Error } ? Error : never; type Failure = Result<{ make(): { stack: string } }>;',
  'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): Error; make(): { stack: string } }>;',
  'type Result<T> = T extends { make(value?: string): infer R } ? R : Error; type Failure = Result<{ make(value: string): { stack: string } }>;',
  'type Result<T> = T extends { make(value: string | number): infer R } ? R : Error; type Failure = Result<{ make(value: string): { stack: string } }>;',
] as const;

describe('written utility and method error results', () => {
  it.each(ERRORS)('retains a selected error result: %s', (declaration) => {
    expect(readsFrames(declaration)).toBe(true);
  });

  it.each(DATA)('preserves selected data and distinct method values: %s', (declaration) => {
    expect(readsFrames(declaration)).toBe(false);
  });
});

describe('shared helpers with selected error results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'type Failure = ReturnType<() => Error>;',
    'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): Error }>;',
  ])('refuses a declared error result in the actual compiler: %s', async (declaration) => {
    const app = await fixture(declaration, 'new Error("fixed")');
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('a shared module that answers otherwise'),
    ]);
  });

  it.each([
    'type Failure = ReturnType<() => { stack: string }>;',
    'type Result<T> = T extends { make(): infer R } ? R : never; type Failure = Result<{ make(): { stack: string } }>;',
  ])('accepts application data in the actual compiler: %s', async (declaration) => {
    const app = await fixture(declaration, '{ stack: value }');
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The frame read of the selected declared result, in its original lexical source. */
function readsFrames(declaration: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'selected-error-results.ts',
    `${declaration} function read(error: Failure) { return error.stack; }`,
  );
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A shared helper used by a dynamic site's child prop. */
async function fixture(declaration: string, argument: string): Promise<Application> {
  return application({
    'domain/error-results.ts': [
      declaration,
      'function frames(error: Failure): string { return error.stack ?? ""; }',
      `export function label(value: string) { return value + frames(${argument}); }`,
    ].join('\n'),
    'components/error-results.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/error-results';",
      'export default function ErrorResults({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
