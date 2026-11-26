import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Module constants retain JSON checks and the lexical identity of their own writes. */
describe('shared module constant JSON values', () => {
  const { apps, compile } = compilerApplications();

  it.each(
    [
      'function make() { return new Date(0); } export const payload = make();',
      "function make() { return new Set(['x']); } export const payload = make();",
      "function make() { return new Map([['id', 'x']]); } export const payload = make();",
      "async function make() { return { id: 'x' }; } export const payload = make();",
      'const makers = { make() { return new Date(0); } }; export const payload = makers.make();',
      "function make() { const value: {id: string; bad?: unknown} = {id: 'safe'}; const alias = value; alias.bad = new Date(0); return value; } export const payload = make();",
    ].flatMap((module) => (['state', 'site'] as const).map((where) => ({ module, where }))),
  )(
    'refuses $where values from a shared constant initialized by a non-JSON call: $module',
    async ({ module, where }) => {
      const app = await fixture(module, where);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
    },
  );

  it.each([
    "export const payload = { id: 'safe' }; function change(payload: {bad?: unknown}) { payload.bad = new Date(0); }",
    "export const payload = { id: 'safe' }; function change() { const payload: {bad?: unknown} = {}; payload.bad = new Date(0); }",
    "export const payload = { id: 'safe' }; function change(values: {bad?: unknown}[]) { values.forEach((payload) => { payload.bad = new Date(0); }); }",
    "export const payload = { id: 'safe' }; function change({payload}: {payload: {bad?: unknown}}) { payload.bad = new Date(0); }",
    "function make() { const result = {id: 'safe'}; function unrelated(result: {bad?: unknown}) { result.bad = new Date(0); } return result; } export const payload = make();",
  ])('keeps JSON constants distinct from shadowed module locals: %s', async (module) => {
    const app = await fixture(module, 'state');
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "function make() { return { id: 'safe' }; } export const payload = make();",
    "function identity<T>(value: T): T { return value; } export const payload = identity({ id: 'safe' });",
    "function make(depth = 0): {id: string} { return depth > 0 ? make(depth - 1) : { id: 'safe' }; } export const payload = make();",
    "function make() { const value = {id: 'before'}; value.id = 'safe'; return value; } export const payload = make();",
    "const makers = { make() { return {id: 'safe'}; } }; export const payload = makers.make();",
    "const makers = { get make() { return () => ({id: 'safe'}); } }; export const payload = makers.make();",
    "const makers = { map(_value: number) { return {id: 'safe'}; } }; export const payload = makers.map(1);",
  ])('keeps shared calls whose result is proven JSON: %s', async (module) => {
    const app = await fixture(module, 'state');
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Imported module values used as an authority-started state or a dynamic child's prop. */
async function fixture(module: string, where: 'state' | 'site'): Promise<Application> {
  const initial = where === 'state' ? '(first === null ? payload as never : first)' : 'first';
  const value = where === 'site' ? '(selected === null ? payload : selected)' : 'selected';
  return application({
    'domain/module-json.ts': `${module}\n`,
    'components/module-value.reactive.tsx': [
      'export default function ModuleValue({ value }: { value: unknown }) {',
      '  return <p>{String(value)}</p>;',
      '}',
    ].join('\n'),
    'components/module-json.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import ModuleValue from '@/components/module-value.reactive';",
      "import { payload } from '@/domain/module-json';",
      'export default function ModuleJson({ first }: { first: {id: string} | null }) {',
      `  const [selected, setSelected] = useReactiveState<{id: string} | null>(${initial});`,
      `  return <section><button onClick={() => setSelected(first)}>reset</button><ModuleValue value={${value}} /></section>;`,
      '}',
    ].join('\n'),
  });
}
