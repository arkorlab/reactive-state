import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Shared helpers cannot expose constructor-inferred native error frames. */
describe('shared constructor inference results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      name: 'constructor result',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<new () => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: true,
    },
    {
      name: 'abstract constructor result',
      source:
        'type Made<T> = T extends abstract new () => infer R ? R : never; function read(value: Made<abstract new () => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: true,
    },
    {
      name: 'optional function accepts explicit undefined',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<(value?: string) => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: true,
    },
    {
      name: 'optional constructor accepts explicit undefined',
      source:
        'type Made<T> = T extends new (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<new (value?: string) => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: true,
    },
    {
      name: 'ordinary constructor data',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<new () => { stack: string }>) { return value.stack; } export function label(value: string) { return value; }',
      refused: false,
    },
    {
      name: 'abstract source cannot construct concrete',
      source:
        'type Made<T> = T extends new () => infer R ? R : { stack: string }; function read(value: Made<abstract new () => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: false,
    },
    {
      name: 'incompatible constructor parameter',
      source:
        'type Made<T> = T extends new (value: number) => infer R ? R : { stack: string }; function read(value: Made<new (value: string) => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: false,
    },
    {
      name: 'optional function data selects true branch',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : Error; function read(value: Made<(value?: string) => { stack: string }>) { return value.stack; } export function label(value: string) { return value; }',
      refused: false,
    },
    {
      name: 'function optional tuple rest error',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<(...values: [value?: string]) => Error>) { return value.stack; } export function label(value: string) { return value; }',
      refused: true,
    },
    {
      name: 'function optional tuple rest data',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : Error; function read(value: Made<(...values: [value?: string]) => { stack: string }>) { return value.stack; } export function label(value: string) { return value; }',
      refused: false,
    },
  ])('$name', async ({ source, refused }) => {
    const app = await fixture(source);
    apps.push(app);

    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

async function fixture(source: string): Promise<Application> {
  return application({
    'domain/constructor-pattern.ts': source,
    'components/constructor-pattern.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/constructor-pattern';",
      'export default function ConstructorPattern({projectId, first}: {projectId: string; first: string}) {',
      'const [selected, setSelected] = useReactiveState(first);',
      'return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;}',
    ].join('\n'),
  });
}
