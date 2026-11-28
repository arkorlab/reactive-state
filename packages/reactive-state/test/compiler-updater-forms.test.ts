import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * Two updates of one state that differ only in an instantiation expression or a class's `extends`
 * compute different values, so each has an id of its own, and the authority runs each call's own.
 */
describe('updates told apart by an expression TypeScript counts among the types', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'instantiation',
      domain:
        'export function grow<T extends number>(value:T,by:number):number{return value+by;}export function shrink<T extends number>(value:T,by:number):number{return value-by;}',
      imported: 'grow,shrink',
      first: 'current=>(grow<number>)(current,step)',
      second: 'current=>(shrink<number>)(current,step)',
      expected: [8, 2],
    },
    {
      id: 'heritage',
      domain: 'export class Grow{by=1}export class Shrink{by=-1}',
      imported: 'Grow,Shrink',
      first: 'current=>current+new (class extends Grow{})().by',
      second: 'current=>current+new (class extends Shrink{})().by',
      expected: [6, 4],
    },
  ])('$id', async ({ domain, imported, first, second, expected }) => {
    const app = await application({
      'domain/update-forms.ts': domain,
      'components/update-forms.reactive.tsx': [
        "import {useReactiveState} from 'framework/react';",
        "import {db} from '@/db';",
        `import {${imported}} from '@/domain/update-forms';`,
        'export default function UpdateForms({id,step}:{id:string;step:number}){',
        'const [estimate,setEstimate]=useReactiveState(db.todos.ref(id).estimate);',
        `return<div><button onClick={()=>setEstimate(${first})}>first</button>`,
        `<button onClick={()=>setEstimate(${second})}>second</button>`,
        '{estimate}</div>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);
    const client = readFileSync(`${app.out}/components/update-forms.client.tsx`, 'utf8');
    // Each button's call, as the browser sends it: the id it names the update by.
    const ids = [...client.matchAll(/setEstimate\.compiled\("(u_\w+)"/gu)].map((match) => match[1]);

    expect(ids).toHaveLength(2);

    const authority = `${app.out}/components/update-forms.authority.mts`;
    const executed = node(
      [
        "const {registerPaths}=await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const program=await import(${JSON.stringify(authority)});`,
        `const ids=${JSON.stringify(ids)};`,
        'console.log(JSON.stringify(ids.map((id)=>program.updaters[id].apply(5,{step:3}))));',
      ].join('\n'),
      app.root,
    );

    expect(executed.stderr).toBe('');
    // What the authority computes for each button's write: that button's own update, which one id
    // for both would make the first's.
    expect(JSON.parse(executed.stdout)).toStrictEqual(expected);
    expect(new Set(ids).size).toBe(2);
  });
});
