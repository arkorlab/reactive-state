import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A private class instantiated only as a module loads may publish primitive data without escaping. */
describe('shared startup instance fields', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'let count = 0; class Counter { value = ++count; } const kept = new Counter(); export function label(value: string): string { return value + kept.value; }',
    'let count = 0; class Counter { value = ++count; } const left = new Counter(); const right = new Counter(); export function label(value: string): string { return value + left.value + right.value; }',
    'let count = 0; class Counter { static value = ++count; } export function label(value: string): string { return value + Counter.value; }',
    'export function label(value: string): string { let count = 0; class Counter { value = ++count; } return value + new Counter().value; }',
    "let count = 0; class Counter { [(count++, 'value') as 'value'] = 0; } export function label(value: string): string { return value + new Counter().value; }",
  ])('keeps one-time primitive fields and local construction: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'let count = 0; class Counter { value = ++count; } export function label(value: string): string { return value + new Counter().value; }',
    'let count = 0; class Counter { value = ++count; } const Factory = Counter; export function label(value: string): string { return value + new Factory().value; }',
    'let count = 0; export class Counter { value = ++count; } const kept = new Counter(); export function label(value: string): string { return value + kept.value; }',
    'let count = 0; class Counter { value = ++count; } export const kept = new Counter(); export function label(value: string): string { return value + kept.value; }',
    'let count = 0; class Counter { value = ++count; } const kept = new Counter(); export function label(value: string): string { const Factory = kept.constructor as new () => Counter; return value + new Factory().value; }',
    'let count = 0; class Counter { value: Counter = (++count, this); } const kept = new Counter(); export function label(value: string): string { const Factory = kept.value.constructor as new () => Counter; new Factory(); return value + count; }',
  ])('refuses repeated construction and escaping class identities: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toHaveLength(1);
  });
});

/** A dynamic site reads the shared helper repeatedly across browser renders and authority calls. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/kept-fields.ts': source,
    'components/kept-fields.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/kept-fields';",
      'export default function KeptFields({ projectId, first }: { projectId: string; first: string }) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
