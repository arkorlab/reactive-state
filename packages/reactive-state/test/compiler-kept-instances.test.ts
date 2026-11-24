import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Returned instances retain callable members, while their construction has already run. */
describe('shared factory retained instances', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'function makeCounter() { let count = 0; class Counter { bump() { return ++count; } } return new Counter(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.bump(); }',
    'function makeCounter() { let count = 0; class Counter { bump() { return ++count; } } const Factory = Counter; return new Factory(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.bump(); }',
    'function makeCounter() { let count = 0; return new (class { bump() { return ++count; } })(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.bump(); }',
    'function makeCounter() { let count = 0; class Counter { bump = () => ++count; } return new Counter(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.bump(); }',
    'let count = 0; export function label(value: string): string { { let count = 0; count++; } return value + ++count; }',
    'function makeCounter() { let count = 0; return class { value = ++count; }; } const Counter = makeCounter(); export function label(value: string): string { return value + new Counter().value; }',
  ])('refuses captured writes that survive a factory call: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('keeps between calls'),
    ]);
  });

  it.each([
    'function makeCounter() { const count = 0; class Counter { read() { return count; } } return new Counter(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.read(); }',
    'function makeCounter() { let count = 0; class Counter { bump() { return ++count; } } return new Counter(); } export function label(value: string): string { return value + makeCounter().bump(); }',
    'function makeCounter() { let count = 0; class Counter { value = ++count; read() { return count; } } return new Counter(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.read(); }',
    'function makeCounter() { let count = 0; class Counter { constructor() { count++; } read() { return count; } } return new Counter(); } const counter = makeCounter(); export function label(value: string): string { return value + counter.read(); }',
  ])('keeps pure methods, fresh instances and completed construction: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A module-load factory result used repeatedly as a dynamic site's input. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/kept-instances.ts': source,
    'components/kept-instances.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/kept-instances';",
      'export default function KeptInstances({ projectId, first }: { projectId: string; first: string }) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
