import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** An unused generated current-value parameter never shadows the updater's own names. */
describe('written updater parameter names', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { captures: { _current: 5 }, expression: '()=>_current', expected: 5, imported: false },
    {
      captures: { _current: 1, _current$2: 2, _current$3: 3 },
      expression: '()=>_current+_current$2+_current$3',
      expected: 6,
      imported: false,
    },
    { captures: {}, expression: '()=>_current', expected: 5, imported: true },
    {
      captures: { _current: 5 },
      expression: '()=>{const _current$2=1;return _current+_current$2;}',
      expected: 6,
      imported: false,
    },
    { captures: {}, expression: '()=>5', expected: 5, imported: false },
    { captures: { step: 3 }, expression: '()=>step', expected: 3, imported: false },
    {
      captures: { step: 3 },
      expression: '(current)=>current+step',
      expected: 5,
      imported: false,
    },
    {
      captures: { step: 3 },
      expression: '(_current)=>_current+step',
      expected: 5,
      imported: false,
    },
  ])('keeps the native updater result: $expression', async (row) => {
    const names = Object.keys(row.captures);
    const props = ['id', ...names].join(',');
    const types = ['id:string', ...names.map((name) => `${name}:number`)].join(';');
    const app = await application({
      'domain/updater-parameter.ts': 'export const _current=5;',
      'components/updater-parameter.reactive.tsx': [
        "import {useReactiveState} from 'framework/react';",
        "import {db} from '@/db';",
        ...(row.imported ? ["import {_current} from '@/domain/updater-parameter';"] : []),
        `export default function UpdaterParameter({${props}}:{${types}}){`,
        'const [estimate,setEstimate]=useReactiveState(db.todos.ref(id).estimate);',
        `return<button onClick={()=>setEstimate(${row.expression})}>`,
        '{estimate}</button>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);
    const authority = `${app.out}/components/updater-parameter.authority.mts`;
    const bindings = { ...row.captures, ...(row.imported && { _current: 5 }) };
    const predicted = `return (${row.expression});`;
    const executed = node(
      [
        "const {registerPaths}=await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const program=await import(${JSON.stringify(authority)});`,
        `const captures=${JSON.stringify(row.captures)};`,
        `const bindings=${JSON.stringify(bindings)};`,
        `const make=new Function(...Object.keys(bindings),${JSON.stringify(predicted)});`,
        'const source=make(...Object.values(bindings))(2);',
        'const updater=Object.values(program.updaters).find(each=>each.kind==="apply");',
        'console.log(JSON.stringify({source,authority:updater.apply(2,captures)}));',
      ].join('\n'),
      app.root,
    );

    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toStrictEqual({
      source: row.expected,
      authority: row.expected,
    });
  });
});
