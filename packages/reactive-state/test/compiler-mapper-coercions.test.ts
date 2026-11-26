import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source element conversions run before a native factory invokes its mapper. */
describe('factory source conversion effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '+{valueOf(){globalThis.decodeURIComponent=()=>"ok";return 0;}}',
    '(1*{valueOf(){globalThis.decodeURIComponent=()=>"ok";return 0;}})',
    `\`\${{toString(){globalThis.decodeURIComponent=()=>"ok";return "0";}}}\``,
  ])('keeps a mapper repaired while its source is created: %s', async (entry) => {
    const app = await fixture(entry);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each(['+1', '(1+1)', `\`\${1}\``])(
    'still refuses a throwing mapper after primitive-only source work: %s',
    async (entry) => {
      const app = await fixture(entry);
      apps.push(app);

      expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('no JSON holds'),
      ]);
    },
  );
});

/** The selected prop branch creates the source before calling the mapper, then restores the global. */
async function fixture(entry: string): Promise<Application> {
  const expression = `(()=>{const original=decodeURIComponent;try{return Array.from([${entry}],()=>decodeURIComponent('%'));}finally{globalThis.decodeURIComponent=original;}})()`;
  return application({
    'components/mapper-coercions.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function MapperCoercions({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
