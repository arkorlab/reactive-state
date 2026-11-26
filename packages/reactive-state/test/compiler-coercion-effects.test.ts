import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Earlier operand conversion can install the hook a later conversion reads. */
describe('effects of earlier operand conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '+{valueOf(){(Object.prototype as any)[Symbol.toPrimitive]=()=>1;return 0;}}',
    '(1*{valueOf(){(Object.prototype as any)[Symbol.toPrimitive]=()=>1;return 0;}})',
    `\`\${{toString(){(Object.prototype as any)[Symbol.toPrimitive]=()=>1;return "0";}}}\``,
  ])('keeps a left conversion repaired by its evaluated right operand: %s', async (right) => {
    const expression = `(()=>{try{return ({toString(){throw new Error("unused");}} as any) + ${right};}finally{delete (Object.prototype as any)[Symbol.toPrimitive];}})()`;
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each(['+1', '(1+1)', `\`\${1}\``])(
    'still refuses the throwing left conversion beside primitive-only work: %s',
    async (right) => {
      const expression = `({toString(){throw new Error("called");}} as any) + ${right}`;
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
        expect.stringContaining('no JSON holds'),
      ]);
    },
  );
});

/** The authority evaluates the prop-dependent initializer before its site reads the result. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/coercion-effects.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function CoercionEffects({projectId,first}:{projectId:string;first:string}){',
      `const [value,setValue]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return<section><button onClick={()=>setValue(first)}>reset</button><TodoCommands projectId={projectId} id={value}/></section>;}',
    ].join('\n'),
  });
}
