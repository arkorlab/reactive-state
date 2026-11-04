import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Shared-module binding identity controls date text and caught exception observations. */
describe('shared module framed lexical bindings', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'function stamp(date: Date) { var date; return String(date); } export function label(value: string) { return value + stamp(new Date(0)); }',
    `function stamp(date: Date) { { var date; } return \`\${date}\`; } export function label(value: string) { return value + stamp(new Date(0)); }`,
    'function stamp(date: Date) { var date; const alias = date; return String(alias); } export function label(value: string) { return value + stamp(new Date(0)); }',
    "function frames(error: Error) { var error; return error.stack ?? ''; } export function label(value: string) { return value + frames(new Error('fixed')); }",
    'export function label(value: string) { try { JSON.parse(value); } catch (error) { return (error as Error).message; } return value; }',
    'export function label(value: string) { try { JSON.parse(value); } catch (error) { return (() => (error as Error).message)(); } return value; }',
  ])(
    'refuses true date or exception bindings across empty var declarations: %s',
    async (source) => {
      const app = await fixture(source);
      apps.push(app);

      expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('a shared module that answers otherwise'),
      ]);
    },
  );

  it.each([
    "export function label(value: string) { try { JSON.parse(value); } catch (error) { return [{message: value}].map((error) => error.message).join(''); } return value; }",
    'export function label(value: string) { try { JSON.parse(value); } catch (error) { function read(error: {message: string}) { return error.message; } return read({message: value}); } return value; }',
    'export function label(value: string) { try { JSON.parse(value); } catch (error) { { const error = {message: value}; return error.message; } } return value; }',
    'export function label(value: string) { try { JSON.parse(value); } catch (error) { function read() { var error = {message: value}; return error.message; } return read(); } return value; }',
    'function stamp(date: Date) { var date; return date.toISOString(); } export function label(value: string) { return value + stamp(new Date(0)); }',
    "function stamp(date: Date | string) { var date = 'fixed'; return String(date); } export function label(value: string) { return value + stamp(new Date(0)); }",
    'function stamp(date: Date) { function read() { let date; return String(date); } return read(); } export function label(value: string) { return value + stamp(new Date(0)); }',
    'function stamp(date: Date) { function read() { var date; return String(date); } return read(); } export function label(value: string) { return value + stamp(new Date(0)); }',
  ])('keeps lexical shadows and explicit stable text: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared helper used by a dynamic site's child prop. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/framed-scopes.ts': source,
    'components/framed-scopes.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/framed-scopes';",
      'export default function FramedScopes({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
