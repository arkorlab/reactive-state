import { describe, expect, it } from 'vitest';

import { application, node, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Initializers before guarded sites retain the source component's eager exceptions. */
describe('eager browser constants', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { declaration: 'const label = helper(filter);', expected: 'eager failure' },
    {
      declaration: 'const original = helper(filter); const label = original;',
      expected: 'eager failure',
    },
    {
      declaration: "const label = filter === 'bad' ? helper(filter) : filter;",
      expected: 'eager failure',
    },
    {
      declaration: "const label = filter === 'bad' ? filter : helper(filter);",
      expected: 'no exception',
    },
    { declaration: 'const label = filter;', expected: 'no exception' },
    {
      declaration: 'const holder = { value: filter }; const label = holder.value;',
      expected: 'no exception',
    },
    { declaration: "const label = [filter].join('');", expected: 'no exception' },
  ])(
    'preserves evaluation before a closed site: $declaration',
    async ({ declaration, expected }) => {
      const source = component(declaration);
      const app = await application({
        'components/eager.reactive.tsx': source,
        'domain/eager.ts': [
          'export function helper(value: string): string {',
          "  if (value === 'bad') { throw new Error('eager failure'); }",
          '  return value.trim();',
          '}',
        ].join('\n'),
      });
      apps.push(app);
      const compiled = compile(app);

      expect(compiled.refusals).toStrictEqual([]);

      const client = output(compiled, app, 'components/eager.client.tsx');
      const executed = node(execution(prefixOf(source), prefixOf(client)), app.root);

      expect(executed.status).toBe(0);
      expect(JSON.parse(executed.stdout)).toStrictEqual({
        client: expected,
        source: expected,
      });
    },
  );
});

/** A prop-dependent state makes the guarded child a dynamic site. */
function component(declaration: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    "import TodoCommands from '@/components/todo-commands.reactive';",
    "import { helper } from '@/domain/eager';",
    'export default function Eager({ projectId, first, gate }: { projectId: string; first: string; gate: boolean }) {',
    '  const [filter, setFilter] = useReactiveState(first);',
    `  ${declaration}`,
    '  return <section><button onClick={() => setFilter(first)}>reset</button>{gate && <TodoCommands projectId={projectId} id={label} />}</section>;',
    '}',
  ].join('\n');
}

/** The actual component's execution before its returned JSX, with its source order intact. */
function prefixOf(source: string): string {
  const start = source.indexOf('export default function');
  const end = source.lastIndexOf('\n  return');
  if (start === -1 || end < start) {
    throw new Error('A component has no function body before its returned JSX.');
  }
  return `${source.slice(start, end)}\n}`;
}

/** Runs both real prefixes with equivalent framework values and the same throwing helper. */
function execution(source: string, client: string): string {
  return [
    "import { stripTypeScriptTypes } from 'node:module';",
    `const source = ${JSON.stringify(source)};`,
    `const client = ${JSON.stringify(client)};`,
    'function execute(text, props) {',
    "  const body = stripTypeScriptTypes(text).replace('export default ', 'return ');",
    "  const make = new Function('useReactiveState', 'localOf', 'stateOf', 'useSites', 'helper', body);",
    "  const state = () => 'bad';",
    '  const component = make((value) => [value, () => {}], state, state, () => ({}), (value) => {',
    "    if (value === 'bad') { throw new Error('eager failure'); }",
    '    return value.trim();',
    '  });',
    "  try { component(props); return 'no exception'; } catch (error) { return error.message; }",
    '}',
    "const props = { projectId: 'p', first: 'bad', gate: false };",
    'console.log(JSON.stringify({ source: execute(source, props), client: execute(client, { part: { props } }) }));',
  ].join('\n');
}
