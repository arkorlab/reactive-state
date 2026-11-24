import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native callbacks execute while a constructor computes the flags of a fresh receiver. */
describe('metadata through native callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "Array.from([0], () => { items[0] = 'changed'; });",
    "const mapping = () => { items[0] = 'changed'; }; Array.from([0], mapping);",
    "Uint8Array.from([0], () => { items[0] = 'changed'; return 0; });",
    "JSON.stringify({}, () => { items[0] = 'changed'; return 0; });",
    "Object.groupBy([0], () => { items[0] = 'changed'; return 'group'; });",
    "Map.groupBy([0], () => { items[0] = 'changed'; return 'group'; });",
    "Array.from([items], (value) => { value[0] = 'changed'; });",
    "Array.from([0], function(this: string[]) { this[0] = 'changed'; }, items);",
    "Array.from([undefined], (value = (items[0] = 'changed')) => value);",
    "function mapping() { return () => { items[0] = 'changed'; }; } Array.from([0], mapping());",
  ])('refuses callbacks that can observe input writes: %s', async (operation) => {
    const app = await fixture(operation);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'Array.from([0], (value) => value + items.length);',
    'const mapping = (value: number) => value + items.length; Array.from([0], mapping);',
    'Array.from([items], (value) => value.length);',
    'Uint8Array.from([0], (value) => value + items.length);',
    'JSON.stringify(items, (_key, value: unknown) => value);',
    "Object.groupBy([0], () => 'group');",
    "Map.groupBy([0], () => 'group');",
    "Array.from([], () => { items[0] = 'changed'; });",
    "Uint8Array.from([], () => { items[0] = 'changed'; return 0; });",
    'Array.from(items);',
    'Array.from(items, undefined);',
    'Array.from(items, void 0);',
    "JSON.stringify(items, ['length']);",
    'JSON.stringify(items, null);',
    'JSON.stringify(items, 0);',
    'JSON.stringify(items, false);',
    'JSON.stringify(items, {});',
  ])('keeps pure callbacks and unused optional mappings: %s', async (operation) => {
    const app = await fixture(operation);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Frozen input writes can keep the constructor from freezing its own fresh receiver. */
async function fixture(operation: string): Promise<Application> {
  return application({
    'domain/native-metadata.ts': `export function label(items: string[]): string { class Changed { constructor() { try { ${operation} Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed())); }\n`,
    'components/native-metadata.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/native-metadata';",
      'export default function NativeMetadata({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
