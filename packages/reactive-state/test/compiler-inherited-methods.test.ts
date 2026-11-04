import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Retained instances and constructors keep the methods their source-written bases provide. */
describe('shared retained inherited methods', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Middle extends Base {} class Child extends Middle {} const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { read() { return this.bump(); } } const counter = new Child(); export function label(value: string) { return value + counter.read(); }',
    'class Base { n = 0; bump() { return ++this.n; } } const Parent = Base; class Child extends Parent {} const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base {} const Factory = Child; const counter = new Factory(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump = () => ++this.n; } class Child extends Base { bump() { return 0; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { static n = 0; static bump() { return ++this.n; } } class Child extends Base {} export function label(value: string) { return value + Child.bump(); }',
    'class Base { n = 0; #bump() { return ++this.n; } read() { return this.#bump(); } } class Child extends Base { #bump() { return 0; } } const counter = new Child(); export function label(value: string) { return value + counter.read(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { declare bump: () => number; } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base {} const counter = new Child(); const alias = counter; export function label(value: string) { return value + alias.bump(); }',
    'class Base { n = 0; *bump() { yield ++this.n; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { counter.bump().next(); return value + counter.n; }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { constructor() { super(); return {n: 0, bump() { return ++this.n; }} as Child; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { constructor() { super(); return {n: 0, get bump() { return () => ++this.n; }} as Child; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { constructor() { super(); return {n: 0, bump: () => ++this.n} as Child; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; *bump(value = ++this.n) { yield value; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { counter.bump(); return value + counter.n; }',
  ])('refuses a source-proven inherited retained write: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('keeps between calls'),
    ]);
  });

  it.each([
    'class Base { n = 0; read() { return this.n; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { return value + counter.read(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { bump() { return 0; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { bump = () => 0; } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { get bump() { return () => 0; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { static n = 0; static bump() { return ++this.n; } } class Child extends Base { bump() { return 0; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { static bump() { return 0; } } export function label(value: string) { return value + Child.bump(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base {} export function label(value: string) { return value + new Child().bump(); }',
    'class Base { read() { return 0; } } const Parent = Base; class Child extends Parent {} const counter = new Child(); export function label(value: string) { return value + counter.read(); }',
    'class Base { n = 0; bump = () => 0; } class Child extends Base { bump() { return ++this.n; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { #read() { return 0; } read() { return this.#read(); } } class Child extends Base { n = 0; #read() { return ++this.n; } } const counter = new Child(); export function label(value: string) { return value + counter.read(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { ["bump"]() { return 0; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { read() { return 0; } } class Child extends Base {} const counter = new Child(); const alias = counter; export function label(value: string) { return value + alias.read(); }',
    'class Base { n = 0; bump() { return ++this.n; } } class Child extends Base { constructor() { super(); return {n: 0, bump() { return 0; }} as Child; } } const counter = new Child(); export function label(value: string) { return value + counter.bump(); }',
    'class Base { n = 0; *bump() { yield ++this.n; } } class Child extends Base {} const counter = new Child(); export function label(value: string) { counter.bump(); return value + counter.n; }',
  ])('keeps pure inheritance, surviving own shadows and fresh receivers: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared helper repeatedly used as the input of an authority-rendered child. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/inherited-methods.ts': source,
    'components/inherited-methods.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/inherited-methods';",
      'export default function InheritedMethods({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
