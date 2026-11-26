import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Discarded falsy operands do not become the JSON result of a logical fallback. */
describe('discarded falsy logical JSON operands', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "NaN||'ok'",
    "0n||'ok'",
    "-0n||'ok'",
    "(0/0)||'ok'",
    "(()=>{const absent=NaN;return absent||'ok';})()",
    "(()=>{const zero=0x0n;return zero||'ok';})()",
    "0||'ok'",
    "null??'ok'",
    "'ok'||NaN",
    "(+new Date('bad'))||'ok'",
    "(()=>{const NaN='kept';return NaN||'ok';})()",
  ])('accepts a JSON fallback instead of its discarded left value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "1n||'ok'",
    "NaN??'ok'",
    "0n??'ok'",
    "0n&&'ok'",
    'NaN||(undefined as never)',
    "(decodeURIComponent('%'),NaN)||'ok'",
    "(+0n)||'ok'",
    'first||NaN',
    "new Date('bad')||'ok'",
  ])('refuses selected non-JSON values and evaluated exceptions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** The prop-dependent outer branch keeps the selected result authority-evaluated. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/json-falsy-branches.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function JsonFalsyBranches({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression}) as never:first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
