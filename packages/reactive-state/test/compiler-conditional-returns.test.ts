import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A conditional return or throw does not establish an unconditional exception. */
describe('conditional return exception boundaries', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "(() => { if (projectId) return first; throw new Error('fallback'); })()",
    "(() => { if (!projectId) { throw new Error('guard'); } return first; })()",
    "(() => { if (!projectId) throw new Error('guard'); return first; })()",
    "(() => { if (projectId) { return first; } else { throw new Error('fallback'); } })()",
    "(() => { if (true) { return first; } throw new Error('unreachable'); })()",
    "(() => { if (false) { throw new Error('unreachable'); } return first; })()",
    "[first].forEach(() => { if (projectId) return; throw new Error('fallback'); })",
  ])('keeps an initializer with a possible nonthrowing path: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "(() => { if (true) { throw new Error('guard'); } return first; })()",
    "(() => { if (false) { return first; } else { throw new Error('fallback'); } })()",
    "(() => { if (false) { return first; } throw new Error('fallback'); })()",
    "(() => { if (projectId) { throw new Error('then'); } else { throw new Error('else'); } })()",
    "(() => { if (decodeURIComponent('%')) return first; return first; })()",
    "(() => { if (projectId) return decodeURIComponent('%'); throw new Error('fallback'); })()",
    "(() => { for (const entry of [first]) { break; } throw new Error('fallback'); })()",
    "(() => { for (const entry of [first]) { return decodeURIComponent('%'); } throw new Error('fallback'); })()",
    "[first].forEach(() => { if (projectId) { throw new Error('then'); } else { throw new Error('else'); } })",
  ])('refuses an initializer with a guaranteed exception: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });
});

/** The authority evaluates this prop-dependent initializer before sending its JSON value. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/conditional-return.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function ConditionalReturn({projectId, first}: {projectId: string; first: string}) {',
      `  const [value, setValue] = useReactiveState<string>(first === '' ? (${expression}, first) : first);`,
      '  return <section><button onClick={() => setValue(first)}>reset</button><TodoCommands projectId={projectId} id={value} /></section>;',
      '}',
    ].join('\n'),
  });
}
