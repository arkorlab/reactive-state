import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Synchronous native executions can make a constructor observe frozen input writes. */
describe('metadata through synchronous native executions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "let failed=false; new Promise(() => { try { items[0]='changed'; } catch { failed=true; } }); if (failed) throw 0;",
    "let failed=false; const executor=() => { try { items[0]='changed'; } catch { failed=true; } }; new Promise(executor); if (failed) throw 0;",
    "let failed=false; new Promise(async () => { try { items[0]='changed'; } catch { failed=true; } await 0; }); if (failed) throw 0;",
    "let failed=false; new Promise((resolve) => { resolve=() => { try { items[0]='changed'; } catch { failed=true; } }; resolve(); }); if (failed) throw 0;",
    "JSON.parse('0', () => { items[0]='changed'; return 0; });",
    "const revive=() => { items[0]='changed'; return 0; }; JSON.parse('0', revive);",
    "let failed=false; JSON.parse('0', async () => { try { items[0]='changed'; } catch { failed=true; } await 0; }); if (failed) throw 0;",
    "Reflect.construct(function() { items[0]='changed'; }, []);",
    "class Writer { value=(items[0]='changed'); } Reflect.construct(Writer, []);",
    "Reflect.construct(function(value: string[]) { value[0]='changed'; }, [items]);",
    "JSON.parse('{\"a\":1,\"b\":0}', function(key, value=(items[0]='changed', 0)) { if (key==='a') delete this.b; return value; });",
    "Reflect.construct(function() { items[0]='changed'; }, [], function() {});",
  ])('refuses synchronous effects that expose input flags: %s', async (operation) => {
    const app = await fixture(operation);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'new Promise(() => items.length);',
    'new Promise((resolve) => resolve());',
    'new Promise((resolve) => resolve(0));',
    'new Promise((resolve) => resolve(false));',
    "new Promise(() => () => { items[0]='changed'; });",
    "new Promise(function* () { items[0]='changed'; });",
    "new Promise(function* (resolve = (items[0]='changed')) {});",
    "new Promise(async () => { await 0; try { items[0]='changed'; } catch {} });",
    'new Promise(async () => { items.length; await 0; });',
    'new Promise(1 as never);',
    "Promise(() => { items[0]='changed'; });",
    "JSON.parse('0', () => items.length);",
    "JSON.parse('0', (_key, value=(items[0]='changed', 0)) => value);",
    "JSON.parse('0', null);",
    "JSON.parse('0', 0);",
    "JSON.parse('0', false);",
    "JSON.parse('0', {});",
    "JSON.parse('0', []);",
    "JSON.parse('{', () => { items[0]='changed'; });",
    "JSON.parse('0', function* () { items[0]='changed'; });",
    "JSON.parse('0', async () => { await 0; try { items[0]='changed'; } catch {} });",
    'Reflect.construct(function() { return items.length; }, []);',
    "Reflect.construct(function() { const copy=[...items]; copy[0]='changed'; }, []);",
    "Reflect.construct(function* () { items[0]='changed'; }, []);",
    "Reflect.construct(async function() { items[0]='changed'; }, []);",
    "Reflect.construct(() => { items[0]='changed'; }, []);",
    'Reflect.construct(Array, []);',
    "Reflect.construct(function() { items[0]='changed'; }, [], () => {});",
    "Reflect.construct(function() { items[0]='changed'; }, [], ({method() {}}).method);",
    "Reflect.construct(function() {}, [], class { constructor() { items[0]='changed'; } });",
  ])('keeps pure, deferred and uninvoked bodies: %s', async (operation) => {
    const app = await fixture(operation);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A caught failure can leave the fresh instance mutable only on the authority. */
async function fixture(operation: string): Promise<Application> {
  return application({
    'domain/synchronous-metadata.ts': `export function label(items: string[]): string { class Changed { constructor() { try { ${operation} Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed())); }\n`,
    'components/synchronous-metadata.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/synchronous-metadata';",
      'export default function SynchronousMetadata({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
