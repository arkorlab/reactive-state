import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A member write into a parameter the function returns is an entry of an object only where the
 * compile reads the object the parameter holds: one the call writes out where the parameter stands,
 * made for that call and held by nothing else, or one the function's own code replaces it with. Any
 * other value a call hands (a constant, what a call answers, a frozen object, an array, a page's
 * value) may be held elsewhere or be no plain object, and a parameter that may be assigned again
 * holds what the compile does not read: each stays refused.
 */
const MAKE = "function make(value: {id: string}) { value.id = 'fresh'; return value; }";
const LOOSE = "function make(value: {id?: string}) { value.id = 'fresh'; return value; }";
const PAYLOAD = " export const payload = make({id: 'safe'});";

describe('shared factory parameter member writes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    `${MAKE}${PAYLOAD}`,
    "function make(value: {id: string}) { value.id = value.id.trim(); return value; } export const payload = make({id: ' safe '});",
    `function make(value: {id: string}) { const alias = value; alias.id = 'fresh'; return value; }${PAYLOAD}`,
    `function make(value: {id: string}) { Object.assign(value, {id: 'fresh'}); return value; }${PAYLOAD}`,
    "function make(value: {meta: {id: string}}) { value.meta.id = 'fresh'; return value; } export const payload = make({meta: {id: 'safe'}});",
    "function make(value: {id: string; extra?: string}) { delete value.extra; return value; } export const payload = make({id: 'safe', extra: 'more'});",
    "function make(value: {id: string; count: number}) { value.count += 1; return value; } export const payload = make({id: 'safe', count: 1});",
    `${MAKE} const build = make;${PAYLOAD.replace('make(', 'build(')}`,
    `const DEFAULTS = {id: 'default'}; function make(value: {id: string} = DEFAULTS) { value.id = 'fresh'; return value; }${PAYLOAD}`,
    `const shared = {id: 'shared'}; ${MAKE} export const other = make(shared);${PAYLOAD}`,
    `function make(value: {id: string}) { value = {id: 'fresh'}; value.id = 'safe'; return value; }${PAYLOAD}`,
    `const make = (value: {id: string}) => { value.id = 'fresh'; return value; };${PAYLOAD}`,
    `function make(value: {id: string; size?: number}) { value.size ??= 10; return value; }${PAYLOAD}`,
  ])('keeps a member write into the object the parameter holds: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    `const shared = {id: 'shared'}; ${MAKE} export const payload = make(shared);`,
    `${MAKE} export const payload = make(Object.freeze({id: 'safe'}));`,
    `function made() { return {id: 'safe'}; } ${MAKE} export const payload = make(made());`,
    `${LOOSE} export const payload = make([] as {id?: string});`,
    `${MAKE} export const payload = make(...([{id: 'safe'}] as [{id: string}]));`,
    `${LOOSE} export const payload = make.apply(null, {0: [], length: 1} as never);`,
    `${LOOSE} export const payload = make.call(null, [] as {id?: string});`,
    `const shared = {id: 'shared'}; ${MAKE} export const other = make({id: 'safe'}); export const payload = make(shared);`,
    "const shared = {id: 'shared'}; function make(value: {meta: {id: string}}) { value.meta.id = 'fresh'; return value; } export const payload = make({meta: shared});",
    "function make(value: {list: string[] & {id?: string}}) { value.list.id = 'fresh'; return value; } export const payload = make({list: []});",
    "function make(value: {id: string} = {id: 'default'}) { value.id = 'fresh'; return value; } export const payload = make();",
    `function make(...value: {id?: string}[]) { (value as {id?: string}).id = 'fresh'; return value; }${PAYLOAD}`,
    "function make({meta}: {meta: {id: string}}) { meta.id = 'fresh'; return meta; } export const payload = make({meta: {id: 'safe'}});",
  ])('refuses a member write into a value the call does not write out: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    `function make(value: {id?: string}, flag: boolean) { if (flag) { value = [] as {id?: string}; } value.id = 'fresh'; return value; } export const payload = make({id: 'safe'}, true);`,
    `function make(value: {id?: string}) { const swap = () => { value = [] as {id?: string}; }; swap(); value.id = 'fresh'; return value; }${PAYLOAD}`,
    `function make(value: {id?: string}, flag: boolean) { if (flag) { var value = [] as {id?: string}; } value.id = 'fresh'; return value; } export const payload = make({id: 'safe'}, true);`,
    `function make(value: {id?: string}) { [value] = [[] as {id?: string}]; value.id = 'fresh'; return value; }${PAYLOAD}`,
    `function make(value: {id?: string}) { for (value of [[] as {id?: string}]) { value.id = 'fresh'; } return value; }${PAYLOAD}`,
    `function make(value: {id?: string}) { value = [] as {id?: string}; value.id = 'fresh'; return value; }${PAYLOAD}`,
    `const fresh = {id: 'fresh'}; function make(value: {id: string}) { value = fresh; value.id = 'safe'; return value; }${PAYLOAD}`,
  ])('refuses a member write into a parameter that may hold another value: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    `function make(value: {id: string; bad?: unknown}) { value.bad = new Date(0); return value; }${PAYLOAD}`,
    `function make(value: {id: string; self?: unknown}) { value.self = value; return value; }${PAYLOAD}`,
    `function make(value: {id: string; bad?: unknown}) { Object.assign(value, {bad: new Date(0)}); return value; }${PAYLOAD}`,
    `function make(value: {id: string}) { Object.defineProperty(value, 'id', {value: 'fresh'}); return value; }${PAYLOAD}`,
    "function make(value: {id: string; count: number}) { value.count *= 2; return value; } export const payload = make({id: 'safe', count: 1});",
    `let kept: unknown; function make(value: {id: string}) { kept = value; value.id = 'fresh'; return value; }${PAYLOAD}`,
  ])('refuses what the write may leave that no JSON holds: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    `function make(value: {id: string; bad?: unknown}, other = value) { value.id = 'fresh'; other.bad = new Date(0); return value; }${PAYLOAD}`,
    `function make(value: {id: string; bad?: unknown}, {other = value} = {}) { value.id = 'fresh'; other.bad = new Date(0); return value; }${PAYLOAD}`,
    `function make(value: {id: string; bad?: unknown}) { value.id = 'fresh'; (arguments[0] as {bad?: unknown}).bad = new Date(0); return value; }${PAYLOAD}`,
  ])(
    'refuses a member write into a parameter the function names another way: %s',
    async (module) => {
      const app = await fixture(module);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
    },
  );

  // As of a constant the function declares: a function the object is handed to that writes into
  // it, and a member the code assigns an object and then writes into, are not followed.
  it.each([
    `function trim(value: {id: string}) { value.id = value.id.trim(); } function make(value: {id: string}) { trim(value); return value; }${PAYLOAD}`,
    `function make(value: {id: string; meta?: {n?: number}}) { value.meta = {}; value.meta.n = 1; return value; }${PAYLOAD}`,
  ])('refuses a write into the object the compile does not follow: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it('refuses a member write into a value the page gives', async () => {
    const app = await fixture(`export ${MAKE}`, 'first === null ? null : make(first)');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    `function make(value: {id: string}) { return value; }${PAYLOAD}`,
    `function make(value: {id: string}) { const made = {id: value.id}; made.id = 'safe'; return made; }${PAYLOAD}`,
    "const shared = {id: 'shared'}; function make(value: {id: string}) { return value; } export const payload = make(shared);",
  ])('keeps a parameter nothing writes into and an object built beside it: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared factory's answer, or what the component's own call of it answers, in an authority-started state. */
async function fixture(
  module: string,
  start = 'first === null ? payload as never : first',
): Promise<Application> {
  const imported = start.includes('make(') ? 'make' : 'payload';
  return application({
    'domain/parameter-member-writes.ts': `${module}\n`,
    'components/parameter-member-value.reactive.tsx': [
      'export default function ParameterMemberValue({value}: {value: unknown}) {',
      '  return <p>{String(value)}</p>;',
      '}',
    ].join('\n'),
    'components/parameter-member-writes.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import ParameterMemberValue from '@/components/parameter-member-value.reactive';",
      `import { ${imported} } from '@/domain/parameter-member-writes';`,
      'export default function ParameterMemberWrites({first}: {first: {id: string} | null}) {',
      `  const [selected, setSelected] = useReactiveState<{id: string} | null>(${start});`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><ParameterMemberValue value={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
