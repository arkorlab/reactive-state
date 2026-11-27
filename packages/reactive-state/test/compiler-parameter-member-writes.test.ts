import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A member write into a parameter the function returns is an entry of an object only where the
 * compile reads the object the parameter holds: one the call writes out where the parameter stands,
 * made for that call and held by nothing else, or one the function's own code replaces it with. Any
 * other value a call hands (a constant, what a call answers, a frozen object, an array, a page's
 * value) may be held elsewhere or be no plain object, and a parameter that may be assigned again
 * holds what the compile does not read: each stays refused. So does a parameter the function keeps
 * where the walk of its reads does not follow it (in a list, a member, a closure) and one a call
 * locks before a write; a replacement of the parameter is no write beside a sum written into the
 * object it gives.
 */
const MAKE = "function make(value: {id: string}) { value.id = 'fresh'; return value; }";
const LOOSE = "function make(value: {id?: string}) { value.id = 'fresh'; return value; }";
const PAYLOAD = " export const payload = make({id: 'safe'});";

const WIDE = '{id: string; bad?: unknown; extra?: string}';
/** A factory of an object that has room for the members the rows write, called as `PAYLOAD` does. */
function wide(body: string): string {
  return `function make(value: ${WIDE}) { ${body} }${PAYLOAD}`;
}

const NESTED = " export const payload = make({meta: {id: 'safe'}});";

const IDENTITY = 'function identity<T>(target: T) { return target; }';
/** A factory as `wide` makes it, with a helper declared before it. */
function answered(helper: string, body: string): string {
  return `${helper} ${wide(body)}`;
}

