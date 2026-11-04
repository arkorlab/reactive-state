import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rest arrays are present arguments even where the metadata analysis stores no source expression. */
describe('metadata constructor rest arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { return new Identity(values); } } return String(Object.isFrozen(new Outer()));',
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { const passed = values; return new Identity(passed); } } return String(Object.isFrozen(new Outer()));',
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } return String(Object.isFrozen(new Identity([])));',
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { return new Identity(values); } } return String(Object.isFrozen(new Outer(items)));',
    'class Identity { constructor(value: unknown = []) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { values = undefined as never; return new Identity(values); } } return String(Object.isFrozen(new Outer()));',
  ])('keeps fresh rest arrays and source-proven omitted defaults: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } return String(Object.isFrozen(new Identity()));',
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } return String(Object.isFrozen(new Identity(void 0)));',
    'class Identity { constructor(value: unknown = items) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { values = undefined as never; return new Identity(values); } } return String(Object.isFrozen(new Outer()));',
    'class Identity { constructor(value: unknown = []) { return value as Identity; } } class Outer { constructor(...values: unknown[]) { values = items; return new Identity(values); } } return String(Object.isFrozen(new Outer()));',
  ])('refuses input defaults and rebound input arguments: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });
});

/** A dynamic site whose shared helper observes state metadata on each side. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/rest-metadata.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/rest-metadata.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/rest-metadata';",
      'export default function RestMetadata({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
