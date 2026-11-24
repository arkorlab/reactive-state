import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** The generated setter entry point is reserved even for source-selected local setters. */
describe('application reads of a local setter compiled member', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "<p>{(setSelected as any).compiled('x', {}, (current: string) => current === 'a' ? 'b' : 'a')}{selected}</p>",
    "<p>{(setSelected as any)['compiled']('x', {}, (current: string) => current)}{selected}</p>",
    "<p>{(again as any).compiled('x', {}, (current: string) => current)}{selected}</p>",
    "<p>{(actions.write as any).compiled('x', {}, (current: string) => current)}{selected}</p>",
    "<p onClick={() => (setSelected as any).compiled('x', {}, (current: string) => current)}>{selected}</p>",
    '<p onClick={(setSelected as any).compiled}>{selected}</p>',
  ])('refuses a reserved source member use: %s', async (render) => {
    const app = await fixture(render);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain("compiler's to write");
  });

  it.each([
    '<p onClick={() => setSelected(current => current + first)}>{selected}</p>',
    '<p onClick={() => again(first)}>{selected}</p>',
    '<p onClick={() => actions.write(first)}>{selected}</p>',
    '<p onClick={() => (setSelected as any).call(undefined, first)}>{selected}</p>',
    '<p>{actions.compiled()}{selected}</p>',
    '<p>{plain.compiled()}{selected}</p>',
  ])('keeps ordinary updates and application-owned members: %s', async (render) => {
    const app = await fixture(render);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it('keeps the generated localOf binding for an ordinary source update', async () => {
    const app = await fixture(
      '<p onClick={() => setSelected(current => current + first)}>{selected}</p>',
    );
    apps.push(app);

    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);
    expect([...compiled.outputs.values()].join('\n')).toContain('localOf');
  });
});

/** A prop-selected local state is rendered through a dynamic child. */
async function fixture(render: string): Promise<Application> {
  return application({
    'components/setter-compiled.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function SetterCompiled({first}: {first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  const again = setSelected;',
      '  const actions = { write: setSelected, compiled: () => first };',
      '  const plain = { compiled: () => first };',
      `  return <section>${render}`,
      '    <TodoCommands projectId="p1" id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
