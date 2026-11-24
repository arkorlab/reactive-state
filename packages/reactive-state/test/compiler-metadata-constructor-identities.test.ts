import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Constructor return identity stays unknown where binding or invocation can retain an input. */
describe('metadata constructor identity proofs', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Identity { constructor(...[value]: [string[]]) { return value; } } return String(Object.isFrozen(new Identity(items)));',
    'class Identity { constructor([, ...[value]]: [number, ...string[][]]) { return value; } } return String(Object.isFrozen(new Identity([0, items])));',
    'class Identity { constructor({value = []}: {value?: string[]}) { return value; } } const argument = {__proto__: {value: items}}; return String(Object.isFrozen(new Identity(argument as {value?: string[]})));',
    'class Identity { constructor({value}: {value: string[]}, _ignored?: unknown) { return value; } } const argument = {value: [] as string[]}; return String(Object.isFrozen(new Identity(argument, argument.value = items)));',
    'function Fresh(_value: string[]) {} Fresh = function(value: string[]) { return value; }; return String(Object.isFrozen(new (Fresh as unknown as new (value: string[]) => object)(items)));',
  ])('refuses an unproven fresh constructor result: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'class Fresh { constructor(...values: string[][]) { return values; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor([, ...values]: [number, ...string[][]]) { return values; } } return String(Object.isFrozen(new Fresh([0, items])));',
    'class Fresh { constructor({...values}: string[]) { return values; } } return String(Object.isFrozen(new Fresh(items)));',
    'class Fresh { constructor({holder: {value}}: {holder: {value: string[]}}) { return value; } } return String(Object.isFrozen(new Fresh({holder: {value: []}})));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({__proto__: null} as {value?: string[]})));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({value: [], __proto__: {value: items}})));',
    'function Fresh(_value: string[]) {} const Factory = Fresh as unknown as new (value: string[]) => object; return String(Object.isFrozen(new Factory(items)));',
  ])('keeps direct rest copies and written fresh return values: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A dynamic site whose shared helper can compare browser and authority input flags. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/constructor-identity.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/constructor-identity.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/constructor-identity';",
      'export default function ConstructorIdentity({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
