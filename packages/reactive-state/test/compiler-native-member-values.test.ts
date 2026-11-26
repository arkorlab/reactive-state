import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, type Application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite native constants remain JSON; a native method reference remains a function. */
describe('native members in JSON entry contexts', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: '{held:Object.keys({first}).map}' },
    { expression: '{held:Object.entries({first}).slice}' },
    { expression: '{held:Object.values({first}).filter}' },
    { expression: '{held:String(first).trim}' },
    { declaration: 'const math=Math;', expression: '{held:math.PI.toFixed}' },
    { declaration: 'const math=Math;const pi=math.PI;', expression: '{held:pi.toFixed}' },
    { declaration: 'const numeric=Number;', expression: '{held:numeric.EPSILON.toPrecision}' },
    { declaration: 'const pi=Math.PI;', expression: '{held:pi.toFixed}' },
  ])('refuses a known native function held by $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);

    const executed = node(nativeScript(row), app.root);

    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toStrictEqual({ carried: false, type: 'function' });
  });

  it.each([
    { expression: '{held:Float64Array.BYTES_PER_ELEMENT}' },
    { expression: '{held:Uint8ClampedArray.BYTES_PER_ELEMENT}' },
    { expression: '{held:globalThis.BigInt64Array.BYTES_PER_ELEMENT}' },
    { expression: '{held:Float32Array["BYTES_PER_ELEMENT"]}' },
    { declaration: 'const Words=Uint16Array;', expression: '{held:Words.BYTES_PER_ELEMENT}' },
    { declaration: 'const math=Math;', expression: '{held:math.PI}' },
    { expression: '{held:Object.keys({first}).length}' },
    { expression: '{held:Object.keys({first})[0]}' },
    { expression: '{held:(Object.keys({first}) as unknown as {absent?:string}).absent}' },
    { declaration: 'const pi=Math.PI;', expression: '{held:pi.toFixed(2)}' },
    {
      declaration: 'const Float64Array={BYTES_PER_ELEMENT:3};',
      expression: '{held:Float64Array.BYTES_PER_ELEMENT}',
    },
    {
      declaration: 'const Object={keys(_value:unknown){return {map:first};}};',
      expression: '{held:Object.keys({first}).map}',
    },
    {
      expression:
        '(()=>{const original=Object.keys;try{Object.keys=((_value:unknown)=>({map:first})) as never;return{held:Object.keys({first}).map};}finally{Object.keys=original;}})()',
    },
  ])('keeps a finite constant or JSON member in $expression', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);
    const executed = node(
      nativeScript(row, `${app.out}/components/native-members.authority.mts`),
      app.root,
    );

    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toStrictEqual({ carried: true, same: true });
  });
});

interface MemberCase {
  readonly declaration?: string;
  readonly expression: string;
}

/** A native source result and the real generated authority meet the same runtime JSON boundary. */
function nativeScript(row: MemberCase, authority?: string): string {
  const reference = `function reference(first:string){${row.declaration ?? ''};return(${row.expression});}`;
  return [
    "import {stripTypeScriptTypes} from 'node:module';",
    `import {toJson} from ${JSON.stringify(new URL('../src/runtime/json.ts', import.meta.url).href)};`,
    `const reference=new Function(stripTypeScriptTypes(${JSON.stringify(reference)})+';return reference;')();`,
    "const expected=reference('');",
    'let carried=true;try{toJson(expected);}catch{carried=false;}',
    authority === undefined
      ? 'console.log(JSON.stringify({carried,type:typeof expected.held}));'
      : [
          `const program=await import(${JSON.stringify(authority)});`,
          "const actual=program.evaluate({projectId:'p',first:''},{client:part=>part}).states.selected;",
          'console.log(JSON.stringify({carried,same:JSON.stringify(toJson(actual))===JSON.stringify(expected)}));',
        ].join('\n'),
  ].join('\n');
}

/** The object state is used by a dynamic child, so its entries receive the authority JSON check. */
async function fixture(row: MemberCase): Promise<Application> {
  return application({
    'components/native-members.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function NativeMembers({projectId,first}:{projectId:string;first:string}){',
      row.declaration ?? '',
      `const [selected,setSelected]=useReactiveState<{held?:string|number}>(first===''?(${row.expression} as unknown as {held?:string|number}):{held:first});`,
      'return<section><button onClick={()=>setSelected({held:first})}>reset</button><TodoCommands projectId={projectId} id={selected as string}/></section>;}',
    ].join('\n'),
  });
}