/** A factory of a number list, called with `[0]`. */
function counted(body: string): string {
  return `function make(value: number[]) { ${body} } export const payload = make([0]);`;
}

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
    "function make(value: {id: string; count: number}) { value.count *= 2; return value; } export const payload = make({id: 'safe', count: 1});",
    "function make(value: {id: string; count: number}) { value.count++; return value; } export const payload = make({id: 'safe', count: 1});",
    "function make(value: {id: string; count: number}) { value.count += value.count; return value; } export const payload = make({id: 'safe', count: 1});",
    "function make(value: {id: string}) { value.id += '!'; return value; } export const payload = make({id: 'safe'});",
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
    `let kept: unknown; function make(value: {id: string}) { kept = value; value.id = 'fresh'; return value; }${PAYLOAD}`,
  ])('refuses what the write may leave that no JSON holds: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  // A sum or a product is taken of a parameter as of a constant where it is the only write of its
  // member and the code shows a finite result. One that repeats, or stands beside another write of
  // the member, is left to the authority of a constant; of a parameter it is refused.
  it.each([
    'function make(value: {n: number}) { value.n += 1e308; return value; } export const payload = make({n: 1e308});',
    'function make(value: {n: number}) { value.n -= 1e308; return value; } export const payload = make({n: -1e308});',
    'function make(value: {n: number}) { value.n *= 2; return value; } export const payload = make({n: 1e308});',
    'function make(value: {n: number}) { value = {n: 1e308}; value.n += 1e308; return value; } export const payload = make({n: 1});',
    'function make(value: {n: number}) { value.n += 1; value = {n: 1e308}; value.n += 1e308; return value; } export const payload = make({n: 1});',
    'function make(value: {n: number}) { value.n += 1e308; value.n += 1e308; return value; } export const payload = make({n: 0});',
    'function make(value: {n: number}) { for (let at = 0; at < 2; at += 1) { value.n += 1e308; } return value; } export const payload = make({n: 0});',
    'function make(value: {n: number}) { const add = () => { value.n += 1e308; }; add(); add(); return value; } export const payload = make({n: 0});',
  ])('refuses a sum or a product that is not shown finite: %s', async (module) => {
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

  // The compile reads the object a parameter holds only where the function's own code keeps it
  // nowhere the walk of its reads does not follow, and writes into it before anything locks it.
  // Otherwise a member write is a change, as it was before the object was read at all.
  it.each([
    wide('const wrapper = {target: value}; return wrapper.target;'),
    wide(
      "const wrapper = {target: {id: 'other'}}; wrapper.target.id = 'x'; value.id = 'fresh'; return value;",
    ),
    wide("value.id = 'fresh'; return [value];"),
    wide("value.id = 'fresh'; return {value};"),
    wide("value.id = 'fresh'; return value.id === 'safe' ? value : {id: 'other'};"),
    wide("const copy = {...value}; copy.bad = 1; value.id = 'fresh'; return copy;"),
    wide("console.log(value); value.id = 'fresh'; return value;"),
    wide("const alias = value; const again = alias; again.id = 'fresh'; return value;"),
    wide("value.extra = value.id; value.id = 'fresh'; return value;"),
    wide("value.extra = value.id || 'none'; value.id = 'fresh'; return value;"),
    wide("const alias = value; alias.extra = value.id; value.id = 'fresh'; return value;"),
    wide("const swap = () => { value.id = 'fresh'; }; swap(); return value;"),
  ])('keeps a member write into a parameter nothing keeps elsewhere: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    wide(
      "const wrapper = {target: value}; wrapper.target.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    wide(
      "value.id = 'fresh'; const wrapper = {target: value}; wrapper.target.bad = new Date(0); return value;",
    ),
    wide(
      "const alias = value; const wrapper = {target: alias}; wrapper.target.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    wide("const list = [value]; list[0].bad = new Date(0); value.id = 'fresh'; return value;"),
    wide(
      `const holder: {target?: ${WIDE}} = {}; holder.target = value; (holder.target as ${WIDE}).bad = new Date(0); value.id = 'fresh'; return value;`,
    ),
    wide("const get = () => value; get().bad = new Date(0); value.id = 'fresh'; return value;"),
    wide(
      `const pick = value.id === 'safe' ? value : {id: 'other'}; (pick as ${WIDE}).bad = new Date(0); value.id = 'fresh'; return value;`,
    ),
    wide(
      "value = {id: 'fresh'}; const wrapper = {target: value}; wrapper.target.bad = new Date(0); value.id = 'safe'; return value;",
    ),
    // The walk does not tell a wrapper nothing writes through from one something does.
    wide("const wrapper = {target: value}; value.id = 'fresh'; return value;"),
  ])(
    'refuses a member write into a parameter kept in an alias the walk misses: %s',
    async (module) => {
      const app = await fixture(module);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
    },
  );

  it.each([
    wide("value.id = 'fresh'; Object.freeze(value); return value;"),
    wide("value.id = 'fresh'; return Object.freeze(value);"),
    wide("value.id = 'fresh'; Object.seal(value); Object.preventExtensions(value); return value;"),
    wide("Object.freeze({id: 'other'}); value.id = 'fresh'; return value;"),
    wide('Object.freeze(value); return value;'),
    wide("value.id = 'fresh'; Object.freeze(value); const id = value.id; return {id};"),
    wide("Object.freeze(value); value = {id: 'fresh'}; value.id = 'safe'; return value;"),
    `function make(value: {meta: {id: string}}) { value.meta.id = 'fresh'; Object.freeze(value.meta); return value; }${NESTED}`,
  ])('keeps a member write before the call that locks the parameter: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    wide("Object.freeze(value); value.id = 'fresh'; return value;"),
    wide("Object.seal(value); value.extra = 'added'; return value;"),
    wide("Object.preventExtensions(value); value.extra = 'added'; return value;"),
    wide("Reflect.preventExtensions(value); value.extra = 'added'; return value;"),
    wide(
      "Object.defineProperty(value, 'id', {writable: false}); value.id = 'fresh'; return value;",
    ),
    wide(
      "Object.defineProperties(value, {id: {writable: false}}); value.id = 'fresh'; return value;",
    ),
    wide("const alias = value; Object.freeze(alias); value.id = 'fresh'; return value;"),
    wide("const alias = value; Object.freeze(value); alias.id = 'fresh'; return value;"),
    wide("for (const id of ['a', 'b']) { value.id = id; Object.freeze(value); } return value;"),
    wide("const swap = () => { value.id = 'fresh'; }; Object.freeze(value); swap(); return value;"),
    wide("const lock = () => Object.freeze(value); lock(); value.id = 'fresh'; return value;"),
    wide("if (value.id === 'safe') { Object.freeze(value); } value.id = 'fresh'; return value;"),
    wide("value = {id: 'fresh'}; Object.freeze(value); value.id = 'safe'; return value;"),
    `function make(value: {meta: {id: string}}) { Object.freeze(value.meta); value.meta.id = 'fresh'; return value; }${NESTED}`,
  ])('refuses a member write after a call locks the parameter: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  // The replacement is the write that gives the parameter the object the compile reads, so it is no
  // write beside the sum; another write of the member, before it or after, is.
  it.each([
    counted('value = [1]; value[0] += 1; return value;'),
    counted('value = [1]; value[0] *= 2; return value;'),
    counted('value = [1]; value[0]++; return value;'),
    counted('var value = [1]; value[0] += 1; return value;'),
    'function make(value: {n: number}) { value = {n: 1}; value.n += 1; return value; } export const payload = make({n: 0});',
    'function make(value: {n: number}) { value = {n: 1}; value.n -= 1; return value; } export const payload = make({n: 0});',
  ])('keeps a sum written into the object a parameter was replaced with: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    counted('value = [1]; value[0] += 1; value[0] += 1; return value;'),
    counted('value = [1]; value[0] = 5; value[0] += 1; return value;'),
    counted('value[0] += 1; value = [1]; value[0] += 1; return value;'),
    counted('value = [1]; const add = () => { value[0] += 1; }; add(); add(); return value;'),
    counted('value = [1e308]; value[0] += 1e308; return value;'),
    counted('value = [1e308]; value[0] *= 2; return value;'),
    'function make(value: {n: number}) { value = {n: 1e308}; value.n += 1e308; return value; } export const payload = make({n: 0});',
  ])(
    'refuses a sum of a replaced parameter that is not alone or not finite: %s',
    async (module) => {
      const app = await fixture(module);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
    },
  );

  // A value that only a condition, a comparison or an operator reads is kept nowhere, however many
  // `||`, `&&`, `??` it passes through; one a name, a member, a call or a list takes stays kept.
  it.each([
    wide("if (value.id || false) { value.id = 'fresh'; } return value;"),
    wide("if (value.id ?? 'none') { value.id = 'fresh'; } return value;"),
    wide(
      "while (value.id && value.extra) { value.extra = undefined; } value.id = 'fresh'; return value;",
    ),
    wide(
      "const same = (value.id || '') === 'safe'; value.id = 'fresh'; return same ? value : value;",
    ),
    wide("const label = value.id || value.extra ? 'a' : 'b'; value.id = label; return value;"),
    wide("const none = !(value.id || value.extra); value.id = none ? 'a' : 'b'; return value;"),
    wide(`const text = \`\${value.id || 'none'}!\`; value.id = text; return value;`),
    wide("const same = (value || {id: 'x'}) === value; value.id = same ? 'a' : 'b'; return value;"),
    wide("switch (value.id || 'none') { case 'safe': value.id = 'fresh'; } return value;"),
  ])('keeps a member write into a parameter that only a condition reads: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    wide(
      `const alias = value || {id: 'x'}; (alias as ${WIDE}).bad = new Date(0); value.id = 'fresh'; return value;`,
    ),
    wide("const wrapper = {target: value.id || value}; value.id = 'fresh'; return value;"),
    wide(
      `const list = [value || {id: 'x'}]; (list[0] as ${WIDE}).bad = new Date(0); value.id = 'fresh'; return value;`,
    ),
    wide(`((value || {id: 'x'}) as ${WIDE}).bad = new Date(0); value.id = 'fresh'; return value;`),
    wide("console.log(value || {id: 'x'}); value.id = 'fresh'; return value;"),
  ])('refuses a member write into a parameter a carried value is kept of: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  // A helper that answers what it is handed answers the parameter itself: the name the answer is
  // taken into is one the walk of the parameter's reads does not follow.
  it.each([
    answered(
      IDENTITY,
      "const alias = identity(value); alias.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    answered(
      'const identity = <T,>(target: T) => target;',
      "const alias = identity(value); alias.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    answered(
      `function orEmpty(target: ${WIDE} | undefined) { return target ?? {id: 'x'}; }`,
      "const alias = orEmpty(value); alias.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    answered(
      `function passed(target: ${WIDE}) { const kept = target; return kept; }`,
      "const alias = passed(value); alias.bad = new Date(0); value.id = 'fresh'; return value;",
    ),
    answered(IDENTITY, "identity(value).bad = new Date(0); value.id = 'fresh'; return value;"),
    answered(
      IDENTITY,
      `const holder: {target?: ${WIDE}} = {}; holder.target = identity(value); value.id = 'fresh'; return value;`,
    ),
    answered(
      IDENTITY,
      "value.id = 'fresh'; const alias = identity(value); alias.bad = new Date(0); return value;",
    ),
  ])('refuses a member write into a parameter a helper answers: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    answered(IDENTITY, "identity(value); value.id = 'fresh'; return value;"),
    answered(IDENTITY, "value.id = 'fresh'; return identity(value);"),
    answered(
      IDENTITY,
      "const same = identity(value) === value; value.id = same ? 'a' : 'b'; return value;",
    ),
    answered(
      'function tidy(text: string) { return text.trim(); }',
      "const copy = tidy(value.id); value.id = 'fresh'; value.extra = copy; return value;",
    ),
    answered(
      `function size(target: ${WIDE}) { return String(target.id).length; }`,
      "const length = size(value); value.id = 'fresh'; value.extra = String(length); return value;",
    ),
    answered(
      `function first(target: ${WIDE}, other: ${WIDE}) { return other; }`,
      "const alias = first(value, {id: 'other'}); alias.bad = 1; value.id = 'fresh'; return value;",
    ),
    answered(
      IDENTITY,
      "const alias = identity({id: 'other'}); alias.id = 'x'; value.id = 'fresh'; return value;",
    ),
  ])('keeps a member write into a parameter that no helper answers: %s', async (module) => {
    const app = await fixture(module);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
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
