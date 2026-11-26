import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native legacy accessor definitions return nothing; application-owned methods keep their results. */
describe('legacy accessor definition results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "({} as any).__defineGetter__('x', () => 1)",
    "({} as any).__defineSetter__('x', (_value: unknown) => {})",
    "({} as any)['__defineGetter__']('x', () => 1)",
    "({} as any)['__defineSetter__']('x', (_value: unknown) => {})",
  ])('refuses an inherited accessor definition used as a state value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "({ __defineGetter__() { return 'own'; } }).__defineGetter__()",
    "({ __defineSetter__: () => 'own' }).__defineSetter__()",
    "({ ['__defineGetter__']: () => 'own' })['__defineGetter__']()",
    "({} as any).__defineGetter__('x', () => 1), 'ok'",
    "({} as any).__defineSetter__('x', (_value: unknown) => {}), 'ok'",
  ])('keeps an application result or a discarded native result: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "class Box { __defineGetter__() { return 'own'; } } export function make() { return new Box().__defineGetter__(); }",
    "class Box { __defineSetter__() { return 'own'; } } export function make() { return new Box().__defineSetter__(); }",
    "export function make() { return new (class { __defineGetter__() { return 'own'; } })().__defineGetter__(); }",
  ])('keeps a class’s own accessor-definition method: %s', async (source) => {
    const app = await fixture('make()', source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "class Box {} export function make() { return (new Box() as any).__defineGetter__('x', () => 1); }",
    "class Box { static __defineGetter__() { return 'own'; } } export function make() { return (new Box() as any).__defineGetter__('x', () => 1); }",
  ])('refuses a class instance’s inherited native definition result: %s', async (source) => {
    const app = await fixture('make()', source);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });
});

/** A prop-dependent first value is evaluated by the authority for a dynamic child. */
async function fixture(expression: string, module?: string): Promise<Application> {
  return application({
    ...(module !== undefined && { 'domain/accessor-result.ts': module }),
    'components/accessor-result.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      ...(module === undefined ? [] : ["import { make } from '@/domain/accessor-result';"]),
      'export default function AccessorResult({projectId, first}: {projectId: string; first: string}) {',
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}) as never : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
