import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Assignment patterns replace source-backed members and constructor parameters before use. */
describe('metadata destructured replacements', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } [helpers.run] = [() => { items[0] = 'changed'; }]; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } ({run: helpers.run} = {run: () => { items[0] = 'changed'; }}); return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } [{run: helpers.run}] = [{run: () => { items[0] = 'changed'; }}]; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } [helpers.run = () => { items[0] = 'changed'; }] = []; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; const alias = helpers; class Fresh { constructor() { try { alias.run(); Object.freeze(this); } catch {} } } [alias.run] = [() => { items[0] = 'changed'; }]; return String(Object.isFrozen(new Fresh()));",
    "function change(value: string[]) { value[0] = 'changed'; } const args = [[] as string[]]; class Fresh { constructor() { try { change.apply(null, args); Object.freeze(this); } catch {} } } [args[0]] = [items]; return String(Object.isFrozen(new Fresh()));",
  ])('refuses a replaced member or parameter that can expose input flags: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'const helpers = {run() {}}; const unrelated = {value: 0}; class Fresh { constructor() { helpers.run(); Object.freeze(this); } } [unrelated.value] = [1]; return String(Object.isFrozen(new Fresh()));',
    "const helpers = {run() {}}; const original = helpers.run; [helpers.run] = [() => { items[0] = 'changed'; }]; class Fresh { constructor() { original(); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { helpers.run(); Object.freeze(this); } } const answer = String(Object.isFrozen(new Fresh())); [helpers.run] = [() => { items[0] = 'changed'; }]; return answer;",
    'class Fresh { constructor(value: string[] = []) { [value] = [[]]; return value; } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor(value: string[] = []) { ({value} = {value: []}); return value; } } return String(Object.isFrozen(new Fresh()));',
  ])('keeps independent writes, captured functions and fresh replacements: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared constructor exposes input-dependent behavior through the metadata of its result. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/destructured-callees.ts': `export function label(items: string[]): string { ${body} }`,
    'components/destructured-callees.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/destructured-callees';",
      'export default function DestructuredCallees({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
