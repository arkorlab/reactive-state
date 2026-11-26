import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { writeOutputs } from '../src/compiler/index.ts';
import { application, node } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Hook binding restrictions and the extracted function values the authority must retain. */
describe('values retained by generated bindings', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    ['object', true],
    ['object', false],
    ['array', true],
    ['array', false],
  ] as const)(
    'refuses a dynamic read of a whole %s hook result, also kept by the browser: %s',
    async (shape, kept) => {
      const app = await application(hooked(shape, kept));
      apps.push(app);
      const compiled = compile(app);

      expect(compiled.refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('destructure the items it reads'),
      ]);
    },
  );

  it.each([
    ['formatter.format', 'format()', 'live'],
    ["formatter['format']", 'format()', 'live'],
    ['formatter.format', '(format)()', 'live'],
    ['formatter.format', '(format as () => string)()', 'live'],
    ['formatter.format', 'format!()', 'live'],
    ['formatter.format; const alias = format', 'alias()', 'live'],
    ['formatter.format', 'format() + format()', 'livelive'],
    ['formatter.format', 'formatter.format()', 'bound'],
  ])('preserves the receiver of %s read as %s', async (member, call, expected) => {
    const app = await application(extracted(member, call));
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components/extracted.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        'const $ = { client: (part) => part, counted, method, h: (type, props) => ({ type, props }) };',
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        "const rendered = withinSteps(() => d0.render({ text: 'live' }));",
        'process.stdout.write(JSON.stringify(rendered.props.id));',
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toBe(expected);
  });
});

/** A whole hook binding with a derived item that requires injecting its underlying local state. */
function hooked(shape: 'array' | 'object', kept: boolean): Readonly<Record<string, string>> {
  const shown = shape === 'object' ? 'result.shown' : 'result[0]';
  const setter = shape === 'object' ? 'result.setLocation' : 'result[2]';
  const handler = kept ? `<button onClick={() => ${setter}('next')}>next</button>` : '';
  return {
    'hooks/use-location.ts': [
      "import { useReactiveState } from 'framework/react';",
      'export function useLocation(first: string) {',
      '  const [location, setLocation] = useReactiveState(first);',
      "  const shown = location + '!';",
      `  return ${shape === 'object' ? '{ shown, location, setLocation }' : '[shown, location, setLocation] as const'};`,
      '}',
    ].join('\n'),
    'components/whole.reactive.tsx': [
      "import { useLocation } from '@/hooks/use-location';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function Whole({ projectId, first }: { projectId: string; first: string }) {',
      '  const result = useLocation(first);',
      `  return <section>${handler}<TodoCommands projectId={String(projectId)} id={${shown}} /></section>;`,
      '}',
    ].join('\n'),
  };
}

/** A shared receiver-sensitive method extracted into a component's constant before it is called. */
function extracted(member: string, call: string): Readonly<Record<string, string>> {
  return {
    'domain/formatter.ts':
      'export function makeFormatter(value: string) { return { format() { return this === undefined ? value : "bound"; } }; }\n',
    'components/extracted.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import { makeFormatter } from '@/domain/formatter';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function Extracted({ projectId }: { projectId: string }) {',
      "  const [text, setText] = useReactiveState('first');",
      '  const formatter = makeFormatter(text);',
      `  const format = ${member};`,
      `  return <section><button onClick={() => setText('next')}>next</button><TodoCommands projectId={String(projectId)} id={${call}} /></section>;`,
      '}',
    ].join('\n'),
  };
}
