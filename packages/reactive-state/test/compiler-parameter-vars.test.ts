import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Parameter writes retain their binding through a function-scoped redeclaration. */
describe('shared factory parameter mutations', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "function make(value: {id: string; bad?: unknown}) { var value; value.bad = new Date(0); return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; bad?: unknown}) { { var value; } const alias = value; alias.bad = new Date(0); return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; self?: unknown}) { var value; value.self = value; return value; } export const payload = make({id: 'safe'});",
  ])('refuses a non-JSON mutation of a returned parameter: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "function make(value: {id: string; bad?: unknown}) { var value = {id: 'fresh'}; return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); var value = {id: 'fresh'}; return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; bad?: unknown}) { var value; value.id = 'fresh'; return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string}) { var value; value.id = value.id; return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string; bad?: unknown}) { var value; value.bad = new Date(0); return value.id; } export const payload = make({id: 'safe'});",
    "function make(value: string) { Array.prototype.includes.call(['safe'], value); return value; } export const payload = make('safe');",
    "function make(value: {id: string}) { function unrelated(value: {bad?: unknown}) { var value; value.bad = new Date(0); } return value; } export const payload = make({id: 'safe'});",
    "function make(value: {id: string}) { function unrelated() { var value: {bad?: unknown} = {}; value.bad = new Date(0); } return value; } export const payload = make({id: 'safe'});",
  ])('keeps fresh reassignment and separate nested bindings: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared factory's answer used in an authority-started state. */
async function fixture(module: string): Promise<Application> {
  return application({
    'domain/parameter-vars.ts': `${module}\n`,
    'components/parameter-value.reactive.tsx': [
      'export default function ParameterValue({value}: {value: unknown}) {',
      '  return <p>{String(value)}</p>;',
      '}',
    ].join('\n'),
    'components/parameter-vars.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import ParameterValue from '@/components/parameter-value.reactive';",
      "import { payload } from '@/domain/parameter-vars';",
      'export default function ParameterVars({first}: {first: {id: string} | null}) {',
      '  const [selected, setSelected] = useReactiveState<{id: string} | null>(first === null ? payload as never : first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><ParameterValue value={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
