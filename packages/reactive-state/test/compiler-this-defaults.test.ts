import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A missing receiver member selects its fresh default rather than retaining this. */
describe('shared receiver destructuring defaults', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'const counter = {bump() { const {box = {n: 0}} = this as {box?: {n: number}}; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const counter = {outer: {}, bump() { const {outer: {box = {n: 0}}} = this as {outer: {box?: {n: number}}}; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const counter = {bump() { const fresh = {n: 0}; const {box = fresh} = this as {box?: {n: number}}; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const counter = {bump() { const {box = {inner: {n: 0}}} = this as {box?: {inner: {n: number}}}; return ++box.inner.n; }}; export function label(value: string) { return value + counter.bump(); }',
  ])('keeps a source-proven fresh receiver-member default: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'const counter = {box: {n: 0}, bump() { const {box = {n: 0}} = this; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const shared = {n: 0}; const counter = {bump() { const {box = shared} = this as {box?: {n: number}}; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const shared = {n: 0}; const counter = {bump() { const {outer: {box} = {box: shared}} = this as {outer?: {box: {n: number}}}; return ++box.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'const counter = {held: {n: 0}, bump() { const {box = {inner: this.held}} = this as typeof this & {box?: {inner: {n: number}}}; return ++box.inner.n; }}; export function label(value: string) { return value + counter.bump(); }',
    'function ensure(value: {box?: {n: number}}) { value.box ??= {n: 0}; } const counter = {bump() { const {box = {n: 0}} = this as {box?: {n: number}}; return ++box.n; }}; export function label(value: string) { ensure(counter); return value + counter.bump(); }',
  ])('retains present members and shared references selected by defaults: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('keeps between calls'),
    ]);
  });

  it('keeps a copied primitive from a missing member', async () => {
    const app = await fixture(
      'const counter = {bump() { let {n = 0} = this as {n?: number}; return ++n; }}; export function label(value: string) { return value + counter.bump(); }',
    );
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared method used as an authority-rendered child input. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/this-defaults.ts': source,
    'components/this-defaults.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/this-defaults';",
      'export default function ThisDefaults({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
