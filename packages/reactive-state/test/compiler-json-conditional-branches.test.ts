import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** JSON classification follows a written selector without evaluating the unselected arm. */
describe('selected conditional JSON values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "true ? 'ok' : (undefined as never)",
    "false ? (undefined as never) : 'ok'",
    "true ? 'ok' : (() => 1)",
    "false ? Symbol('unused') : 'ok'",
    "true ? 'ok' : new Date()",
    "false ? (1n as never) : 'ok'",
    "true ? 'ok' : NaN",
    "false ? Infinity : 'ok'",
    "!false ? 'ok' : (undefined as never)",
    "!true ? (undefined as never) : 'ok'",
    "1 ? 'ok' : (undefined as never)",
    "0 ? (undefined as never) : 'ok'",
    "'' ? (undefined as never) : 'ok'",
    "'written' ? 'ok' : (undefined as never)",
    "true ? (false ? (undefined as never) : 'ok') : (undefined as never)",
    "(() => { const chosen = true; return chosen ? 'ok' : (undefined as never); })()",
  ])('accepts a source-selected JSON arm: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "true ? (undefined as never) : 'ok'",
    "false ? 'ok' : (undefined as never)",
    "true ? NaN : 'ok'",
    "false ? 'ok' : Symbol('selected')",
    "first === 'unknown' ? 'ok' : (undefined as never)",
    "first === 'unknown' ? (undefined as never) : 'ok'",
    "(() => { let chosen = true; chosen = false; return chosen ? 'ok' : (undefined as never); })()",
    "(() => { const chosen = { value: true }; chosen.value = false; return chosen.value ? 'ok' : (undefined as never); })()",
  ])('refuses selected or possibly selected non-JSON: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([
      expect.objectContaining({ reason: expect.stringContaining('no JSON holds') }),
    ]);
  });
});

/** A first prop keeps the state authority-started while the inner selector is examined. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/json-conditional.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function JsonConditional({projectId,first}:{projectId:string;first:string}) {',
      `const [selected,setSelected]=useReactiveState<string>(first === '' ? (${expression}) : first);`,
      'return <section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;',
      '}',
    ].join('\n'),
  });
}
