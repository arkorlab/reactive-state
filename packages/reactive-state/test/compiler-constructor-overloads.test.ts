import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Constructor signatures do not replace the implementation's input identity and effects. */
describe('metadata constructor overload implementations', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Identity { constructor(value: string[]); constructor(value: string[]) { return value; } } return String(Object.isFrozen(new Identity(items)));',
    'class Identity { constructor(); constructor(value: string[]); constructor(value = items) { return value; } } return String(Object.isSealed(new Identity()));',
    'const Identity = class { constructor(value: string[]); constructor(value: string[]) { return value; } }; const Alias = Identity; return String(Reflect.isExtensible(new Alias(items)));',
    'class Identity { constructor(value: string[]); constructor({ value }: { value: string[] }); constructor(given: string[] | { value: string[] }) { return Array.isArray(given) ? given : given.value; } } return String(Object.isFrozen(new Identity({ value: items })));',
    "class Changed { constructor(value: string[]); constructor(value: string[]) { try { value[0] = 'changed'; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed(items)));",
    "class Changed { constructor(); constructor() { try { items[0] = 'changed'; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Changed()));",
    "class Changed { constructor(value: string[]); constructor(value: string[]) { try { change(value); Object.freeze(this); } catch {} } } function change(value: string[]) { value[0] = 'changed'; } return String(Object.isFrozen(new Changed(items)));",
    "class Changed { flag = (() => { try { items[0] = 'changed'; Object.freeze(this); } catch {} return 0; })(); constructor(); constructor() {} } return String(Object.isFrozen(new Changed()));",
  ])('refuses retained input identity or observable writes: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'class Fresh { constructor(value: string[]); constructor(_value: string[]) {} } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { size: number; constructor(value: string[]); constructor(value: string[]) { this.size = value.length; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(value: string[]); constructor(_value: string[]) { return {}; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(value: string[]); constructor(value: string[]) { return [...value]; } } return String(Object.isSealed(new Fresh(items)));',
    'class Fresh { constructor(value: string[]); constructor(value: string[]) { value = []; return value; } } return String(Reflect.isExtensible(new Fresh(items)));',
    'class Fresh { constructor(); constructor(value: string[]); constructor(value: string[] = []) { return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[]); constructor(value: string[]) { read(value); } } function read(value: string[]) { return value.length; } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor(value: string[]); constructor(_value: string[]) { const change = () => { items[0] = "changed"; }; } } return String(Object.isFrozen(new Fresh(items)));',
  ])('keeps fresh results and read-only implementations: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared helper whose metadata can differ for browser inputs and authority-frozen inputs. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/constructor-overloads.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/constructor-overloads.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/constructor-overloads';",
      'export default function ConstructorOverloads({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
