import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Metadata of wrappers that retain an input's flags, rather than those of a fresh value. */

describe('shared metadata reads through native wrappers', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'return String(Object.isFrozen(new Proxy(items, {})));',
    'return String(Object.isSealed(new Proxy(items, {})));',
    'return String(Object.isExtensible(new Proxy(items, {})));',
    "return String(Object.getOwnPropertyDescriptor(new Proxy(items, {}), 'length')?.writable);",
    'return String(Reflect.isExtensible(new Proxy(items, {})));',
    "return String(Reflect.getOwnPropertyDescriptor(new Object(items), 'length')?.writable);",
    'return String(Object.isFrozen(new Object(items)));',
    'return String(Object.isFrozen(new globalThis.Proxy(items, {})));',
    'return String(Object.isFrozen(new globalThis.Object(items)));',
    'const View = Proxy; const wrapper = new View(items, {}); return String(Object.isFrozen(wrapper));',
    'const View = globalThis.Proxy; const Again = View; return String(Object.isFrozen(new Again(items, {})));',
    'return String(Object.isFrozen(new Proxy(new Object(items), {})));',
  ])('refuses an input wrapper whose flags differ across sides: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    const reasons = compile(app).refusals.map((refusal) => refusal.reason);

    expect(reasons).toStrictEqual([expect.stringContaining('flags differ between the browser')]);
  });

  it.each([
    'return String(Object.isFrozen(new Object()));',
    "return String(Object.isFrozen(new Object('text')));",
    'return String(Object.isFrozen(new Proxy([...items], {})));',
    'const View = Proxy; return String(Object.isFrozen(new View([...items], {})));',
    'return String(Object.isFrozen(new Array(items.length)));',
    'const Proxy = class { constructor(_items: readonly string[]) {} }; return String(Object.isFrozen(new Proxy(items)));',
  ])('keeps metadata of a fresh value: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'class Identity { constructor(value: string[]) { return value; } } return String(Object.isFrozen(new Identity(items)));',
    'function Identity(value: string[]) { return value; } return String(Object.isSealed(new Identity(items)));',
    'class Identity { constructor(value: string[]) { return value; } } const Alias = Identity; return String(Object.isFrozen(new Alias(items)));',
    'const Identity = function(value: string[]) { return value; }; const Alias = Identity; return String(Object.isFrozen(new Alias(items)));',
    'class Identity { constructor() { return items; } } return String(Object.isFrozen(new Identity()));',
    'class Identity { constructor(value = items) { return value; } } return String(Object.isFrozen(new Identity()));',
    'const missing = undefined; class Identity { constructor(value = items) { return value; } } return String(Object.isFrozen(new Identity(missing)));',
    'const missing = void 0; class Identity { constructor({ value = items }: { value?: string[] }) { return value; } } return String(Object.isFrozen(new Identity({ value: missing })));',
    'class Identity { constructor(value: string[]) { return value.length ? value : []; } } return String(Object.isFrozen(new Identity(items)));',
    "class Changed { constructor(value: string[]) { try { value[0] = 'changed'; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed(items)));",
    'class Identity { constructor(value: string[]) { value = []; if (items.length > 0) { value = items; } return value; } } return String(Object.isFrozen(new Identity(items)));',
    'class Identity { constructor({ value }: { value: string[] }) { return value; } } return String(Object.isFrozen(new Identity({ value: items })));',
    "class Changed { flag = (() => { try { items[0] = 'changed'; Object.freeze(this); } catch {} return 0; })(); constructor() {} } return String(Object.isFrozen(new Changed()));",
    "const wrapped = new Proxy({}, { getOwnPropertyDescriptor() { let writable = true; try { items[0] = 'changed'; } catch { writable = false; } return { configurable: true, value: writable }; } }); return String(Object.getOwnPropertyDescriptor(wrapped, 'probe')?.value);",
    "const change = () => { items[0] = 'changed'; }; const handler = { getOwnPropertyDescriptor() { let writable = true; try { change(); } catch { writable = false; } return { configurable: true, value: writable }; } }; return String(Object.getOwnPropertyDescriptor(new Proxy({}, handler), 'probe')?.value);",
    "const handler = { get getOwnPropertyDescriptor() { let writable = true; try { items[0] = 'changed'; } catch { writable = false; } return () => ({ configurable: true, value: writable }); } }; return String(Object.getOwnPropertyDescriptor(new Proxy({}, handler), 'probe')?.value);",
    "const change = () => { let writable = true; try { items[0] = 'changed'; } catch { writable = false; } return { configurable: true, value: writable }; }; const handler = { get getOwnPropertyDescriptor() { return change; } }; return String(Object.getOwnPropertyDescriptor(new Proxy({}, handler), 'probe')?.value);",
  ])(
    'refuses source-proven custom construction or trap dependence on input flags: %s',
    async (body) => {
      const app = await fixture(body);
      apps.push(app);

      expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('flags differ between the browser'),
      ]);
    },
  );

  it.each([
    'class Fresh {} return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(_value: string[]) {} } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(value: string[]) { this.size = value.length; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(_value: string[]) { return {}; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(_value: string[]) { return undefined; } } return String(Object.isFrozen(new Fresh(items)));',
    'function Fresh(_value: string[]) { return 1; } return String(Object.isFrozen(new Fresh(items)));',
    'function Fresh(_value: string[]) { return void 0; } return String(Object.isFrozen(new Fresh(items)));',
    'function Fresh(_value: string[]) { return -1; } return String(Object.isFrozen(new Fresh(items)));',
    'function Fresh(_value: string[]) { return 1 + 1; } return String(Object.isFrozen(new Fresh(items)));',
    'function Identity(value: string) { return value; } return String(Object.isFrozen(new Identity("primitive")));',
    'class Fresh { constructor(value: string[] = []) { return value; } } return String(Object.isFrozen(new Fresh(void 0)));',
    'class Fresh { constructor(value: string[]) { value = []; return value; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor({ value }: { value: string[] }) { return value; } } return String(Object.isFrozen(new Fresh({ value: [] })));',
    'class Fresh { constructor(...values: string[][]) { return values; } } return String(Object.isFrozen(new Fresh(items)));',
    "return String(Object.getOwnPropertyDescriptor(new Proxy({}, { getOwnPropertyDescriptor() { return { configurable: true, value: 1 }; } }), 'probe')?.value);",
    "return String(Object.getOwnPropertyDescriptor(new Proxy({}, { getOwnPropertyDescriptor() { return { configurable: true, value: items.length }; } }), 'probe')?.value);",
    "const handler = { get getOwnPropertyDescriptor() { return () => ({ configurable: true, value: items.length }); } }; return String(Object.getOwnPropertyDescriptor(new Proxy({}, handler), 'probe')?.value);",
  ])('keeps proven fresh custom construction and pure traps: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared helper whose result is read by a dynamic site of its mutable browser input. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/wrapper-metadata.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/wrapper-metadata.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/wrapper-metadata';",
      'export default function WrapperMetadata({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
