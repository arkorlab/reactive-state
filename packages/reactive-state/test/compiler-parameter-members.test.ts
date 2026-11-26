import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Returned members read a proven replacement rather than the call's original argument. */
describe('shared factory replaced parameter members', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "function make(value: {id: string; bad?: unknown; nested?: unknown}) { value.bad = new Date(0); value = {id: 'fresh', nested: {bad: new Date(0)}}; return value.nested; } export const payload = make({id: 'safe', nested: {id: 'initial'}});",
    "function make(value: {id: string; nested?: unknown}) { value = {id: 'fresh', nested: new Date(0)}; return value['nested']; } export const payload = make({id: 'safe', nested: {id: 'initial'}});",
    "function make(value: {id: string; nested?: unknown}) { const fresh = {id: 'fresh', nested: new Date(0)}; value = fresh; return value.nested; } export const payload = make({id: 'safe', nested: {id: 'initial'}});",
    "function make(value: unknown[]) { value = [new Date(0)]; return value[0]; } export const payload = make([{id: 'safe'}]);",
    "function make(value: {id: string; nested?: {bad?: unknown}}) { value = {id: 'fresh', nested: {bad: new Date(0)}}; return (value.nested as {bad: unknown}).bad; } export const payload = make({id: 'safe', nested: {bad: 'initial'}});",
    "function make(value: {nested: unknown}) { var value = {nested: new Date(0)}; return value.nested; } export const payload = make({nested: {id: 'initial'}});",
    "function make(value: {nested: unknown}) { var value; value = {nested: new Date(0)}; return value.nested; } export const payload = make({nested: {id: 'initial'}});",
    "function make(value: {nested: unknown}) { value = {nested: new Date(0)}; const read = () => value.nested; return value.nested; } export const payload = make({nested: {id: 'initial'}});",
  ])('refuses a non-JSON member written by the proven replacement: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "function make(value: {id: string; bad?: unknown; nested?: unknown}) { value.bad = new Date(0); value = {id: 'fresh', nested: {id: 'safe'}}; return value.nested; } export const payload = make({id: 'initial'});",
    "function make(value: {id: string; bad?: unknown; nested?: unknown}) { value = {id: 'fresh', bad: new Date(0), nested: {id: 'safe'}}; return value.nested; } export const payload = make({id: 'initial'});",
    "function make(value: {id: string; nested?: unknown}) { const fresh = {id: 'fresh', bad: new Date(0), nested: {id: 'safe'}}; value = fresh; return value.nested; } export const payload = make({id: 'initial'});",
    "function make(value: {id: string; nested?: unknown}) { value = {id: 'fresh', nested: new Date(0)}; value.nested = {id: 'safe'}; return value.nested; } export const payload = make({id: 'initial'});",
    "function make(value: {id: string; nested?: unknown}) { value = {id: 'fresh', get nested() { return {id: 'safe'}; }}; return value.nested; } export const payload = make({id: 'initial'});",
    "function make(value: {id: string; nested?: unknown}) { return value.nested; } export const payload = make({id: 'initial', nested: {id: 'safe'}});",
    "function make(value: {nested: unknown}) { value = {nested: new Date(0)}; { const value = {nested: {id: 'safe'}}; return value.nested; } } export const payload = make({nested: {id: 'initial'}});",
  ])('keeps selected JSON members and defers unproven later values: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared factory's selected member used in an authority-started state. */
async function fixture(module: string): Promise<Application> {
  return application({
    'domain/parameter-member.ts': `${module}\n`,
    'components/member-value.reactive.tsx':
      'export default function MemberValue({value}: {value: unknown}) { return <p>{String(value)}</p>; }',
    'components/parameter-member.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import MemberValue from '@/components/member-value.reactive';",
      "import { payload } from '@/domain/parameter-member';",
      'export default function ParameterMember({first}: {first: {id: string} | null}) {',
      '  const [selected, setSelected] = useReactiveState<{id: string} | null>(first === null ? payload as never : first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><MemberValue value={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
