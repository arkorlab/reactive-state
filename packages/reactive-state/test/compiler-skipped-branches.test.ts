import { describe, expect, it } from 'vitest';

import { application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-selected loop and conditional branches run the same work as their native expressions. */
describe('known skipped initializer branches', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { accepted: true, expression: "(()=>{while(false){decodeURIComponent('%');}return 'ok';})()" },
    { accepted: true, expression: "(()=>{for(;false;){decodeURIComponent('%');}return 'ok';})()" },
    { accepted: true, expression: "(()=>{for(;false;decodeURIComponent('%')){}return 'ok';})()" },
    { accepted: true, expression: "true?'ok':decodeURIComponent('%')" },
    { accepted: true, expression: "false?decodeURIComponent('%'):'ok'" },
    { accepted: true, expression: "(()=>{while(!1){decodeURIComponent('%');}return 'ok';})()" },
    {
      accepted: false,
      expression: "(()=>{do{decodeURIComponent('%');}while(false);return 'ok';})()",
    },
    { accepted: false, expression: "(()=>{while(true){decodeURIComponent('%');}return 'ok';})()" },
    { accepted: false, expression: "(()=>{for(decodeURIComponent('%');false;){}return 'ok';})()" },
    { accepted: false, expression: "true?decodeURIComponent('%'):'ok'" },
    { accepted: false, expression: "false?'ok':decodeURIComponent('%')" },
    {
      accepted: false,
      expression: "(()=>{while((decodeURIComponent('%'),false)){}return 'ok';})()",
    },
  ])(
    'matches native selection, accepted=$accepted: $expression',
    async ({ accepted, expression }) => {
      const app = await application({
        'components/skipped-branches.reactive.tsx': [
          "import {useReactiveState} from 'framework/react';",
          "import TodoCommands from '@/components/todo-commands.reactive';",
          'export default function SkippedBranches({projectId,first}:{projectId:string;first:string}){',
          `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
          'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
        ].join('\n'),
      });
      apps.push(app);
      const native = node(
        `try{const answer=(${expression});console.log(JSON.stringify({value:answer}));}catch(error){console.log(JSON.stringify({error:error.name}));}`,
        app.root,
      );

      const refusals = compile(app).refusals.map((refusal) => refusal.reason);
      const expectedNative = accepted ? { value: 'ok' } : { error: 'URIError' };
      const unsafe = expect.stringContaining('no JSON holds');
      const expectedRefusals = accepted ? [] : [unsafe];

      expect(native.status).toBe(0);
      expect(JSON.parse(native.stdout)).toStrictEqual(expectedNative);
      expect(refusals).toStrictEqual(expectedRefusals);
    },
  );
});
