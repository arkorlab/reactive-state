import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source helper execution while a constructor computes metadata of a fresh receiver. */
describe('metadata through source helper calls', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "const helper = { change() { items[0] = 'changed'; } }; class Changed { constructor() { try { helper.change(); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change() { items[0] = 'changed'; } class Changed { constructor() { try { change.call(null); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change() { items[0] = 'changed'; } class Changed { constructor() { try { change.apply(null, []); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change() { items[0] = 'changed'; } class Changed { constructor() { try { Reflect.apply(change, null, []); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change(value: string[]) { value[0] = 'changed'; } class Changed { constructor() { try { change.call(null, items); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change(value: string[]) { value[0] = 'changed'; } class Changed { constructor() { try { change.apply(null, [items]); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "const helper = { call(value: string[]) { value[0] = 'changed'; } }; class Changed { constructor() { try { helper.call(items); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change(this: string[]) { this[0] = 'changed'; } class Changed { constructor() { try { change.call(items); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function change(this: string[]) { this[0] = 'changed'; } class Changed { constructor() { try { change.apply(items, []); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "const helper = { value: items, change() { this.value[0] = 'changed'; } }; class Changed { constructor() { try { helper.change(); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "function read() {} read.call = () => { items[0] = 'changed'; }; class Changed { constructor() { try { read.call(null); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
  ])('refuses a helper that observes writes into the input: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'const helper = { read(value: string[]) { return value.length; } }; class Fresh { constructor(value: string[]) { helper.read(value); } } return String(Object.isFrozen(new Fresh(items)));',
    'const helper = { read(value: string[]) { return value.length; } }; const alias = helper; class Fresh { constructor(value: string[]) { alias["read"](value); } } return String(Object.isFrozen(new Fresh(items)));',
    'const helper = { read(value: string[]) { return value.length; } }; const read = helper.read; class Fresh { constructor(value: string[]) { read(value); } } return String(Object.isFrozen(new Fresh(items)));',
    'function read(value: string[]) { return value.length; } class Fresh { constructor(value: string[]) { read.call(null, value); } } return String(Object.isFrozen(new Fresh(items)));',
    'function read(value: string[]) { return value.length; } class Fresh { constructor(value: string[]) { read.apply(null, [value]); } } return String(Object.isFrozen(new Fresh(items)));',
    'function read(value: string[]) { return value.length; } class Fresh { constructor(value: string[]) { Reflect.apply(read, null, [value]); } } return String(Object.isFrozen(new Fresh(items)));',
    'const helper = { call(value: string[]) { return value.length; } }; class Fresh { constructor(value: string[]) { helper.call(value); } } return String(Object.isFrozen(new Fresh(items)));',
    'const helper = { apply(value: string[]) { return value.length; } }; class Fresh { constructor(value: string[]) { helper.apply(value); } } return String(Object.isFrozen(new Fresh(items)));',
    'const helper = { read(value: string[]) { return value.length; } }; const key = "read"; class Fresh { constructor(value: string[]) { helper[key](value); } } return String(Object.isFrozen(new Fresh(items)));',
    'function read(value: string[]) { return value.length; } const key = "call"; class Fresh { constructor(value: string[]) { read[key](null, value); } } return String(Object.isFrozen(new Fresh(items)));',
    'function read(value: string[]) { return value.length; } const key = "apply"; class Fresh { constructor(value: string[]) { read[key](null, [value]); } } return String(Object.isFrozen(new Fresh(items)));',
  ])('keeps a pure source helper and the fresh receiver metadata: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A dynamic site whose helper receives the browser's mutable state input. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/call-metadata.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/call-metadata.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/call-metadata';",
      'export default function CallMetadata({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
