import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A finalizer's reachable return paths can override an earlier synchronous exception. */
describe('branching returns in finally', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'try{decodeURIComponent("%");}finally{if(first)return "a";else return "b";}',
    'try{decodeURIComponent("%");}finally{{if(first){return "a";}else{return "b";}}}',
    'try{decodeURIComponent("%");}finally{if(first)return "a";return "b";}',
    'try{decodeURIComponent("%");}catch{throw new Error("caught");}finally{if(first)return "a";else return "b";}',
    'try{decodeURIComponent("%");}finally{if(first)return "a";}',
    'try{decodeURIComponent("%");}finally{if(true)return first;else throw new Error("unused");}',
    'try{decodeURIComponent("%");}finally{if(false){throw new Error("unused");}else{return first;}}',
    'try{decodeURIComponent("%");}finally{const value=first;return value;}',
  ])('keeps a finalizer that can return normally: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'try{decodeURIComponent("%");}finally{}return first;',
    'try{decodeURIComponent("%");}finally{if(false)return first;}return first;',
    'try{decodeURIComponent("%");}finally{if(first)throw new Error("a");else throw new Error("b");}',
    'try{decodeURIComponent("%");}finally{return decodeURIComponent("%");}',
    'try{decodeURIComponent("%");}finally{if(first)return decodeURIComponent("%");else return decodeURIComponent("%");}',
    'try{decodeURIComponent("%");}finally{if(decodeURIComponent("%"))return "a";else return "b";}',
    'try{decodeURIComponent("%");}finally{for(;;){break;}}return first;',
    'try{decodeURIComponent("%");}finally{decodeURIComponent("%");if(first)return "a";else return "b";}',
  ])('keeps refusing escaping or finalizer exceptions: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});

/** The IIFE starts a local state read by a dynamic child. */
async function fixture(body: string): Promise<Application> {
  return application({
    'components/finally-return.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function FinallyReturn({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>((()=>{${body}})());`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
