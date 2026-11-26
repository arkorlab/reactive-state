import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Assignment patterns replace constructor parameters before their returned identity is read. */
describe('metadata destructured parameter replacements', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Fresh { constructor(value: string[] = []) { [value] = [items]; return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { ({value} = {value: items}); return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { [...[value]] = [items]; return value; } } return String(Object.isFrozen(new Fresh()));',
  ])('refuses a pattern replacing a fresh parameter with an input: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'class Fresh { constructor(value: string[] = []) { [value] = [[]]; return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { ({value} = {value: []}); return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { ({0: value} = {0: []}); return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { [...value] = items; return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { ({...value} = items); return value; } } return String(Object.isFrozen(new Fresh()));',
  ])('keeps a pattern replacing a parameter with a fresh array: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A constructor's returned parameter exposes identity through a shared metadata read. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/destructured-parameters.ts': `export function label(items: string[]): string { ${body} }`,
    'components/destructured-parameters.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/destructured-parameters';",
      'export default function DestructuredParameters({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
