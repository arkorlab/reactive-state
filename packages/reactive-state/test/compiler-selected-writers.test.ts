import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Selecting a React setter or local writer does not defer a call made while rendering. */
describe('selected local writer calls', () => {
  const { apps, compile } = compilerApplications();

  const calls = [
    "(flag ? setFilter : setFilter)(current => current + 'x')",
    "((flag && setFilter) as typeof setFilter)('x')",
    "((flag || setFilter) as typeof setFilter)('x')",
    "(setFilter ?? setFilter)('x')",
    "(flag ? setFilter : setFilter).call(undefined, 'x')",
    '(flag ? reset : reset)()',
  ];

  it.each(calls)('refuses a selected writer invoked while rendering: %s', async (expression) => {
    const app = await fixture([`<p>{${expression}}`, '{filter}</p>'].join(''));
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('handler of an event');
  });

  it.each(calls)(
    'keeps a selected writer invoked by a person’s handler: %s',
    async (expression) => {
      const app = await fixture(
        [`<p onClick={() => { ${expression}; }}>`, '{filter}</p>'].join(''),
      );
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );

  it.each([
    '<p onClick={flag ? reset : reset}>{filter}</p>',
    '<p onClick={flag && reset || reset}>{filter}</p>',
    '<p>{(setFilter ? plain : plain)()}{filter}</p>',
  ])('keeps a handed handler or a setter read only as the condition: %s', async (render) => {
    const app = await fixture(render);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '<p>{(setFilter && plain)()}{filter}</p>',
    '<p>{(reset && plain)()}{filter}</p>',
    '<p>{((flag ? setFilter : reset) && plain)()}{filter}</p>',
  ])('keeps a truthy writer read only on the left of logical and: %s', async (render) => {
    const app = await fixture(render);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "<p>{(plain && setFilter)('x')}{filter}</p>",
    "<p>{(setFilter || plain)('x')}{filter}</p>",
    '<p>{(plain && reset)()}{filter}</p>',
  ])('refuses a logical selection that calls the writer: %s', async (render) => {
    const app = await fixture(render);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('handler of an event');
  });
});

/** A dynamic child reads the evaluated local state, whose setter still belongs to React. */
async function fixture(render: string): Promise<Application> {
  return application({
    'components/selected-writers.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function SelectedWriters({flag}: {flag: boolean}) {',
      "  const [filter, setFilter] = useReactiveState('');",
      "  const reset = () => { setFilter(''); };",
      '  const plain = () => filter;',
      `  return <section>${render}`,
      '    <TodoCommands projectId="p1" id={filter} /></section>;',
      '}',
    ].join('\n'),
  });
}
