import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source member values must survive until the deferred function actually reads them. */
describe('metadata deferred callee order', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } const helpers = {run() {}}; helpers.run = () => { items[0] = 'changed'; }; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } helpers.run = () => { items[0] = 'changed'; }; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; const alias = helpers; class Fresh { constructor() { try { alias.run(); Object.freeze(this); } catch {} } } alias.run = () => { items[0] = 'changed'; }; return String(Object.isFrozen(new Fresh()));",
    "function change(value: string[]) { value[0] = 'changed'; } const args = [[] as string[]]; class Fresh { constructor() { try { change.apply(null, args); Object.freeze(this); } catch {} } } args[0] = items; return String(Object.isFrozen(new Fresh()));",
    "const helpers = {run() {}}; class Fresh { constructor() { try { helpers.run(); Object.freeze(this); } catch {} } } const first = String(Object.isFrozen(new Fresh())); helpers.run = () => { items[0] = 'changed'; }; return first + String(Object.isFrozen(new Fresh()));",
  ])('refuses a deferred read after a source-written replacement: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'class Fresh { constructor() { helpers.run(); Object.freeze(this); } } const helpers = {run() {}}; return String(Object.isFrozen(new Fresh()));',
    "const helpers = {run() {}}; const original = helpers.run; helpers.run = () => { items[0] = 'changed'; }; class Fresh { constructor() { original(); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    'function read(value: string[]) { return value.length; } const args = [[] as string[]]; class Fresh { constructor() { read.apply(null, args); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    "const helpers = {run() {}}; class Fresh { constructor() { helpers.run(); Object.freeze(this); } } const answer = String(Object.isFrozen(new Fresh())); helpers.run = () => { items[0] = 'changed'; }; return answer;",
  ])('keeps unchanged members and functions captured before replacement: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** An authority-rendered child uses a shared helper whose constructor reads mutable members. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/callee-order.ts': `export function label(items: string[]): string { ${body} }`,
    'components/callee-order.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/callee-order';",
      'export default function CalleeOrder({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
