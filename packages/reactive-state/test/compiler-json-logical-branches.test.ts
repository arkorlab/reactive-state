import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** JSON shape reads only values that can be selected by a written logical operation. */
describe('selected logical JSON values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "'ok'||(undefined as never)",
    "false&&Symbol('unused')",
    '0&&new Date(0)',
    "''&&(()=>0)",
    "'ok'??(1n as never)",
    '1??(()=>0)',
    "!true&&Symbol('unused')",
    '-0&&(undefined as never)',
    "(()=>{const chosen='ok';return chosen||new Date(0);})()",
    'false??(undefined as never)',
    "undefined||'ok'",
    "true&&'ok'",
    "null??'ok'",
  ])('accepts a JSON value while its logical alternative is skipped: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'true&&(undefined as never)',
    "''||(undefined as never)",
    'null??(undefined as never)',
    "(decodeURIComponent('%'),'ok')||(undefined as never)",
    'first||(undefined as never)',
  ])('refuses selected non-JSON and errors before selection: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([
      expect.objectContaining({ reason: expect.stringContaining('no JSON holds') }),
    ]);
  });
});

/** A prop-dependent outer branch keeps the initial value authority-evaluated. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/json-logical.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function JsonLogical({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression}) as never:first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
