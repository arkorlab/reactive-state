import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** An initial component import retains its binding without taking a derived callback's name. */
describe('initial imports beside derived declarations', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { imported: 'x', parameter: 'x' },
    { imported: 'normalize', parameter: 'normalize' },
    { imported: 'normalize', parameter: 'x' },
    { imported: 'x', parameter: 'entry' },
  ])('executes the same helper with $imported beside $parameter', async (row) => {
    const app = await application({
      'domain/initial-import.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'export function normalize(value:string):TodoFilter{',
        "return value==='active'||value==='done'?value:'all';",
        '}',
      ].join('\n'),
      'hooks/use-initial-import.ts': [
        "import {useReactiveState} from 'framework/react';",
        "import type {TodoFilter} from '@/navigation';",
        "import {normalize as helper} from '@/domain/initial-import';",
        'export function useFilter(initial:TodoFilter){',
        'const [filter,setFilter]=useReactiveState<TodoFilter>(initial);',
        `const shown=[filter].map((${row.parameter})=>helper(${row.parameter}))[0];`,
        'return {filter,setFilter,shown};',
        '}',
      ].join('\n'),
      'components/initial-import.reactive.tsx': [
        "import TodoResults from '@/components/todo-results.reactive';",
        "import type {TodoFilter} from '@/navigation';",
        `import {normalize as ${row.imported}} from '@/domain/initial-import';`,
        "import {useFilter} from '@/hooks/use-initial-import';",
        'export default function InitialImport({projectId,initialFilter}:{projectId:string;initialFilter:TodoFilter}){',
        `const initial=${row.imported}(initialFilter);`,
        'const {filter,setFilter,shown}=useFilter(initial);',
        "return <section><button onClick={()=>setFilter('done')}>{filter}</button>",
        '<TodoResults projectId={projectId} filter={shown}/></section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);
    const authority = `${app.out}/components/initial-import.authority.mts`;
    const shared = `${app.src}/domain/initial-import.ts`;
    const executed = node(
      [
        "const {registerPaths}=await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const program=await import(${JSON.stringify(authority)});`,
        `const {normalize}=await import(${JSON.stringify(shared)});`,
        'const $={client:part=>part,counted:value=>value,method:(receiver,key)=>(...args)=>Reflect.apply(receiver[key],receiver,args),h:(type,props,...children)=>({type,props,children})};',
        "const {d0}=program.evaluate({projectId:'p1',initialFilter:'all'},$).sites;",
        "const inputs=['done','bogus','active'];",
        'const source=inputs.map(value=>[value].map(entry=>normalize(entry))[0]);',
        'const authority=inputs.map(value=>d0.render({"useFilter#0.filter":value}).props.filter);',
        'console.log(JSON.stringify({source,authority}));',
      ].join('\n'),
      app.root,
    );

    expect(executed.stderr).toBe('');
    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toStrictEqual({
      source: ['done', 'all', 'active'],
      authority: ['done', 'all', 'active'],
    });
  });
});
