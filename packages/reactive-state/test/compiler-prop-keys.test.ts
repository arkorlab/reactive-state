import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, node, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Browser props retain their own names through generated authority evaluation and JSON. */
describe('written browser prop keys', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { property: '__proto__', local: 'label', type: 'string', value: 'sent' },
    { property: '__proto__', local: 'label', type: '{ text: string }', value: { text: 'sent' } },
    { property: 'title', local: 'title', type: 'string', value: 'sent' },
    { property: 'title', local: 'label', type: 'string', value: 'sent' },
    { property: 'constructor', local: 'label', type: 'string', value: 'sent' },
    { property: 'toString', local: 'label', type: 'string', value: 'sent' },
  ])('preserves the own browser prop $property as $local: $type', async (row) => {
    const binding = row.property === row.local ? row.local : `${row.property}:${row.local}`;
    const source = [
      "import {useReactiveState} from 'framework/react';",
      `export default function PropKeys({${binding}}:{${row.property}:${row.type}}){`,
      `  const [draft,setDraft]=useReactiveState(${row.local});`,
      `  return <section><button onClick={()=>setDraft(${row.local})}>reset</button>{String(${row.local})}{String(draft)}</section>;`,
      '}',
    ].join('\n');
    const app = await application({ 'components/prop-keys.reactive.tsx': source });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    const client = output(compiled, app, 'components/prop-keys.client.tsx');
    writeOutputs(compiled.outputs, app.out);
    const props = { [row.property]: row.value };
    const authority = `${app.out}/components/prop-keys.authority.mts`;
    const executed = node(
      [
        "import {stripTypeScriptTypes} from 'node:module';",
        `import {frozenJson} from ${JSON.stringify(new URL('../src/authority/canonical.ts', import.meta.url).href)};`,
        `import {localOf} from ${JSON.stringify(new URL('../src/react/state.ts', import.meta.url).href)};`,
        `const program=await import(${JSON.stringify(authority)});`,
        `const props=JSON.parse(${JSON.stringify(JSON.stringify(props))});`,
        'const evaluated=program.evaluate(props,{client:part=>part});',
        'const sent=frozenJson(evaluated.props);',
        `const source=${JSON.stringify(prefixOf(source, row.local))};`,
        `const client=${JSON.stringify(prefixOf(client, row.local))};`,
        'function run(text,props){',
        "  const make=new Function('useReactiveState','localOf',stripTypeScriptTypes(text).replace('export default ','return '));",
        '  return make(value=>[value,()=>{}],localOf)(props);',
        '}',
        'const part={props:sent,states:{draft:{value:evaluated.states.draft}}};',
        `const key=${JSON.stringify(row.property)};`,
        'console.log(JSON.stringify({own:Object.hasOwn(sent,key),source:run(source,props),client:run(client,{part})}));',
      ].join('\n'),
      app.root,
    );

    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toStrictEqual({
      own: true,
      source: row.value,
      client: row.value,
    });
  });
});

/** The actual source/client prefix through all its bindings, replacing only its returned JSX. */
function prefixOf(source: string, value: string): string {
  const start = source.indexOf('export default function');
  const end = source.lastIndexOf('\n  return ');
  if (start === -1 || end < start) {
    throw new Error('A component has no function body before its returned JSX.');
  }
  return `${source.slice(start, end)}\n  return ${value};\n}`;
}
