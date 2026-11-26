import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A receiver kept by its module remains retained through local aliases of this. */
describe('shared retained this aliases', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'const counter = {n: 0, bump() { const self = this; return ++self.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; const alias = self; return ++alias.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { const self = this; return ++self.n; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { box = {n: 0}; bump() { const {box} = this; return ++box.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { box = {n: 0}; bump() { const {box: alias} = this; return ++alias.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { items = [{n: 0}]; bump() { const [box] = this.items; return ++box!.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { box = {n: 0}; bump() { const self = this; const {box} = self; return ++box.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; add() { return ++this.n; } bump() { const self = this; return self.add(); } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; return ++self["n"]; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; Object.assign(self, {n: self.n + 1}); return self.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
  ])('refuses a retained write through a local receiver alias: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('keeps between calls'),
    ]);
  });

  it.each([
    'class Counter { n = 0; bump() { const self = {n: 0}; return ++self.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; read() { const self = this; return self.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.read(); }',
    'class Counter { n = 0; bump() { let {n} = this; return ++n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; return ((self: {n: number}) => ++self.n)({n: 0}); } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; { const self = {n: 0}; return ++self.n; } } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const {...copy} = this; return ++copy.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { let self = this as {n: number}; self = {n: 0}; return ++self.n; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
    'class Counter { n = 0; bump() { const self = this; return [{n: 0}].map((self) => ++self.n)[0]; } } const counter = new Counter(); export function label(value: string) { return value + counter.bump(); }',
  ])('keeps fresh locals, primitive copies and lexical shadows: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared method result used repeatedly as an authority-rendered child input. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/this-alias-writes.ts': source,
    'components/this-alias-writes.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/this-alias-writes';",
      'export default function ThisAliasWrites({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
