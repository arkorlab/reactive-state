import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Binding initialization applies its pattern even when the resulting value is discarded. */
describe('written destructuring failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const {selected}=null as never;return selected;})()',
    '(()=>{const {selected}=undefined as never;return selected;})()',
    '(()=>{const {}=null as never;return 0;})()',
    '(()=>{const []=1 as never;return 0;})()',
    '(()=>{const [selected]=false as never;return selected;})()',
    '(()=>{const []={} as never;return 0;})()',
    '(()=>{const []=Symbol() as never;return 0;})()',
    '(()=>{const absent=null;const {selected}=absent as never;return selected;})()',
    '(()=>{function read(){const {selected}=null as never;return selected;}return read();})()',
    '[first].map(()=>{const {selected}=null as never;return selected;})',
    'Object.values({get selected(){const {}=null as never;return 0;}})',
  ])('refuses a written invalid binding source: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const {}=0;return 0;})()',
    '(()=>{const {}=false;return 0;})()',
    '(()=>{const {}=1n;return 0;})()',
    '(()=>{const {}=Symbol();return 0;})()',
    '(()=>{const {length}=first;return length;})()',
    '(()=>{const [selected]="x";return selected;})()',
    '(()=>{const []=[];return 0;})()',
    '(()=>{try{const {}=null as never;}catch{}return 0;})()',
    '(()=>{if(false){const {}=null as never;}return 0;})()',
    '(()=>{const read=()=>{const {}=null as never;};void read;return 0;})()',
    '(async()=>{const {}=null as never;})()',
    '(function*(){const {}=null as never;})()',
    '(()=>{return 0;const {}=null as never;})()',
    '(()=>{try{const {}=null as never;}finally{return 0;}})()',
    '(()=>{let input:unknown=null;input={};const {}=input as never;return 0;})()',
  ])('keeps valid, unknown, caught and deferred bindings: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** The prop read makes the authority evaluate the initializer rather than retaining client work. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/destructuring-throws.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function DestructuringThrows({projectId,first}:{projectId:string;first:string}){',
      `const [value,setValue]=useReactiveState<string>(first===''?(${expression},'ok'):first);`,
      'return <section><button onClick={()=>setValue(first)}>reset</button><TodoCommands projectId={projectId} id={value}/></section>;',
      '}',
    ].join('\n'),
  });
}
