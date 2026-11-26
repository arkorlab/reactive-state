import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Per-instance execution and lexical shadowing preserve the identity of module-held writes. */
describe('shared module kept scopes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'let count = 0; class Counter { value = ++count; } export function label(value: string): string { return value + new Counter().value; }',
    "const items: string[] = []; class Counter { value = items.push('next'); } export function label(value: string): string { return value + new Counter().value; }",
    'const counter = { count: 0, bump() { return ++this.count; } }; class Counter { value = counter.bump(); } export function label(value: string): string { return value + new Counter().value; }',
    'function makeCounter() { let count = 0; return class { value = ++count; }; } const Counter = makeCounter(); export function label(value: string): string { return value + new Counter().value; }',
    'let count = 0; export function label(value: string): string { for (let count = 0; count < 1; count++) {} count++; return value + count; }',
    'let count = 0; export function label(value: string): string { try {} catch (count) {} count++; return value + count; }',
    'let count = 0; export function label(value: string): string { { let count = 0; count++; } count++; return value + count; }',
    'let count = 0; export function label(value: string): string { { function count() {} } count++; return value + count; }',
  ])('refuses module state changed between calls: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('keeps between calls'),
    ]);
  });

  it.each([
    'let count = 0; class Counter { static value = ++count; } export function label(value: string): string { return value + Counter.value; }',
    "let count = 0; class Counter { [(count++, 'value') as 'value'] = 0; } export function label(value: string): string { return value + new Counter().value; }",
    'class Counter { value = (() => { const local = { count: 0 }; return ++local.count; })(); } export function label(value: string): string { return value + new Counter().value; }',
    'let count = 0; export function label(value: string): string { for (let count = 0; count < 1; count++) {} return value; }',
    'let count = 0; export function label(value: string): string { try { throw 0; } catch (count) { count = 1; } return value; }',
    'let count = 0; export function label(value: string): string { { let count = 0; count++; } return value; }',
    'let count = 0; export function label(value: string): string { if (true) { var count = 0; } count++; return value + count; }',
    'export function label(value: string): string { let count = 0; class Counter { value = ++count; } return value + new Counter().value; }',
  ])('keeps local shadows and class-definition effects: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared module read by a dynamic site rather than only by browser code. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/kept-scopes.ts': source,
    'components/kept-scopes.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/kept-scopes';",
      'export default function KeptScopes({ projectId, first }: { projectId: string; first: string }) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
