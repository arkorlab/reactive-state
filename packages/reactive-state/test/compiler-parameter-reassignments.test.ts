import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Definite replacements separate a returned parameter's current value from its old object. */
describe('shared factory parameter replacements', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); value = {id: 'fresh'}; return value; }",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); (value as {id: string}) = {id: 'fresh'}; return value; }",
    "function make(value: {id: string; bad?: unknown}) { const fresh = {id: 'fresh'}; value.bad = new Date(0); value = fresh; return value; }",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); value = {id: 'fresh'}; value.id = 'safe'; return value; }",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); var value = {id: 'fresh'}, ignored = (value.id = 'safe'); return value; }",
  ])('keeps a returned fresh value after a definite replacement: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  // A member write is an entry of an object only where the object is one the code writes out: the
  // replacement is, in the rows above. A constant that replaces the parameter is another name's
  // object, and an array holds no named member that JSON keeps.
  it.each([
    "function make(value: {id: string; bad?: unknown}) { const fresh = {id: 'fresh'}; value.bad = new Date(0); value = fresh; value.id = 'safe'; return value; }",
    "function make(value: {id?: string; bad?: unknown}) { value.bad = new Date(0); value = [] as {id?: string}; value.id = 'safe'; return value; }",
  ])('refuses a member write into a parameter replaced by another value: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "function make(value: {id: string; bad?: unknown}) { if (false) { var value = {id: 'fresh'}; } value.bad = new Date(0); return value; }",
    "function make(value: {id: string; bad?: unknown}) { var value = {id: 'fresh'}; value.bad = new Date(0); return value; }",
    "function make(value: {id: string; bad?: unknown}) { value = {id: 'fresh'}; value.bad = new Date(0); return value; }",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); if (value.id === 'other') { value = {id: 'fresh'}; } return value; }",
    "function make(value: {id: string; bad?: unknown}) { function change() { value.bad = new Date(0); } value = {id: 'fresh'}; change(); return value; }",
    "function make(value: {id: string; bad?: unknown}) { const original = value; original.bad = new Date(0); function restore() { value = original; } value = {id: 'fresh'}; restore(); return value; }",
    "function make(value: {id: string; bad?: unknown}) { var value = {id: 'fresh'}, ignored = (value.bad = new Date(0)); return value; }",
    "function make(value: {id: string; bad?: unknown}) { const original = value; original.bad = new Date(0); value = {id: 'fresh'}; value &&= original; return value; }",
    "function make(value: {id: string; bad?: unknown}) { const original = value; original.bad = new Date(0); value = {id: 'fresh'}; [value] = [original]; return value; }",
    "function make(value: {id: string; bad?: unknown}) { const original = value; original.bad = new Date(0); value = {id: 'fresh'}; for (var value of [original]) {} return value; }",
  ])('refuses a non-JSON value that can remain after replacement: %s', async (source) => {
    const app = await fixture(source);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });
});

/** A shared factory's return read by an authority-started state. */
async function fixture(source: string): Promise<Application> {
  return application({
    'domain/parameter-replacement.ts': `${source} export const payload = make({id: 'safe'});\n`,
    'components/replacement-value.reactive.tsx':
      'export default function ReplacementValue({value}: {value: unknown}) { return <p>{String(value)}</p>; }',
    'components/parameter-replacement.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import ReplacementValue from '@/components/replacement-value.reactive';",
      "import { payload } from '@/domain/parameter-replacement';",
      'export default function ParameterReplacement({first}: {first: {id: string} | null}) {',
      '  const [selected, setSelected] = useReactiveState<{id: string} | null>(first === null ? payload as never : first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><ReplacementValue value={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
