import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A source-proven skipped invocation never executes the nullish binding in its body. */
describe('skipped binding invocations', () => {
  const { apps, compile } = compilerApplications();

  it.each(['false &&', 'true ||', '"present" ??'])(
    'keeps a skipped binding invocation after %s',
    async (operator) => {
      const app = await fixture(operator);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );

  it.each(['true &&', 'false ||', 'null ??'])(
    'refuses an executed binding invocation after %s',
    async (operator) => {
      const app = await fixture(operator);
      apps.push(app);

      expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('no JSON holds'),
      ]);
    },
  );
});

/** A prop-dependent initializer executes a selected synchronous helper before answering JSON. */
async function fixture(operator: string): Promise<Application> {
  return application({
    'components/skipped-binding.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function SkippedBinding({projectId, first}: {projectId: string; first: string}) {',
      `  const [value, setValue] = useReactiveState<string>(first === '' ? (${operator} (() => { const {} = null as never; return 0; })(), 'ok') : first);`,
      '  return <section><button onClick={() => setValue(first)}>reset</button><TodoCommands projectId={projectId} id={value} /></section>;',
      '}',
    ].join('\n'),
  });
}
