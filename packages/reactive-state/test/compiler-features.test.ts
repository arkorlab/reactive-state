import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeEntities, jsxAttributeString, jsxTextChild } from '../src/compiler/entities.ts';
import { type Compiled, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  refusalOf,
  removed,
  source,
  typeCheck,
  variant,
} from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What the compiler carries over beyond the application it is first measured against, as it is
 * written: JSX the authority renders, written as React's transform writes it; slots of what the
 * browser's JSX renders on the authority; dynamic sites of what it renders with values of its local
 * states; the nodes a component is given (`children`); a state the authority starts from a prop;
 * hooks that call hooks, and a setter a hook returns; and which module of the application is
 * shared, or the authority's.
 */

/** A no-break space, which JSX decodes `&nbsp;` to and React keeps. */
const NBSP = String.fromCodePoint(0xa0);

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The declared helper form used by a list-key case. */
function declaredKeyHelper(what: string, type: string, answer: string): string {
  if (what === 'namespace arrow') {
    return `export const keyOf = (panel: { readonly panelId: string }): ${type} => ${answer};`;
  }
  if (what === 'public overload') {
    return file(
      'export function keyOf(panel: { readonly panelId: string }): string;',
      'export function keyOf(panel: { readonly panelId: string }): string | undefined { return panel.panelId; }',
    );
  }
  const generic = what === 'generic return' ? '<T>' : '';
  return `export function keyOf${generic}(panel: { readonly panelId: string }): ${type} { return ${answer}; }`;
}

const NOTICE = file(
  "import { Suspense } from 'react';",
  "import { projectHref } from '@/navigation';",
  '',
  'export default function Notice({ label, extra }: { label: string; extra: Record<string, string> }) {',
  '  return (',
  '    <>',
  '      <p title="a &amp; b',
  '         c" data-x=\'&quot;q&quot;\' hidden {...extra} xml:lang="en">',
  '        Hello&nbsp;world &copy;  2026',
  "        {' '}",
  '        next   line',
  '        {/* a comment */}',
  '      </p>',
  '      <Suspense fallback={<p>loading…</p>}>{label}</Suspense>',
  "      <a href={projectHref('p1')}>x</a>",
  '    </>',
  '  );',
  '}',
);

const BOARD = file(
  "import { useReactiveState } from 'framework/react';",
  "import { requireUser } from '@/auth';",
  "import TodoRow from '@/components/todo-row.reactive';",
  "import TodoCommands from '@/components/todo-commands.reactive';",
  '',
  'export default async function Board({ projectId, ids, initial: start }: {',
  '  projectId: string; ids: readonly string[]; initial: number;',
  '}) {',
  '  const user = await requireUser();',
  "  const admin = user.id === 'alice';",
  '  const [count, setCount] = useReactiveState(start);',
  '  const [open, setOpen] = useReactiveState(false);',
  '  return (',
  '    <section>',
  '      {admin && <TodoCommands projectId={projectId} id="t1" />}',
  '      <ul>{ids.map(id => <TodoRow key={id} projectId={projectId} id={id} filter="all" />)}</ul>',
  '      <button onClick={() => setCount(c => c + 1)}>{count}</button>',
  "      <button onClick={() => setOpen(o => !o)}>{open ? 'x' : 'y'}</button>",
  '    </section>',
  '  );',
  '}',
);

/** The application's own policy for panels: pure, shared by the authority and the browser. */
const PANELS_DOMAIN = file(
  'export type Panel = { readonly panelId: string; readonly todoId: string };',
  '',
  'export function initialPanelsFor(selectedId: string): readonly Panel[] {',
  `  return selectedId === '' ? [] : [{ panelId: \`initial:\${selectedId}\`, todoId: selectedId }];`,
  '}',
  '',
  'export function appendPanels(current: readonly Panel[], added: readonly Panel[]): readonly Panel[] {',
  '  return [...current, ...added];',
  '}',
);

/** A hook of a local state of its parameter, which handlers update by what they make at the event. */
const USE_PANELS = file(
  "import { useReactiveState } from 'framework/react';",
  "import { appendPanels, type Panel } from '@/domain/panels';",
  '',
  'export function usePanels(initialPanels: readonly Panel[]) {',
  '  const [panels, setPanels] = useReactiveState<readonly Panel[]>(initialPanels);',
  '  const openPanel = (todoId: string): void => {',
  '    const candidate: Panel = { panelId: crypto.randomUUID(), todoId };',
  '    setPanels(current => appendPanels(current, [candidate]));',
  '  };',
  '  const closeAll = (): void => {',
  '    setPanels([]);',
  '  };',
  '  return { panels, openPanel, closeAll };',
  '}',
);

/** A hook of a local state of a filter, which its callers may start from a literal. */
const USE_FILTER = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  '',
  'export function useFilter(initialFilter: TodoFilter) {',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  '  return { filter, setFilter };',
  '}',
);

const DESK = file(
  "import { initialPanelsFor } from '@/domain/panels';",
  "import { useFilter } from '@/hooks/use-filter';",
  "import { usePanels } from '@/hooks/use-panels';",
  '',
  'export default function Desk({ selectedId }: { selectedId: string }) {',
  '  const initialPanels = initialPanelsFor(selectedId);',
  "  const { filter, setFilter } = useFilter('all');",
  '  const { panels, openPanel, closeAll } = usePanels(initialPanels);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <button type="button" onClick={() => openPanel(\'t1\')}>open</button>',
  '      <button type="button" onClick={closeAll}>close {panels.length}</button>',
  '    </section>',
  '  );',
  '}',
);

const NESTED = file(
  "import { db } from '@/db';",
  "import { useTodo } from '@/hooks/use-todo';",
  '',
  'export default function Nested({ id }: { id: string }) {',
  '  const ref = db.todos.ref(id);',
  '  const { value, setValue, total, increase } = useTodo(ref.title, ref.estimate, 2);',
  "  const suffix = '!';",
  '  return (',
  '    <div>',
  '      <input value={value} onChange={event => setValue(event.currentTarget.value)} />',
  '      <button onClick={() => setValue(current => current + suffix)}>!</button>',
  '      <button onClick={increase}>{total}</button>',
  '    </div>',
  '  );',
  '}',
);

const USE_TODO = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { FieldRef } from '@arkorlab/reactive-state/program';",
  "import { useEstimate } from '@/hooks/use-estimate';",
  '',
  'export function useTodo(title: FieldRef<string>, estimate: FieldRef<number>, step: number) {',
  '  const [value, setValue] = useReactiveState(title);',
  '  const [total, increase] = useEstimate(estimate, step);',
  '  const [open, setOpen] = useReactiveState(false);',
  '  const rename = (next: string) => setValue(next);',
  '  return { value, setValue, total, increase, open, setOpen, rename };',
  '}',
);

/** A `'use client'` component that shows or hides what it is given, as an application writes one. */
const DISCLOSURE = file(
  "'use client';",
  '',
  "import { type ReactNode, useState } from 'react';",
  '',
  'export default function Disclosure({ title, children }: { title: string; children: ReactNode }) {',
  '  const [open, setOpen] = useState(true);',
  '  return (',
  '    <section>',
  '      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{title}</button>',
  '      <div hidden={!open}>{children}</div>',
  '    </section>',
  '  );',
  '}',
);

/** A reactive component of no state, which a site renders with a local state's value. */
const RESULTS = file(
  "import type { TodoFilter } from '@/navigation';",
  '',
  'export default function Results({ heading, projectId, filter }: {',
  '  heading: string; projectId: string; filter: TodoFilter;',
  '}) {',
  '  return <p data-project={projectId}>{heading}: {filter}</p>;',
  '}',
);

/** A workspace as the application's second version has one, in small: two sites, its children in a slot, and a memo of its own. */
const WORKSPACE = file(
  "import { Suspense, type ReactNode } from 'react';",
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import Disclosure from '@/controls/disclosure';",
  "import Results from '@/components/results.reactive';",
  "import TodoDetails from '@/components/todo-details.reactive';",
  '',
  'export default function Workspace({ projectId, initialFilter, initialSelectedId, choices, children }: {',
  '  projectId: string;',
  '  initialFilter: TodoFilter;',
  '  initialSelectedId: string;',
  '  choices: readonly { readonly id: string; readonly title: string }[];',
  '  children: ReactNode;',
  '}) {',
  '  const heading = projectId.toUpperCase();',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  '  const [selectedId, setSelectedId] = useReactiveState(initialSelectedId);',
  '  const [showDetails, setShowDetails] = useReactiveState(true);',
  "  const [memo, setMemo] = useReactiveState('');",
  "  const missing = selectedId !== '' && !choices.some(todo => todo.id === selectedId);",
  '  return (',
  '    <section>',
  '      <Disclosure title="totals">{children}</Disclosure>',
  "      <button type=\"button\" aria-pressed={filter === 'done'} onClick={() => setFilter('done')}>done</button>",
  '      <select value={selectedId} onChange={event => setSelectedId(event.currentTarget.value)}>',
  '        <option value="">none</option>',
  '        {missing && <option value={selectedId}>gone: {selectedId}</option>}',
  "        {choices.map(todo => <option key={todo.id} value={todo.id}>{todo.title || '?'}</option>)}",
  '      </select>',
  "      <button type=\"button\" onClick={() => setShowDetails(open => !open)}>{showDetails ? 'close' : 'open'}</button>",
  '      <textarea value={memo} onChange={event => setMemo(event.currentTarget.value)} />',
  '      <Suspense fallback={<p>loading</p>}>',
  '        <Results heading={heading} projectId={projectId} filter={filter} />',
  "        {showDetails && selectedId !== '' ? (",
  `          <TodoDetails key={\`\${projectId}:\${selectedId}\`}` +
    ' projectId={projectId} id={selectedId} />',
  '        ) : (',
  '          <p>closed</p>',
  '        )}',
  '      </Suspense>',
  '    </section>',
  '  );',
  '}',
);

/** A reactive component of no state that renders what it is given between its tags. */
const FRAME = file(
  "import type { ReactNode } from 'react';",
  '',
  'export default function Frame({ title, children }: { title: string; children: ReactNode }) {',
  '  return <main><h2>{title}</h2><div>{children}</div></main>;',
  '}',
);

/** A reactive component that gives another a reactive component between its tags. */
const FRAMED = file(
  "import Frame from '@/components/frame.reactive';",
  "import TodoDetails from '@/components/todo-details.reactive';",
  '',
  'export default function Framed({ projectId }: { projectId: string }) {',
  '  return <Frame title="framed"><TodoDetails projectId={projectId} id="t1" /></Frame>;',
  '}',
);

/** A component of state given an element as a prop typed as React's node, and another as React's element. */
const CARD = file(
  "import type * as React from 'react';",
  "import type { ReactNode } from 'react';",
  "import { useReactiveState } from 'framework/react';",
  '',
  'export default function Card({ header, footer, label }: {',
  '  header: ReactNode; footer: React.ReactElement | null; label: string;',
  '}) {',
  '  const [open, setOpen] = useReactiveState(false);',
  '  return (',
  '    <section>',
  '      {header}',
  '      <button type="button" onClick={() => setOpen(value => !value)}>{label}</button>',
  '      {open ? <p>open</p> : null}',
  '      <footer>{footer}</footer>',
  '    </section>',
  '  );',
  '}',
);

/** The guard of each site a program writes, as it writes it: between `guard: ` and `, render: `. */
function guardsIn(program: string): readonly string[] {
  const opening = 'guard: ';
  return program
    .split('\n')
    .filter((line) => line.includes(opening))
    .map((line) => line.slice(line.indexOf(opening) + opening.length, line.indexOf(', render: ')));
}

/** A reactive component at the site of each guard table row, of `id`, and another of `a`. */
const X = '<TodoDetails projectId={projectId} id={id} />';
const Y = '<TodoDetails projectId={projectId} id={a} />';

/** A component whose JSX renders `shown`, among states and a prop its conditions may read. */
function guarded(shown: string): string {
  return file(
    "import { useReactiveState } from 'framework/react';",
    "import TodoDetails from '@/components/todo-details.reactive';",
    '',
    'export default function Guarded({ projectId, x }: { projectId: string; x: number }) {',
    '  const [c, setC] = useReactiveState(true);',
    "  const [a, setA] = useReactiveState('');",
    '  const [b, setB] = useReactiveState(false);',
    "  const [id, setId] = useReactiveState('t1');",
    '  const [f, setF] = useReactiveState(true);',
    '  return (',
    '    <section>',
    "      <button type=\"button\" onClick={() => { setC(false); setA('a'); setB(true); setId('t2'); setF(false); }}>change</button>",
    `      {${shown}}`,
    '    </section>',
    '  );',
    '}',
  );
}

describe('the text of JSX, as React’s transform makes it a child', () => {
  it.each([
    ['one line, as it is written', 'a  b ', 'a  b '],
    ['white space alone, on one line', ' ', ' '],
    ['white space alone, over lines', '\n    \n  ', undefined],
    [
      'lines joined by one space, each trimmed where it meets another',
      '\n  Hello\n    world  \n',
      'Hello world',
    ],
    ['a tab as a space', 'a\tb', 'a b'],
    ['the trailing spaces of a last line kept', '\n  c  ', 'c  '],
    ['a reference decoded before the lines are read', '\n  a &amp; b&#32;\n  c', 'a & b c'],
  ])('%s', (_, raw, child) => {
    expect(jsxTextChild(raw)).toBe(child);
  });

  it('decodes XHTML’s references and a code point, and leaves what names none', () => {
    expect(decodeEntities('&lt;&nbsp;&copy;&hearts;&#65;&#x42;&#X43;&nosuch;&amp')).toBe(
      `<${NBSP}©♥AB&#X43;&nosuch;&amp`,
    );
  });

  it('folds a line break in an attribute’s string, with the white space after it, into a space', () => {
    expect(jsxAttributeString('a &amp; b\n   c\nd')).toBe('a & b c\nd');
  });
});

describe('the compiler, beyond the application as it is written', () => {
  const { apps, compile } = compilerApplications();

  async function compiling(
    files: Readonly<Record<string, string>>,
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application(files);
    apps.push(app);
    const compiled = compile(app);
    if (compiled.refusals.length > 0) {
      throw new Error(compiled.refusals.map((refusal) => refusal.message).join('\n'));
    }
    return { app, compiled };
  }

  // R109: compatible definitions retain flags, and reflection reports failure without throwing.
  it('takes compatible property definitions and defers unknown target constraints', async () => {
    const { compiled: taken } = await compiling({
      'components/defined-targets.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function DefinedTargets({ projectId, first, flag, possible }: { projectId: string; first: string; flag: boolean; possible: object }) {',
        '  const read = () => 1;',
        '  const options = { value: 1 };',
        '  const locked = Object.freeze({ x: 1 });',
        "  const [id, setId] = useReactiveState<string>(first === '' ? (",
        "    Object.defineProperty(Object.preventExtensions({ x: 1 }), 'x', { value: 2 }),",
        '    Object.defineProperties(Object.seal({ x: 1 }), { x: { value: 2, writable: false } }),',
        "    Object.defineProperty(locked, 'x', options),",
        "    Object.defineProperty(Object.freeze({ x: NaN }), 'x', { value: NaN }),",
        "    Object.defineProperty(Object.freeze({ x: -0 }), 'x', { value: -0 }),",
        "    Object.defineProperty(Object.freeze({ x: undefined }), 'x', { value: void 0 }),",
        "    Object.defineProperty(Object.seal(Object.defineProperty({}, 'x', { get: read, configurable: true })), 'x', { get: read }),",
        "    Object.defineProperty(Object.freeze({ get x() { return 1; } }), 'x', { set: undefined }),",
        "    Object.defineProperty(Object.defineProperty({ x: 1 }, 'x', { value: 2 }), 'x', { configurable: true }),",
        "    Object.defineProperty(Object.seal([1]), '0', { value: 2 }),",
        "    Object.defineProperty(Object.freeze([1]), 'length', { value: 1 }),",
        '    Object.defineProperties(Object.freeze({}), {}),',
        "    Reflect.defineProperty(Object.preventExtensions({}), 'x', { value: 1 }),",
        "    Reflect.defineProperty(Object.freeze({ x: 1 }), 'x', { value: 2 }),",
        '    Object.defineProperty(Object.preventExtensions({ ...possible }), first, { value: first }),',
        "    Object.defineProperty(Object.freeze({ x: 1 }), 'x', { enumerable: flag }),",
        "    Object.defineProperty(Object.freeze({ x: first }), 'x', { value: 'other' }),",
        "    Object.defineProperty(locked, 'x', { get value() { return first; } }),",
        "    (() => { const descriptor = { value: 2 }; Object.defineProperty(Object.freeze({ x: 1 }), 'x', descriptor, descriptor.value = 1); return first; })(),",
        '    (() => { const descriptors = { x: { value: 2 } }; Object.defineProperties(Object.freeze({ x: 1 }), descriptors, descriptors.x.value = 1); return first; })(),',
        "    'ok') : first);",
        '  return <section><button onClick={() => setId(first)}>change</button><TodoCommands projectId={projectId} id={id} /></section>;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes bound and inherited local writers from handlers while own members keep shadowing them', async () => {
    const { compiled: taken } = await compiling({
      'components/writer-invocations.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function WriterInvocations({ projectId, first }: { projectId: string; first: string }) {',
        '  const [draft, setDraft] = useReactiveState(first);',
        '  const write = setDraft.bind(null);',
        "  const preset = setDraft.bind(null, 'preset');",
        "  const call = 'call';",
        "  const apply = 'apply';",
        "  const bind = 'bind';",
        '  const rebound = write[bind](null);',
        "  const prototype = { reset: setDraft, read: () => 'inherited' };",
        '  const actions = { __proto__: prototype };',
        '  const { reset } = actions;',
        '  const nullPrototype = { __proto__: null, reset: setDraft };',
        "  const own = { __proto__: prototype, reset: () => 'own' };",
        "  const spread = { __proto__: prototype, ...{ reset: () => 'spread' } };",
        "  const pure = (() => 'pure').bind(null);",
        "  const custom = { bind() { return 'custom'; } };",
        "  const ordinary = { ['__proto__']: () => 'ordinary' };",
        "  const uncertain = { __proto__: first as unknown as null, reset: () => 'known own' };",
        '  return (',
        '    <section>',
        "      <p>{actions.read()}{own.reset()}{spread.reset()}{pure()}{custom.bind()}{ordinary['__proto__']()}{uncertain.reset()}</p>",
        '      <button type="button" onClick={() => {',
        "        write('bound'); preset(); rebound('rebound');",
        "        setDraft[call](null, 'call'); setDraft[apply](null, ['apply']);",
        "        actions.reset('inherited'); reset('destructured'); nullPrototype.reset('null');",
        '      }}>change</button>',
        '      <TodoCommands projectId={projectId} id={draft} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('keeps uncertain invocation keys inside handlers and pure members outside', async () => {
    const { compiled: taken } = await compiling({
      'components/uncertain-writers.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function UncertainWriters({ projectId, first }: { projectId: string; first: string }) {',
        '  const [draft, setDraft] = useReactiveState(first);',
        '  const write = setDraft;',
        "  const invoke = first as 'call';",
        "  const actions = { reset: setDraft, read: () => 'pure' };",
        '  return (',
        '    <section><p>{actions.read()}</p>',
        '      <button type="button" onClick={() => { setDraft[invoke](null, first); write[invoke](null, first); }}>change</button>',
        '      <TodoCommands projectId={projectId} id={draft} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('keeps constant text writer keys in handlers and pure computed siblings', async () => {
    const { compiled: taken } = await compiling({
      'components/constant-writer-keys.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function ConstantWriterKeys({ projectId, first }: { projectId: string; first: string }) {',
        '  const [draft, setDraft] = useReactiveState(first);',
        "  const prefix = 'c';",
        "  const call = prefix + 'all';",
        "  const apply = 'ap' + 'ply';",
        "  const bind = 'bi' + 'nd';",
        '  const write = setDraft[bind](null);',
        "  const actions = { ['re' + 'set']: setDraft, ['re' + 'ad']: () => 'pure' };",
        "  const indexed = [setDraft, () => 'index'];",
        '  return (',
        '    <section>',
        "      <p>{actions['re' + 'ad']()}{indexed[0 + 1]()}</p>",
        '      <button type="button" onClick={() => {',
        "        setDraft[call](null, 'call'); setDraft['c' + 'all'](null, 'inline');",
        "        setDraft[apply](null, ['apply']); write('bound'); actions['re' + 'set']('member');",
        '      }}>change</button>',
        '      <TodoCommands projectId={projectId} id={draft} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('renders JSX on the authority as React’s classic transform writes it', async () => {
    const { app, compiled } = await compiling({ 'components/notice.reactive.tsx': NOTICE });
    const program = output(compiled, app, 'components/notice.authority.mts');

    expect(program).toContain(
      [
        'export function evaluate({ label, extra }: { label: string; extra: Record<string, string> }, $: RenderScope) {',
        '  return (',
        '    $.h($.fragment, null,',
        String.raw`      $.h("p", { title: "a & b c", "data-x": "\"q\"", hidden: true, ...extra, "xml:lang": "en" },`,
        `        "Hello${NBSP}world ©  2026",`,
        "        ' ',",
        '        "next   line",',
        '      ),',
        '      $.h(Suspense, { fallback: $.h("p", null, "loading…") }, label),',
        '      $.h("a", { href: projectHref(\'p1\') }, "x"),',
        '    )',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(program).toContain('const Suspense = moduleRef("react", "Suspense");');
    expect(output(compiled, app, 'elements.ts')).toContain('"react#Suspense":');
  });

  it('hoists into a slot the largest expression around a reactive child that reads no value of the browser’s', async () => {
    const { app, compiled } = await compiling({ 'components/board.reactive.tsx': BOARD });
    const program = output(compiled, app, 'components/board.authority.mts');
    const client = output(compiled, app, 'components/board.client.tsx');

    // A prop the state starts from is the authority's to evaluate: a local state — a prop holds no
    // field — whose setter is React's, which the compile registers nothing of.
    expect(program).toContain(
      [
        '  return $.client({',
        '    props: {},',
        '    states: { count: start },',
        '    slots: {',
        '      s0: admin && $.h(TodoCommands, { projectId: projectId, id: "t1" }),',
        '      s1: ids.map(id => $.h(TodoRow, { key: id, projectId: projectId, id: id, filter: "all" })),',
        '    },',
        '  });',
      ].join('\n'),
    );
    expect(program).toContain('export const updaters = Object.freeze({});');
    expect(client).toContain('      {slotOf(part, "s0")}\n      <ul>{slotOf(part, "s1")}</ul>');
    expect(client).toContain(
      '  const [count, setCount] = useReactiveState(localOf<States["count"]>(part, "count"));',
    );
    expect(client).toContain('  const [open, setOpen] = useReactiveState(false);');
    expect(client).toContain('onClick={() => setCount(c => c + 1)}');
    expect(client).toContain('onClick={() => setOpen(o => !o)}');
    expect(client).not.toMatch(/admin|requireUser/u);
  });

  it('keys a hook’s states by each call, through a hook it calls, and registers what a setter it returns writes', async () => {
    const { app, compiled } = await compiling({
      'components/nested.reactive.tsx': NESTED,
      'hooks/use-todo.ts': USE_TODO,
    });
    const program = output(compiled, app, 'components/nested.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain(
      '    states: { "useTodo#0.value": ref.title, "useTodo#0.useEstimate#0.estimate": ref.estimate },',
    );
    expect(program).toContain(
      'export const writable = Object.freeze(["useTodo#0.value", "useTodo#0.useEstimate#0.estimate"]);',
    );
    expect(program).toMatch(/"u_[\da-f]{20}": \{ keys: \["useTodo#0\.value"\], kind: "set" \},/u);
    expect(program).toContain(
      'kind: "apply", apply: (current: string, { suffix }: { suffix: string }): string => current + suffix },',
    );
    expect(program).toContain(
      'keys: ["useTodo#0.useEstimate#0.estimate"], kind: "apply", apply: (current: number, { step }: { step: number }): number => addEstimate(current, step) },',
    );
    expect(output(compiled, app, 'components/nested.client.tsx')).toContain(
      '  const { value, setValue, total, increase } = useTodo(stateOf<States["useTodo#0.value"]>(part, "useTodo#0.value"), stateOf<States["useTodo#0.useEstimate#0.estimate"]>(part, "useTodo#0.useEstimate#0.estimate"), 2);',
    );
    expect(output(compiled, app, 'hooks/use-todo.ts')).toContain(
      "import { useEstimate } from './use-estimate';\n\nexport function useTodo(title: StateInput<string>, estimate: StateInput<number>, step: number) {",
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('renames an import an update reads where the component takes its name, an entry written short of it keeping its key', async () => {
    const { app, compiled } = await compiling({
      'components/limited.reactive.tsx': file(
        "import { db } from '@/db';",
        "import { useLimited } from '@/hooks/use-limited';",
        '',
        'export default function Limited({ id }: { id: string }) {',
        '  const ref = db.todos.ref(id);',
        '  const [total, increase] = useLimited(ref.estimate, 2);',
        "  const LIMIT = 'none';",
        '  return <button onClick={increase}>{total}{LIMIT}</button>;',
        '}',
      ),
      'hooks/use-limited.ts': file(
        "import { useReactiveState } from 'framework/react';",
        "import type { FieldRef } from '@arkorlab/reactive-state/program';",
        "import { LIMIT } from '@/domain/limits';",
        '',
        'export function useLimited(estimate: FieldRef<number>, step: number) {',
        '  const [total, setTotal] = useReactiveState(estimate);',
        '  const increase = () => setTotal((current) => Math.min(current + step, { LIMIT }.LIMIT));',
        '  return [total, increase] as const;',
        '}',
      ),
      'domain/limits.ts': file('export const LIMIT = 10;'),
    });
    const program = output(compiled, app, 'components/limited.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain('Math.min(current + step, { LIMIT: LIMIT$2 }.LIMIT)');
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('writes the type of what an update captures of an import of the types it is given, each an import type', async () => {
    const { app, compiled } = await compiling({
      'components/boxed.reactive.tsx': file(
        "import { db } from '@/db';",
        "import type { Box } from '@/domain/box';",
        "import type { TodoFilter } from '@/navigation';",
        "import { useTodo } from '@/hooks/use-todo';",
        '',
        'export default function Boxed({ id, box }: { id: string; box: Box<TodoFilter> }) {',
        '  const ref = db.todos.ref(id);',
        '  const { value, setValue } = useTodo(ref.title, ref.estimate, 2);',
        '  return (',
        '    <div>',
        '      <button onClick={() => setValue(current => current + box.value)}>!</button>',
        '      <p>{value}</p>',
        '    </div>',
        '  );',
        '}',
      ),
      'domain/box.ts': file('export type Box<T> = { readonly value: T };'),
      'hooks/use-todo.ts': USE_TODO,
    });
    const program = output(compiled, app, 'components/boxed.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain(
      "{ box }: { box: import('@/domain/box').Box<import('@/navigation').TodoFilter> }",
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('starts a hook’s local state of a value of the page’s, whose setter is React’s: it registers nothing, and an update captures what a handler made', async () => {
    const { app, compiled } = await compiling({
      'components/desk.reactive.tsx': DESK,
      'domain/panels.ts': PANELS_DOMAIN,
      'hooks/use-filter.ts': USE_FILTER,
      'hooks/use-panels.ts': USE_PANELS,
    });
    const program = output(compiled, app, 'components/desk.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    // What the server part builds of a prop and a shared helper, and a literal, typed as the hook's
    // parameter types the state, which the literal alone would widen.
    expect(program).toContain(
      [
        '    states: {',
        "      \"useFilter#0.filter\": 'all' as import('@/navigation').TodoFilter,",
        '      "usePanels#0.panels": initialPanels as readonly import(\'@/domain/panels\').Panel[],',
        '    },',
      ].join('\n'),
    );
    expect(program).toContain('export const writable = Object.freeze([]);');
    expect(program).toContain('export const updaters = Object.freeze({});');
    expect(output(compiled, app, 'hooks/use-panels.ts')).toContain(
      '    setPanels(current => appendPanels(current, [candidate]));',
    );
    // The copy takes the local state's first value, whose setter is React's own.
    expect(output(compiled, app, 'hooks/use-panels.ts')).toContain(
      'export function usePanels(initialPanels: LocalStateInput<readonly Panel[]>) {',
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('starts a hook’s local state of what the server part destructures of a prop', async () => {
    const destructured = [
      'export default function Desk({ options }: { options: { readonly selectedId: string } }) {',
      '  const { selectedId } = options;',
    ].join('\n');
    const { app, compiled } = await compiling({
      'components/desk.reactive.tsx': DESK.replace(
        'export default function Desk({ selectedId }: { selectedId: string }) {',
        () => destructured,
      ),
      'domain/panels.ts': PANELS_DOMAIN,
      'hooks/use-filter.ts': USE_FILTER,
      'hooks/use-panels.ts': USE_PANELS,
    });
    const program = output(compiled, app, 'components/desk.authority.mts');

    expect(program).toContain(
      '      "usePanels#0.panels": initialPanels as readonly import(\'@/domain/panels\').Panel[],',
    );
    expect(program).toContain('export const updaters = Object.freeze({});');
  });

  it('starts a hook’s local state of what the server part hands to the language’s functions and to methods that read, and of a prop it hands to any', async () => {
    const read = [
      '  const initialPanels = [...initialPanelsFor(selectedId)];',
      '  JSON.stringify(initialPanels);',
      '  initialPanels.map((panel) => panel.todoId);',
    ].join('\n');
    const { app, compiled } = await compiling({
      'components/desk.reactive.tsx': DESK.replace(
        '  const initialPanels = initialPanelsFor(selectedId);',
        () => read,
      ),
      'domain/panels.ts': PANELS_DOMAIN,
      'hooks/use-filter.ts': USE_FILTER,
      'hooks/use-panels.ts': USE_PANELS,
    });
    const program = output(compiled, app, 'components/desk.authority.mts');

    expect(program).toContain(
      '      "usePanels#0.panels": initialPanels as readonly import(\'@/domain/panels\').Panel[],',
    );
    expect(program).toContain('export const updaters = Object.freeze({});');
  });

  it('starts a state of what `Array.from` makes of a length, each element its function answers, of `Array` given its elements, and of what `Object.assign` writes on an object written there', async () => {
    const { app, compiled } = await compiling({
      'components/ranges.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Ranges({ projectId, first }: { projectId: string; first: string }) {',
        '  const [ids, setIds] = useReactiveState(Array.from({ length: 2 }, (_, index) => first + String(index)));',
        '  const [pair, setPair] = useReactiveState(Array(first, first));',
        '  const [merged, setMerged] = useReactiveState(Object.assign({}, { id: first }));',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setIds([]); setPair([]); setMerged({ id: \'\' }); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/ranges.authority.mts');

    expect(program).toContain(
      'ids: Array.from({ length: 2 }, (_, index) => first + String(index))',
    );
    expect(program).toContain('pair: Array(first, first)');
    expect(program).toContain('merged: Object.assign({}, { id: first })');
  });

  it('starts a state of members of what the code writes, of `Reflect.get`, of an object of no prototype, of a constant’s array the code adds to, of the language’s constants and text’s length, and of what `Object.assign` copies of no entry `__proto__`', async () => {
    const { app, compiled } = await compiling({
      'components/members.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Members({ projectId, first }: { projectId: string; first: string }) {',
        '  const items = [first];',
        '  items.push(first);',
        "  const [named, setNamed] = useReactiveState(Reflect.get({ first }, 'first'));",
        '  const [bare, setBare] = useReactiveState(Object.setPrototypeOf({ first }, null));',
        '  const [later, setLater] = useReactiveState(items[1]);',
        '  const [count, setCount] = useReactiveState([first, first].length);',
        "  const [pi, setPi] = useReactiveState(first === '' ? Math.PI : 'abc'.length);",
        '  const [copied, setCopied] = useReactiveState(Object.assign({}, { first }, [first]));',
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setNamed(''); setBare({ first: '' }); setLater(''); setCount(0); setPi(0); setCopied({ first: '' }); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/members.authority.mts');

    expect(program).toContain("named: Reflect.get({ first }, 'first')");
    expect(program).toContain('bare: Object.setPrototypeOf({ first }, null)');
    expect(program).toContain('later: items[1]');
    expect(program).toContain('count: [first, first].length');
    expect(program).toContain("pi: first === '' ? Math.PI : 'abc'.length");
    expect(program).toContain('copied: Object.assign({}, { first }, [first])');
  });

  it('starts a state of what `Math`’s approximated functions make of what the code writes, finite', async () => {
    const { app, compiled } = await compiling({
      'components/rounded.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Rounded({ projectId, first }: { projectId: string; first: string }) {',
        "  const [grown, setGrown] = useReactiveState(first === '' ? Math.exp(1) + Math.log(2) : Math.pow(2, 10));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setGrown(0)}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/rounded.authority.mts');

    expect(program).toContain("grown: first === '' ? Math.exp(1) + Math.log(2) : Math.pow(2, 10)");
  });

  it('starts a state of constants the code puts JSON into after it declares them, of what `JSON.parse` makes of text it writes, and of what `JSON.stringify` writes of an object of no `toJSON`', async () => {
    const { app, compiled } = await compiling({
      'components/built.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Built({ projectId, first }: { projectId: string; first: string }) {',
        '  const counts: Record<string, number> = { all: 0 };',
        '  counts.all += 1;',
        '  const [built, setBuilt] = useReactiveState((() => { const rows: string[] = []; rows.push(first); const box: Record<string, unknown> = { rows }; box.label = first; return box; })());',
        '  const [counted, setCounted] = useReactiveState(counts);',
        "  const [parsed, setParsed] = useReactiveState<number>(first === '' ? JSON.parse('1e3') : 0);",
        '  const [text, setText] = useReactiveState(JSON.stringify({ first, at: new Date(0) }));',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setBuilt({}); setCounted({}); setParsed(0); setText(\'\'); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/built.authority.mts');

    expect(program).toContain('built: (() => { const rows: string[] = []; rows.push(first);');
    expect(program).toContain('counted: counts');
    expect(program).toContain("parsed: first === '' ? JSON.parse('1e3') : 0");
    expect(program).toContain('text: JSON.stringify({ first, at: new Date(0) })');
  });

  it('starts a state of JSON replacers that return, may return before throwing, or defer their body, and leaves non-replacers uncalled', async () => {
    const { app, compiled } = await compiling({
      'domain/replacers.ts': file(
        "const ESCAPED = 'safe';",
        'export function returning(_key: string, value: unknown) {',
        '  decodeURIComponent(ESCAPED);',
        '  return value;',
        '}',
      ),
      'components/replaced.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { returning } from '@/domain/replacers';",
        '',
        'export default function Replaced({ projectId, first }: { projectId: string; first: string }) {',
        "  const ESCAPED = '%';",
        '  const replacer = (_key: string, value: unknown) => value;',
        '  const [imported, setImported] = useReactiveState<string>(JSON.stringify({ first }, returning));',
        '  const [returned, setReturned] = useReactiveState<string>(JSON.stringify({ first }, replacer));',
        "  const [conditional, setConditional] = useReactiveState<string>(JSON.stringify({ first }, (_key, value) => { if (value === 'bad') { throw new Error('bad'); } return value; }));",
        "  const [deferred, setDeferred] = useReactiveState<string>(JSON.stringify({ first }, function* () { throw new Error('later'); }));",
        "  const [spaced, setSpaced] = useReactiveState<string>(JSON.stringify({ first }, null, () => { throw new Error('uncalled'); }));",
        "  const [listed, setListed] = useReactiveState<string>(JSON.stringify({ first }, ['first']));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setImported(first); setReturned(first); setConditional(first); setDeferred(first); setSpaced(first); setListed(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={imported + returned + conditional + deferred + spaced + listed} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/replaced.authority.mts');

    expect(program).toContain('imported: JSON.stringify({ first }, returning)');
    expect(program).toContain('returned: JSON.stringify({ first }, replacer)');
    expect(program).toContain('conditional: JSON.stringify({ first }, (_key, value) =>');
    expect(program).toContain('deferred: JSON.stringify({ first }, function* ()');
    expect(program).toContain(
      "spaced: JSON.stringify({ first }, null, () => { throw new Error('uncalled'); })",
    );
    expect(program).toContain("listed: JSON.stringify({ first }, ['first'])");
  });

  it.each([
    {
      what: 'valid descriptors and bytes, including constructor and input aliases',
      declaration:
        'const wasm = globalThis.WebAssembly; const Made = wasm.Memory; const initial = 0.5; const options = { initial, maximum: 1 }; const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); const Module = wasm.Module;',
      called:
        "new Made(options), new wasm.Memory({ initial: 0, maximum: undefined }), new wasm.Table({ element: 'externref', initial: 0 }), new wasm.Table({ element: 'eqref', initial: 0 }), new Module(bytes), new wasm.Instance(new Module(bytes), {})",
    },
    {
      what: 'inputs whose contents or descriptor entries remain unknown until runtime',
      declaration: 'const options = { initial: 0 };',
      called:
        "new WebAssembly.Memory({ ...options, initial: Number(first) }), new WebAssembly.Module(new Uint8Array([Number(first)])), new WebAssembly.Module(first as never), new WebAssembly.Table({ element: first as 'externref', initial: 0 }), new WebAssembly.Instance(first as never, first as never)",
    },
    {
      what: 'an application object whose constructor names match WebAssembly',
      declaration:
        'const WebAssembly = { Memory: class { constructor(_descriptor: unknown) {} }, Module: class { constructor(_bytes: unknown) {} } }; const Made = WebAssembly.Memory;',
      called: 'new Made({ initial: -1 }), new WebAssembly.Module([])',
    },
    {
      what: 'a memory descriptor repaired by its earlier initial conversion',
      declaration: '',
      called:
        '(() => { const d = { initial: { valueOf() { d.maximum = 1; return 0; } }, maximum: -1 }; new WebAssembly.Memory(d as never); })()',
    },
    {
      what: 'a table descriptor repaired by its earlier element conversion',
      declaration: '',
      called:
        "(() => { const d = { element: { toString() { d.initial = 0; return 'externref'; } }, initial: -1 }; new WebAssembly.Table(d as never); })()",
    },
    {
      what: 'a descriptor repaired while an ignored extra argument is evaluated',
      declaration: '',
      called: '(() => { const d = { initial: -1 }; new WebAssembly.Memory(d, d.initial = 0); })()',
    },
    {
      what: 'module bytes repaired while an explicitly undefined options argument is evaluated',
      declaration: '',
      called:
        '(() => { const bytes = new Uint8Array([1, 97, 115, 109, 1, 0, 0, 0]); new WebAssembly.Module(bytes, void (bytes[0] = 0)); })()',
    },
  ])('starts a state after WebAssembly constructions of $what', async ({ declaration, called }) => {
    const { app, compiled } = await compiling({
      'components/wasm.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Wasm({ projectId, first }: { projectId: string; first: string }) {',
        `  ${declaration}`,
        `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${called}, 'ok') : first);`,
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelected(first)}>reset</button>',
        '      <TodoCommands projectId={projectId} id={selected} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/wasm.authority.mts')).toContain(
      `selected: first === '' ? (${called}, 'ok') : first`,
    );
  });

  it.each([
    [
      'const globals = globalThis; const decode = globals.decodeURIComponent; const text = String; const Made = Uint8Array;',
      "decode('%25'), text.fromCodePoint(65), new Made(1)",
    ],
    [
      "const decodeURIComponent = (_text: string) => 'safe'; const decode = decodeURIComponent;",
      "decode('%')",
    ],
    [
      "const String = { fromCodePoint: (_point: number) => 'safe' }; const make = String.fromCodePoint;",
      'make(0x110000)',
    ],
    [
      '',
      "(() => { let decode = decodeURIComponent; decode = (_text: string) => 'safe'; return decode('%'); })()",
    ],
  ])('starts a state after safe calls through global aliases: %s', async (declaration, called) => {
    const { app, compiled } = await compiling({
      'components/aliased-globals.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function AliasedGlobals({ projectId, first }: { projectId: string; first: string }) {',
        `  ${declaration}`,
        `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${called}, 'ok') : first);`,
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelected(first)}>reset</button>',
        '      <TodoCommands projectId={projectId} id={selected} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/aliased-globals.authority.mts')).toContain(
      `selected: first === '' ? (${called}, 'ok') : first`,
    );
  });

  it('starts a state after setting object or null prototypes and reflecting valid callable and constructor targets', async () => {
    const { app, compiled } = await compiling({
      'components/reflected-targets.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function ReflectedTargets({ projectId, first }: { projectId: string; first: string }) {',
        "  const [reflected, setReflected] = useReactiveState<string>(first === '' ? (Object.setPrototypeOf({}, null), Object.setPrototypeOf({}, {}), Reflect.setPrototypeOf({}, null), Reflect.setPrototypeOf({}, {}), Object.setPrototypeOf(1, null), Reflect.construct(class {}, []), Reflect.construct(function () {}, [], class {}), Reflect.construct(function () {}, [], function () {}), Reflect.construct(function () {}, { length: 0 } as never), Reflect.apply(() => 1, null, []), Reflect.apply(function () {}, null, []), Reflect.apply(async function () {}, null, []), Reflect.apply(function* () {}, null, []), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setReflected(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={reflected} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/reflected-targets.authority.mts');

    expect(program).toContain("reflected: first === '' ? (Object.setPrototypeOf({}, null)");
    expect(program).toContain('Reflect.construct(function () {}, [], class {})');
    expect(program).toContain('Reflect.apply(async function () {}, null, [])');
  });

  it('starts a state of custom tagged templates that receive raw symbol substitutions', async () => {
    const { app, compiled } = await compiling({
      'components/tagged-symbols.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function TaggedSymbols({ projectId, first }: { projectId: string; first: string }) {',
        `  const [tagged, setTagged] = useReactiveState<string>(first === '' ? ((_parts: TemplateStringsArray, value: symbol) => typeof value)\`\${Symbol('x')}\` : first);`,
        `  const [member, setMember] = useReactiveState<string>(first === '' ? ({ raw(_parts: TemplateStringsArray, value: symbol) { return String(value); } }).raw\`\${Symbol.iterator}\` : first);`,
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setTagged(first); setMember(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={tagged + member} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/tagged-symbols.authority.mts');

    expect(program).toContain(
      "tagged: first === '' ? ((_parts: TemplateStringsArray, value: symbol) => typeof value)",
    );
    expect(program).toContain('value: symbol) { return String(value); } }).raw');
  });

  it('starts a state of empty typed arrays, ordinary views and uncertain locking targets', async () => {
    const { app, compiled } = await compiling({
      'components/view-locking.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function ViewLocking({ projectId, first, length }: { projectId: string; first: string; length: number }) {',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (Object.freeze(new Uint8Array()), Object.seal(new Uint8Array(0)), Object.freeze(new Uint8Array(new ArrayBuffer(4), 4)), Object.freeze(new Uint8Array(new ArrayBuffer(4), 0, 0)), Object.freeze(new DataView(new ArrayBuffer(1))), Object.seal(new DataView(new ArrayBuffer(1))), Object.freeze(new ArrayBuffer(1)), Object.freeze(1), Object.seal(null), Object.freeze(Uint8Array.of()), Object.freeze(Uint8Array.from([])), Object.freeze(Uint8Array.of.call(Uint8Array)), Object.freeze(new Uint8Array(length)), Object.preventExtensions(new Uint8Array(1)), 'ok') : first);",
        '  const [detached, setDetached] = useReactiveState<string>((() => { const view = new Uint8Array(1); Object.freeze(view, structuredClone(view.buffer, { transfer: [view.buffer] })); return first; })());',
        '  const [earlier, setEarlier] = useReactiveState<string>((() => { const view = new Uint8Array(1); structuredClone(view.buffer, { transfer: [view.buffer] }); Object.freeze(view); return first; })());',
        '  const [resized, setResized] = useReactiveState<string>((() => { const buffer = new ArrayBuffer(1, { maxByteLength: 1 }); const view = new Uint8Array(buffer); buffer.resize(0); Object.freeze(view); return first; })());',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setSelected(first); setDetached(first); setEarlier(first); setResized(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={selected + detached + earlier + resized} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/view-locking.authority.mts');

    expect(program).toContain('Object.freeze(new DataView(new ArrayBuffer(1)))');
    expect(program).toContain('Object.freeze(Uint8Array.of.call(Uint8Array))');
  });

  it('freezes fresh typed arrays made empty by earlier changes to their aliased input arrays', async () => {
    const { app, compiled } = await compiling({
      'components/changed-view-inputs.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        '',
        'export default function ChangedViewInputs({ projectId, first }: { projectId: string; first: string }) {',
        '  const input = [1];',
        '  Array.prototype.splice.call(input, 0);',
        '  const iteratedInput = [1];',
        '  iteratedInput[Symbol.iterator] = function* () {};',
        '  const extraInput = [1];',
        "  const [constructed, setConstructed] = useReactiveState<string>(first === '' ? (Object.freeze(new Uint8Array(input)), 'ok') : first);",
        "  const [factory, setFactory] = useReactiveState<string>(first === '' ? (Object.freeze(Uint8Array.from(input)), 'ok') : first);",
        "  const [iterated, setIterated] = useReactiveState<string>(first === '' ? (Object.freeze(new Uint8Array(iteratedInput)), 'ok') : first);",
        "  const [extra, setExtra] = useReactiveState<string>(first === '' ? (Object.freeze(new Uint8Array(extraInput, extraInput.length = 0)), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setConstructed(first); setFactory(first); setIterated(first); setExtra(first); }}>clear</button>',
        '      <p>{projectId + constructed + factory + iterated + extra}</p>',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/changed-view-inputs.authority.mts')).toContain(
      'Object.freeze(new Uint8Array(input))',
    );
  });

  it('starts a state of deletions that are configurable, missing or unknown', async () => {
    const { app, compiled } = await compiling({
      'components/delete-values.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function DeleteValues({ projectId, first }: { projectId: string; first: string }) {',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (delete ({ value: 1 } as any).value, delete (Object.freeze({}) as any).missing, delete (Object.freeze({ __proto__: { value: 1 } }) as any).value, delete (Object.preventExtensions({ value: 1 }) as any).value, delete (Object.seal([, 1]) as any)[0], delete ('x' as any)['-0'], delete (Object.defineProperty({}, 'value', { value: 1, configurable: true }) as any).value, delete (Object.defineProperty({ value: 1 }, 'value', { value: 2 }) as any).value, delete (Object.create(null, { value: { value: 1, configurable: true } }) as any).value, delete (Object.create(null, { value: { __proto__: { configurable: true }, value: 1 } }) as any).value, delete (null as any)?.value, (() => { const held = { value: 1 }; delete (Object.freeze(held, delete held.value) as any).value; })(), (() => { const descriptor = { value: 1, configurable: false }; delete (Object.defineProperty({}, 'value', descriptor, descriptor.configurable = true) as any).value; })(), (() => { const held = { value: 1 }; delete (Object.freeze(Object.defineProperty(held, 'other', { get configurable() { delete held.value; return true; } })) as any).value; })(), (() => { const held = { value: 1 }; delete (Object.freeze(Object.defineProperties(held, { get other() { delete held.value; return { value: 2 }; } })) as any).value; })(), delete (Object.freeze({ value: 1 }) as any)[first], 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelected(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={selected} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/delete-values.authority.mts');

    expect(program).toContain('delete (Object.freeze({}) as any).missing');
    expect(program).toContain('delete (Object.preventExtensions({ value: 1 }) as any).value');
  });

  it('starts a state of generic Date toJSON borrowed onto objects and classes with toISOString', async () => {
    const { app, compiled } = await compiling({
      'components/date-json.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function DateJson({ projectId, first }: { projectId: string; first: string }) {',
        "  const [deferred, setDeferred] = useReactiveState<string>(first === '' ? (Date.prototype.toJSON.call({ toISOString: function* () { throw new Error('later'); } } as unknown as Date), Date.prototype.toJSON.call({ toISOString: async () => 'later' } as unknown as Date), 'ok') : first);",
        "  const [called, setCalled] = useReactiveState<string>(first === '' ? (Date.prototype.toJSON.call({ toISOString() { return 'plain'; } }), 'ok') : first);",
        "  const [applied, setApplied] = useReactiveState<string>(first === '' ? (Date.prototype.toJSON.apply({ toISOString: () => 'arrow' }, []), 'ok') : first);",
        "  const [reflected, setReflected] = useReactiveState<string>(first === '' ? (Reflect.apply(Date.prototype.toJSON, new class { toISOString() { return 'class'; } }, []), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setCalled(first); setApplied(first); setReflected(first); setDeferred(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={called + applied + reflected + deferred} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/date-json.authority.mts');

    expect(program).toContain("called: first === '' ? (Date.prototype.toJSON.call({ toISOString()");
    expect(program).toContain('Reflect.apply(Date.prototype.toJSON, new class');
  });

  it('starts a state of generic Date toJSON returning null for non-finite numeric primitives', async () => {
    const { app, compiled } = await compiling({
      'components/nonfinite-date-json.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function NonfiniteDateJson({ projectId, first }: { projectId: string; first: string }) {',
        "  const [called, setCalled] = useReactiveState<string>(first === '' ? (Date.prototype.toJSON.call(NaN), Date.prototype.toJSON.apply(Infinity, []), Reflect.apply(Date.prototype.toJSON, -Infinity, []), Date.prototype.toJSON.call({ valueOf() { return Infinity; } }), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setCalled(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={called} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/nonfinite-date-json.authority.mts');

    expect(program).toContain("called: first === '' ? (Date.prototype.toJSON.call(NaN)");
    expect(program).toContain('Date.prototype.toJSON.call({ valueOf() { return Infinity; } })');
  });

  it('starts a state of valid Set composition and relation arguments, including Maps, custom set-like objects and coerced sizes, and leaves own methods alone', async () => {
    const { app, compiled } = await compiling({
      'components/sets.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Sets({ projectId, first }: { projectId: string; first: string }) {',
        '  const setLike = { size: 0, has: () => false, keys: () => [].values() };',
        "  const own = { union(_value: null) { return 'own'; } };",
        "  const [validSets, setValidSets] = useReactiveState<string>(first === '' ? (new Set().union(new Set()), new Set().intersection(new Map()), new Set().difference(setLike), new Set().symmetricDifference(setLike), new Set().isSubsetOf(setLike), new Set().isSupersetOf(setLike), new Set().isDisjointFrom(setLike), new Set().union({ size: '0', has() { return false; }, keys() { return [].values(); } }), new Set().union({ size: -0.5, has() { return false; }, keys() { return [].values(); } }), new Set().union({ size: null, has() { return false; }, keys() { return [].values(); } } as never), new Set().union({ size: Infinity, has() { return false; }, keys() { return [].values(); } }), own.union(null), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setValidSets(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={validSets} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/sets.authority.mts');

    expect(program).toContain("validSets: first === '' ? (new Set().union(new Set())");
    expect(program).toContain('new Set().isDisjointFrom(setLike)');
    expect(program).toContain("own.union(null), 'ok') : first");
  });

  it('starts a state of toLocaleString receivers that ignore locale arguments, including boxed values and arrays without numeric elements', async () => {
    const { app, compiled } = await compiling({
      'components/ignored-locales.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function IgnoredLocales({ projectId, first }: { projectId: string; first: string }) {',
        "  const text = 'x';",
        "  const [ignored, setIgnored] = useReactiveState<string>(first === '' ? (text.toLocaleString('bad_locale'), /x/.toLocaleString('bad_locale'), Symbol('x').toLocaleString(null as never), true.toLocaleString('bad_locale'), new String('x').toLocaleString('bad_locale'), new Boolean(true).toLocaleString('bad_locale'), new RegExp('x').toLocaleString('bad_locale'), ['x'].toLocaleString('bad_locale'), [].toLocaleString('bad_locale'), new Uint8Array(0).toLocaleString('bad_locale'), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setIgnored(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={ignored} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/ignored-locales.authority.mts')).toContain(
      "ignored: first === '' ? (text.toLocaleString('bad_locale')",
    );
  });

  it('takes wrapped ordinary methods whose nested functions have their own this and object arrows with no receiver mutation', async () => {
    const { app, compiled } = await compiling({
      'domain/todo-filter.ts': file(
        "import type { TodoFilter } from '@/navigation';",
        'const counter = { n: 0, bump: ((function () { const local = { n: 0 }; const nested = function (this: { n: number }) { return ++this.n; }; return nested.call(local); }) as () => number), stable: ((() => 1) as () => number) };',
        'export function normalizeFilter(value: string): TodoFilter {',
        '  const count = counter.bump() + counter.stable();',
        "  return count > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';",
        '}',
      ),
    });

    expect(output(compiled, app, 'components/project-workspace.authority.mts')).toContain(
      'normalizeFilter',
    );
  });

  it('starts a state of Error options whose cause returns, is overwritten, or can be removed before it is read', async () => {
    const { app, compiled } = await compiling({
      'components/error-getters.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function ErrorGetters({ projectId, first }: { projectId: string; first: string }) {',
        "  const [converted, setConverted] = useReactiveState<string>((() => { const options = { get cause() { throw new Error('deleted'); } }; const message = { toString() { delete options.cause; return 'x'; } }; new Error(message as unknown as string, options); return first; })());",
        "  const [extra, setExtra] = useReactiveState<string>((() => { const options = { get cause() { throw new Error('deleted'); } }; Error('x', options, (() => { delete options.cause; })()); return first; })());",
        "  const [errors, setErrors] = useReactiveState<string>(first === '' ? (new Error('x', { get cause() { return first; } }), Error('x', { get ignored() { throw new Error('ignored'); } }), new AggregateError([], 'x', { get ignored() { throw new Error('ignored'); } }), new Error('x', { get cause() { throw new Error('overwritten'); }, cause: first }), new TypeError('x', { get cause() { throw new Error('overwritten'); }, get cause() { return first; } }), Error('x', { set cause(_value) { throw new Error('uninvoked'); } }), Error('x', { get cause() { throw new Error('overwritten'); }, ...{ cause: first } }), new Error('x', { get [Symbol.iterator]() { throw new Error('ignored'); } }), new Error('x', { get cause() { return () => { throw new Error('deferred'); }; } }), (() => new Error('x', { get cause() { throw new Error('deferred'); } })), (null as any)?.[new Error('x', { get cause() { throw new Error('skipped'); } })], 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setErrors(first); setConverted(first); setExtra(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={errors + converted + extra} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/error-getters.authority.mts')).toContain(
      "errors: first === '' ? (new Error(",
    );
  });

  it('starts a state of platform options with returning, ignored, overwritten, deferred, or interacting getters', async () => {
    const { app, compiled } = await compiling({
      'components/platform-getters.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function PlatformGetters({ projectId, first }: { projectId: string; first: string }) {',
        "  const [skipped, setSkipped] = useReactiveState<string>(first === '' ? ((null as any)?.[new Response(null, { get status() { throw new Error('skipped'); } })], (null as any)?.(new Event('x', { get bubbles() { throw new Error('skipped'); } })), 'ok') : first);",
        "  const [converted, setConverted] = useReactiveState<string>((() => { const options = { headers: { [Symbol.iterator]() { delete options.status; return [][Symbol.iterator](); } }, get status() { throw new Error('deleted'); } }; new Response(null, options); return first; })());",
        "  const [extra, setExtra] = useReactiveState<string>((() => { const options = { get status() { throw new Error('deleted'); } }; new Response(null, options, (() => { delete options.status; })()); return first; })());",
        "  const [platform, setPlatform] = useReactiveState<string>(first === '' ? (new Response(null, { get status() { return 200; } }), new Response(null, { get unused() { throw new Error('ignored'); } }), new Request('https://example.com/', { get method() { return 'GET'; }, get unused() { throw new Error('ignored'); } }), new Event('x', { get bubbles() { delete this.cancelable; return false; }, get cancelable() { throw new Error('deleted'); } }), new Event('x', { get unused() { throw new Error('ignored'); } }), new Blob([], { get unused() { throw new Error('ignored'); } }), new File([], 'x', { get unused() { throw new Error('ignored'); } }), new Response(null, { get status() { throw new Error('replaced'); }, status: 200 }), new Response(null, { get status() { throw new Error('replaced'); }, ...{ status: 200 } }), new Response(null, { get [Symbol.iterator]() { throw new Error('ignored'); } }), (() => new Response(null, { get status() { throw new Error('deferred'); } })), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setPlatform(first); setConverted(first); setExtra(first); setSkipped(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={platform + converted + extra + skipped} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/platform-getters.authority.mts')).toContain(
      "platform: first === '' ? (new Response(",
    );
  });

  it.each([
    "'value' in { value: first }",
    "'length' in new String(first)",
    'first instanceof Object',
    'first instanceof ({ [Symbol.hasInstance](value: unknown) { return value === first; } } as Function)',
    "'value' in (first as unknown as { value: string })",
    'first instanceof (first as unknown as Function)',
  ])(
    'starts a state of a binary membership operator with an object or unknown right operand: %s',
    async (expression) => {
      const { app, compiled } = await compiling({
        'components/binary-membership.reactive.tsx': file(
          "import { useReactiveState } from 'framework/react';",
          "import TodoCommands from '@/components/todo-commands.reactive';",
          'export default function BinaryMembership({ projectId, first }: { projectId: string; first: string }) {',
          `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, 'ok') : first);`,
          '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
          '}',
        ),
      });

      expect(output(compiled, app, 'components/binary-membership.authority.mts')).toContain(
        expression,
      );
    },
  );

  it.each(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])(
    'starts a state of an invalid date locale method ignoring locales and option getters: %s',
    async (method) => {
      const { app, compiled } = await compiling({
        'components/invalid-date-locales.reactive.tsx': file(
          "import { useReactiveState } from 'framework/react';",
          "import TodoCommands from '@/components/todo-commands.reactive';",
          'export default function InvalidDateLocales({ projectId, first }: { projectId: string; first: string }) {',
          '  const invalid = new Date(NaN);',
          `  const [selected, setSelected] = useReactiveState<string>(first === '' ? invalid.${method}('bad_locale', { get year() { throw new Error('unused'); } } as never) : first);`,
          '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
          '}',
        ),
      });

      expect(output(compiled, app, 'components/invalid-date-locales.authority.mts')).toContain(
        `invalid.${method}('bad_locale'`,
      );
    },
  );

  it.each([
    'new RegExp(pattern)',
    'RegExp(pattern)',
    'new RegExp(RegExp(/a/g))',
    'new RegExp(load())',
  ])('starts a state with global flags inherited by a copied pattern: %s', async (copied) => {
    const { app, compiled } = await compiling({
      'components/copied-pattern.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function CopiedPattern({ projectId, first }: { projectId: string; first: string }) {',
        '  const pattern = /a/g;',
        '  const load = () => /a/g;',
        `  const [selected, setSelected] = useReactiveState<string>(first === '' ? first.replaceAll(${copied}, 'x') : first);`,
        '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/copied-pattern.authority.mts')).toContain(
      `first.replaceAll(${copied}, 'x')`,
    );
  });

  it('keeps copied global patterns with undefined flags, explicit overrides, unknown flags and changed source aliases', async () => {
    const { app, compiled } = await compiling({
      'components/pattern-flags.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function PatternFlags({ projectId, first }: { projectId: string; first: string }) {',
        '  const pattern = /a/g;',
        '  const flags = undefined;',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? first.replaceAll(new RegExp(/a/g, undefined), 'x') + first.replaceAll(RegExp(/a/g, void 0), 'x') + first.replaceAll(new RegExp(pattern, flags), 'x') + first.replaceAll(new RegExp(/a/, 'g'), 'x') + first.replaceAll(new RegExp('a', first), 'x') + (() => { const changed = /a/; changed.compile('a', 'g'); return first.replaceAll(new RegExp(changed), 'x'); })() : first);",
        '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/pattern-flags.authority.mts')).toContain(
      'new RegExp(pattern, flags)',
    );
  });

  it('starts a state from valid or unknown spread tuples and preserves changed array iterators', async () => {
    const { app, compiled } = await compiling({
      'components/spread-arguments.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function SpreadArguments({ projectId, first }: { projectId: string; first: string }) {',
        '  const args = [0] as const;',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (new Array(...args), String.fromCodePoint(...([65, 66] as const)), new WeakRef(...([{}] as const)), Reflect.ownKeys(...([{}] as const)), new Array(...[]), new Array(...[,]), new Array(...first.split('').map(() => 0)), (() => { const input = [-1]; input[Symbol.iterator] = function* () { yield 0; }; new Array(...input); })(), (() => { const input = [0x110000]; String.fromCodePoint((() => { input[0] = 0; return 65; })(), ...[...input]); })(), 'ok') : first);",
        '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/spread-arguments.authority.mts')).toContain(
      'new Array(...args)',
    );
  });

  it('starts a state of proxy reads whose traps return, are deferred, replaced, removed or skipped', async () => {
    const { app, compiled } = await compiling({
      'components/proxy-reads.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function ProxyReads({ projectId, first }: { projectId: string; first: string }) {',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? ((new Proxy({}, { get() { return first; } })).value, (new Proxy({}, { get: function* () { throw new Error('deferred'); } })).value, (new Proxy({}, { get: async () => { throw new Error('deferred'); } })).value, (new Proxy({}, { get() { throw new Error('replaced'); }, get: () => first })).value, (new Proxy({}, { get() { return () => { throw new Error('deferred'); }; } })).value, (null as any)?.[(new Proxy({}, { get() { throw new Error('skipped'); } })).value], (() => { const handler = { get() { throw new Error('removed'); } }; new Proxy({}, handler, delete handler.get).value; })(), (() => { const handler = { get() { throw new Error('removed'); } }; const target = () => { delete handler.get; return {}; }; new Proxy(target(), handler).value; })(), (() => { const handler = { get() { throw new Error('removed'); } }; const proxy = new Proxy({}, handler); proxy[(delete handler.get, 'value')]; })(), 'ok') : first);",
        '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/proxy-reads.authority.mts')).toContain(
      'get() { return first; }',
    );
  });

  it('keeps a setter-only Proxy trap descriptor that replaced a data function', async () => {
    const { app, compiled } = await compiling({
      'components/proxy-setter.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function ProxySetter({ projectId, first }: { projectId: string; first: string }) {',
        "  const [selected, setSelected] = useReactiveState<string>(first === '' ? ((new Proxy({}, { get: () => { throw new Error('replaced'); }, set get(_value: unknown) {} })).value, 'ok') : first);",
        '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/proxy-setter.authority.mts')).toContain('set get(');
  });

  it('starts a state of Object.assign getters that return, are overwritten, or remove a later getter, and permits target setters that remove a source getter', async () => {
    const { app, compiled } = await compiling({
      'components/assigned-getters.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function AssignedGetters({ projectId, first }: { projectId: string; first: string }) {',
        "  const [assigned, setAssigned] = useReactiveState<string>(first === '' ? (Object.assign({}, { get value() { return first; } }), Object.assign({}, { get value() { throw new Error('replaced'); }, value: first }), Object.assign({}, { get before() { delete this.later; return first; }, get later() { throw new Error('deleted'); } }), Object.assign({}, Object.defineProperty({}, 'hidden', { get() { throw new Error('hidden'); } })), 'ok') : first);",
        "  const [changed, setChanged] = useReactiveState<string>((() => { const source = { before: first, get later() { throw new Error('deleted'); } }; const target = { set before(_value: string) { delete source.later; } }; Object.assign(target, source); return first; })());",
        "  const [preceded, setPreceded] = useReactiveState<string>((() => { const later = { get value() { throw new Error('deleted'); } }; const earlier = { get before() { delete later.value; return first; } }; Object.assign({}, earlier, later); return first; })());",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setAssigned(first); setChanged(first); setPreceded(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={assigned + changed + preceded} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/assigned-getters.authority.mts');

    expect(program).toContain("assigned: first === '' ? (Object.assign(");
    expect(program).toContain('Object.assign(target, source)');
    expect(program).toContain('Object.assign({}, earlier, later)');
  });

  it('takes a shared helper that clones without transferring kept buffers, and transfers only buffers made within each call', async () => {
    const { app, compiled } = await compiling({
      'domain/todo-filter.ts': file(
        "import type { TodoFilter } from '@/navigation';",
        'const kept = new ArrayBuffer(1);',
        'export function normalizeFilter(value: string): TodoFilter {',
        '  const fresh = new ArrayBuffer(1);',
        "  structuredClone('x', { transfer: [fresh] });",
        '  structuredClone(kept);',
        "  structuredClone('x', { transfer: [], unused: kept });",
        "  structuredClone('x', { transfer: [], ...{ unused: kept } });",
        "  return value === 'active' || value === 'done' ? value : 'all';",
        '}',
      ),
    });

    expect(output(compiled, app, 'components/project-workspace.authority.mts')).toContain(
      'normalizeFilter',
    );
  });

  it('starts a state of Object enumeration getters that return or may return, and skips overwritten, nested, inherited, symbol and non-enumerable getters', async () => {
    const { app, compiled } = await compiling({
      'components/enumerated.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Enumerated({ projectId, first }: { projectId: string; first: string }) {',
        "  const [removed, setRemoved] = useReactiveState<string>(first === '' ? (Object.values({ get before() { delete this.later; return first; }, get later() { throw new Error('deleted'); } }), 'ok') : first);",
        "  const [enumerated, setEnumerated] = useReactiveState<string>(first === '' ? (Object.values({ get value() { return first; } }), Object.entries({ get value() { if (first === 'bad') { throw new Error('bad'); } return first; } }), Object.keys({ get value() { throw new Error('uncalled'); } }), Object.getOwnPropertyDescriptors({ get value() { throw new Error('uncalled'); } }), Object.values({ get value() { throw new Error('replaced'); }, value: first }), Object.values({ get value() { throw new Error('replaced'); }, get value() { return first; } }), Object.values({ get [Symbol.iterator]() { throw new Error('symbol'); } }), Object.values({ nested: { get value() { throw new Error('nested'); } } }), Object.values({ __proto__: { get value() { throw new Error('inherited'); } }, own: first }), Object.values({ get value() { throw new Error('replaced'); }, ...{ value: first } }), Object.values({ get value() { return first; }, set value(_value) { throw new Error('setter'); } }), Object.values(Object.defineProperty({}, 'hidden', { get() { throw new Error('hidden'); } })), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setEnumerated(first); setRemoved(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={enumerated + removed} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/enumerated.authority.mts');

    expect(program).toContain("enumerated: first === '' ? (Object.values(");
    expect(program).toContain("Object.values(Object.defineProperty({}, 'hidden'");
  });

  it('starts a state of Iterator.from given strings, iterables, iterator objects, or values it checks when advanced, and ignores extra arguments', async () => {
    const { app, compiled } = await compiling({
      'components/iterated.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Iterated({ projectId, first }: { projectId: string; first: string }) {',
        "  const [iterated, setIterated] = useReactiveState<string>(first === '' ? (Iterator.from(''), Iterator.from('ab'), Iterator.from(first), Iterator.from([first]), Iterator.from(new Set([first])), Iterator.from({ next: () => ({ value: first, done: true }) }), Iterator.from({} as never), Iterator.from([], Symbol('ignored')), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setIterated(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id={iterated} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/iterated.authority.mts');

    expect(program).toContain(
      "iterated: first === '' ? (Iterator.from(''), Iterator.from('ab'), Iterator.from(first), Iterator.from([first]), Iterator.from(new Set([first])), Iterator.from({ next: () => ({ value: first, done: true }) }), Iterator.from({} as never), Iterator.from([], Symbol('ignored')), 'ok') : first",
    );
  });

  it('starts a state while preserving symbol wrappers and ignored extra symbol arguments', async () => {
    const { compiled } = await compiling({
      'components/wrapped-symbols.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function WrappedSymbols({ projectId, first }: { projectId: string; first: string }) {',
        "  const [wrapped, setWrapped] = useReactiveState<string>(first === '' ? (Object(Symbol('x')), new Object(Symbol('x')), String(Symbol('x')), new Boolean(Symbol('x')), Number.parseFloat('1', Symbol('ignored')), Number.parseInt('1', 10, Symbol('ignored')), new Number(1, Symbol('ignored')), new String('x', Symbol('ignored')), new Date(0, 0, 1, 0, 0, 0, 0, Symbol('ignored')), 'ok') : first);",
        '  return <button onClick={() => setWrapped(first)}><TodoCommands projectId={projectId} id={wrapped} /></button>;',
        '}',
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('starts states of valid collection and registry arguments, including nonregistered symbols and empty grouping with a class callback', async () => {
    const { compiled } = await compiling({
      'components/collections.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Collections({ projectId, first }: { projectId: string; first: string }) {',
        '  const registry = new FinalizationRegistry(() => undefined);',
        '  const target = {};',
        "  const unique = Symbol('target');",
        '  const wellKnown = Symbol.iterator;',
        '  const helper = { groupBy: (_values: unknown, _by: unknown) => ({}), register: (_target: unknown) => undefined };',
        "  const [errors, setErrors] = useReactiveState<string>(first === '' ? (new AggregateError([]), AggregateError([first]), new AggregateError(first), new AggregateError({ *[Symbol.iterator]() { yield first; } }), 'ok') : first);",
        "  const [grouped, setGrouped] = useReactiveState<string>(first === '' ? (Object.groupBy([first], (item) => item), Map.groupBy([first], () => first), Object.groupBy([], class {}), Map.groupBy([], class {}), helper.groupBy([], null), 'ok') : first);",
        "  const [registered, setRegistered] = useReactiveState<string>(first === '' ? (registry.register(target, 'held'), registry.register({}, 'held', undefined), registry.register(unique, 'held', wellKnown), registry.register(wellKnown, 'held', unique), registry.register(() => undefined, 'held', target), registry.unregister(unique), registry.unregister(wellKnown), registry.unregister(target), registry.register({}, {}), helper.register(1), 'ok') : first);",
        '  return (',
        '    <section>',
        '      <button onClick={() => { setErrors(first); setGrouped(first); setRegistered(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id={errors + grouped + registered} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('starts a state of what `??` answers in place of an element `find` finds none of, of an element an array written there holds at an index, and of a default of JSON a parameter takes', async () => {
    const { app, compiled } = await compiling({
      'domain/defaults.ts': file(
        "export function withDefault(value = 'x', { label = 'y' }: { label?: string } = {}) {",
        '  return value + label;',
        '}',
      ),
      'components/found.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { withDefault } from '@/domain/defaults';",
        '',
        'export default function Found({ projectId, first }: { projectId: string; first: string }) {',
        "  const [found, setFound] = useReactiveState<string>([first].find((each) => each === 'x') ?? 'none');",
        "  const [last, setLast] = useReactiveState<string>(['x', first].at(-1)!);",
        "  const [written, setWritten] = useReactiveState(JSON.stringify([first].find((each) => each === 'x') ?? null));",
        "  const [given, setGiven] = useReactiveState(first === '' ? withDefault() : first);",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setFound(''); setLast(''); setWritten(''); setGiven(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/found.authority.mts');

    expect(program).toContain("found: [first].find((each) => each === 'x') ?? 'none'");
    expect(program).toContain("last: ['x', first].at(-1)!");
    expect(program).toContain(
      "written: JSON.stringify([first].find((each) => each === 'x') ?? null)",
    );
    expect(program).toContain("given: first === '' ? withDefault() : first");
  });

  it('starts a state of an element of an array computed as long as the code shows it, of text split by text, of either array a condition answers that holds it, and of `??` in place of one lacked', async () => {
    const { app, compiled } = await compiling({
      'components/indexed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Indexed({ projectId, first }: { projectId: string; first: string }) {',
        "  const [head, setHead] = useReactiveState(first.split('-')[0]);",
        '  const [mapped, setMapped] = useReactiveState<string>([first].map((each) => each.trim())[0]!);',
        "  const [either, setEither] = useReactiveState<string>((first === '' ? ['a'] : [first])[0]!);",
        "  const [key, setKey] = useReactiveState<string>(Object.keys({ [first]: 1 })[0] ?? 'none');",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setHead(''); setMapped(''); setEither(''); setKey(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/indexed.authority.mts');

    expect(program).toContain("head: first.split('-')[0]");
    expect(program).toContain('mapped: [first].map((each) => each.trim())[0]!');
    expect(program).toContain("either: (first === '' ? ['a'] : [first])[0]!");
    expect(program).toContain("key: Object.keys({ [first]: 1 })[0] ?? 'none'");
  });

  it('starts a state of what `get` answers of a `Map` the code makes of entries of the key, and of `??` in place of one it lacks; and takes a local state’s setter given to a call from a handler', async () => {
    const { app, compiled } = await compiling({
      'components/mapped.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Mapped({ projectId, first }: { projectId: string; first: string }) {',
        "  const [held, setHeld] = useReactiveState<string>(new Map([['a', first]]).get('a')!);",
        "  const [lacked, setLacked] = useReactiveState<string>(new Map<string, string>().get(first) ?? 'none');",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { ['x'].forEach(setHeld); setLacked(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id={held + lacked} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/mapped.authority.mts');

    expect(program).toContain("held: new Map([['a', first]]).get('a')!");
    expect(program).toContain("lacked: new Map<string, string>().get(first) ?? 'none'");
  });

  it('starts a state of what `Symbol.keyFor` answers of a symbol `Symbol.for` makes, its key', async () => {
    const { app, compiled } = await compiling({
      'domain/symbols.ts': file(
        'export function registered() {',
        "  return Symbol.keyFor(Symbol.for('k'));",
        '}',
      ),
      'components/keyed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { registered } from '@/domain/symbols';",
        '',
        'export default function Keyed({ projectId, first }: { projectId: string; first: string }) {',
        "  const [key, setKey] = useReactiveState<string>(first === '' ? registered()! : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setKey(\'\')}>clear</button>',
        '      <TodoCommands projectId={projectId} id={key} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/keyed.authority.mts');

    expect(program).toContain("key: first === '' ? registered()! : first");
  });

  it('starts a state of `reduce` of an array of an element, or of a first value, of the `length` of keys, and of an entry of a copy', async () => {
    const { app, compiled } = await compiling({
      'components/reduced.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Reduced({ projectId, first }: { projectId: string; first: string }) {',
        '  const [joined, setJoined] = useReactiveState<string>([first].reduce((a, b) => a + b));',
        '  const [summed, setSummed] = useReactiveState<string>(([] as string[]).reduce((a, b) => a + b, first));',
        '  const [count, setCount] = useReactiveState<number>(Object.keys({ [first]: 1 }).length);',
        '  const [copied, setCopied] = useReactiveState<string>(structuredClone({ id: first }).id);',
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setJoined(''); setSummed(''); setCount(0); setCopied(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id={joined + summed + String(count) + copied} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/reduced.authority.mts');

    expect(program).toContain('joined: [first].reduce((a, b) => a + b)');
    expect(program).toContain('summed: ([] as string[]).reduce((a, b) => a + b, first)');
    expect(program).toContain('count: Object.keys({ [first]: 1 }).length');
    expect(program).toContain('copied: structuredClone({ id: first }).id');
  });

  it('starts a state of `with` of an index within the bounds of an array written there, and of `map` of an array of no hole', async () => {
    const { app, compiled } = await compiling({
      'components/replaced.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Replaced({ projectId, first }: { projectId: string; first: string }) {',
        "  const [head, setHead] = useReactiveState<string[]>([first].with(0, 'x'));",
        "  const [last, setLast] = useReactiveState<string[]>([first, 'y'].with(-1, first));",
        '  const [trimmed, setTrimmed] = useReactiveState<string[]>([first].map((each) => each.trim()));',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setHead([]); setLast([]); setTrimmed([]); }}>clear</button>',
        "      <TodoCommands projectId={projectId} id={head.join('') + last.join('') + trimmed.join('')} />",
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/replaced.authority.mts');

    expect(program).toContain("head: [first].with(0, 'x')");
    expect(program).toContain("last: [first, 'y'].with(-1, first)");
    expect(program).toContain('trimmed: [first].map((each) => each.trim())');
  });

  it('starts a state of the language’s functions that throw of some of what they are given, given what they throw not of, or what the code does not write', async () => {
    const { app, compiled } = await compiling({
      // A date of no time made, whose time the code sets since: what made it tells no more.
      'domain/stamp.ts': file(
        'export function stamp() {',
        '  const when = new Date(NaN);',
        '  when.setTime(0);',
        '  return when.toISOString();',
        '}',
      ),
      'components/escaped.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { stamp } from '@/domain/stamp';",
        '',
        'export default function Escaped({ projectId, first }: { projectId: string; first: string }) {',
        '  const [escaped, setEscaped] = useReactiveState<string>(encodeURIComponent(first));',
        "  const [repeated, setRepeated] = useReactiveState<string>(first === '' ? 'ab'.repeat(2) : (1).toFixed(2));",
        "  const [hex, setHex] = useReactiveState<string>(first === '' ? (255).toString(16) : first.toString());",
        "  const [stamped, setStamped] = useReactiveState<string>(first === '' ? new Date(0).toISOString() : stamp());",
        "  const [formed, setFormed] = useReactiveState<string>(first === '' ? String.fromCodePoint(65) : first.normalize('NFC'));",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setEscaped(''); setRepeated(''); setHex(''); setStamped(''); setFormed(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id={escaped + repeated + hex + stamped + formed} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/escaped.authority.mts');

    expect(program).toContain('escaped: encodeURIComponent(first)');
    expect(program).toContain("repeated: first === '' ? 'ab'.repeat(2) : (1).toFixed(2)");
    expect(program).toContain("hex: first === '' ? (255).toString(16) : first.toString()");
    expect(program).toContain("stamped: first === '' ? new Date(0).toISOString() : stamp()");
    expect(program).toContain(
      "formed: first === '' ? String.fromCodePoint(65) : first.normalize('NFC')",
    );
  });

  it('starts a state of a date’s parts and of what its setters answer, of what a pattern, an array-like, entries and a URL made of what throws not answer, and of what a method of an array answers', async () => {
    const { app, compiled } = await compiling({
      // A function that throws of some of what it is given, and returns of the rest.
      'domain/checked.ts': file(
        'export function checked(value: string): string {',
        "  if (value === '') {",
        "    throw new Error('empty');",
        '  }',
        '  return value;',
        '}',
      ),
      'components/made.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { checked } from '@/domain/checked';",
        '',
        'export default function Made({ projectId, first }: { projectId: string; first: string }) {',
        "  const [timed, setTimed] = useReactiveState<number>(first === '' ? new Date(0).setUTCHours(1) + new Date(0).getFullYear() : 0);",
        "  const [tested, setTested] = useReactiveState<boolean>(first === '' ? new RegExp('a').test('x') : first.replaceAll(/a/g, 'b') === first.replace('[', 'b'));",
        "  const [counts, setCounts] = useReactiveState<number[]>(first === '' ? Array.from({ length: 3 }, () => 0) : [first].map((each) => each.length));",
        "  const [entries, setEntries] = useReactiveState<Record<string, number>>(first === '' ? Object.fromEntries([['a', new Map([[1, 2]]).size]]) : {});",
        "  const [href, setHref] = useReactiveState<string>(first === '' ? new URL('https://example.com').href : first);",
        "  const [removed, setRemoved] = useReactiveState<boolean>(first === '' ? new Map([[1, 2]]).delete(1) : checked(first) === '');",
        "  const [keyed, setKeyed] = useReactiveState<string[]>(first === '' ? Object.keys('ab') : Object.keys(Object.create(null) as object));",

        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setTimed(0); setTested(false); setCounts([]); setEntries({}); setHref(\'\'); setRemoved(false); setKeyed([]); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/made.authority.mts');

    expect(program).toContain(
      "timed: first === '' ? new Date(0).setUTCHours(1) + new Date(0).getFullYear() : 0",
    );
    expect(program).toContain(
      "tested: first === '' ? new RegExp('a').test('x') : first.replaceAll(/a/g, 'b') === first.replace('[', 'b')",
    );
    expect(program).toContain(
      "counts: first === '' ? Array.from({ length: 3 }, () => 0) : [first].map((each) => each.length)",
    );
    expect(program).toContain(
      "entries: first === '' ? Object.fromEntries([['a', new Map([[1, 2]]).size]]) : {}",
    );
    expect(program).toContain("href: first === '' ? new URL('https://example.com').href : first");
    expect(program).toContain(
      "removed: first === '' ? new Map([[1, 2]]).delete(1) : checked(first) === ''",
    );
    expect(program).toContain(
      "keyed: first === '' ? Object.keys('ab') : Object.keys(Object.create(null) as object)",
    );
  });

  it('starts a state of a read within the bytes of a `DataView` the code makes, of `Atomics.load` within the elements of a typed array, of a pattern’s own split of no group, of the text of what its `compile` answers, of `apply` of no list and `Reflect.apply` of text to call on, of an object’s own `text`, and of what takes locales of language tags', async () => {
    const { app, compiled } = await compiling({
      'components/viewed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Viewed({ projectId, first }: { projectId: string; first: string }) {',
        "  const [viewed, setViewed] = useReactiveState<number>(first === '' ? new DataView(new ArrayBuffer(8), 4).getInt32(0) : 0);",
        "  const [divided, setDivided] = useReactiveState<string[]>(first === '' ? /-/[Symbol.split]('x-y') : [String(/a/.compile('b'))]);",
        "  const [bytes, setBytes] = useReactiveState<number[]>(first === '' ? [new Uint8Array([1, 2]).subarray(1).length] : [String(new Uint8Array([1]).map(() => 2)).length]);",
        "  const [loaded, setLoaded] = useReactiveState<number>(first === '' ? Atomics.load(new Int32Array(new SharedArrayBuffer(8)), 1) : (() => first.length).apply(null, null as unknown as []));",
        "  const [applied, setApplied] = useReactiveState<string>(first === '' ? Reflect.apply((text: string) => text, 'x', [first]) : ({ text: () => first }).text());",
        "  const [located, setLocated] = useReactiveState<string>(first === '' ? (1).toLocaleString('en-US') : new Intl.NumberFormat(['en', 'ja']).format(1));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setViewed(0); setDivided([]); setBytes([]); setLoaded(0); setApplied(first); setLocated(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/viewed.authority.mts');

    expect(program).toContain(
      "viewed: first === '' ? new DataView(new ArrayBuffer(8), 4).getInt32(0) : 0",
    );
    expect(program).toContain(
      "divided: first === '' ? /-/[Symbol.split]('x-y') : [String(/a/.compile('b'))]",
    );
    expect(program).toContain(
      "bytes: first === '' ? [new Uint8Array([1, 2]).subarray(1).length] : [String(new Uint8Array([1]).map(() => 2)).length]",
    );
    expect(program).toContain(
      "loaded: first === '' ? Atomics.load(new Int32Array(new SharedArrayBuffer(8)), 1) : (() => first.length).apply(null, null as unknown as [])",
    );
    expect(program).toContain(
      "applied: first === '' ? Reflect.apply((text: string) => text, 'x', [first]) : ({ text: () => first }).text()",
    );
    expect(program).toContain(
      "located: first === '' ? (1).toLocaleString('en-US') : new Intl.NumberFormat(['en', 'ja']).format(1)",
    );
  });

  it('starts a state of a reduction of a typed array to a first value, of a function an array of no element calls not, of a locale’s options written whole, of a format of `Intl` called, of base64, of a decoder of a label of an encoding, and of a symbol’s text and a clone of no transfer', async () => {
    const { app, compiled } = await compiling({
      'components/reduced.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Reduced({ projectId, first }: { projectId: string; first: string }) {',
        "  const [reduced, setReduced] = useReactiveState<number>(first === '' ? new Uint8Array([1, 2]).reduce(() => 1, 0) : 0);",
        "  const [kept, setKept] = useReactiveState<string[]>(first === '' ? ([] as string[]).filter(() => { throw new Error('never'); }) : [first]);",
        "  const [priced, setPriced] = useReactiveState<string>(first === '' ? (1).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : first);",
        "  const [called, setCalled] = useReactiveState<string>(first === '' ? Intl.NumberFormat('en').format(1) + atob('YQ==') + btoa('a') : first);",
        "  const [decoded, setDecoded] = useReactiveState<string>(first === '' ? new TextDecoder('utf-8').encoding + String(Intl.supportedValuesOf('calendar').length) : first);",
        "  const [described, setDescribed] = useReactiveState<string>(first === '' ? String(Symbol('x')) + structuredClone('x', { transfer: [] }) : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setReduced(0); setKept([]); setPriced(first); setCalled(first); setDecoded(first); setDescribed(first); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/reduced.authority.mts');

    expect(program).toContain(
      "reduced: first === '' ? new Uint8Array([1, 2]).reduce(() => 1, 0) : 0",
    );
    expect(program).toContain(
      "kept: first === '' ? ([] as string[]).filter(() => { throw new Error('never'); }) : [first]",
    );
    expect(program).toContain(
      "priced: first === '' ? (1).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : first",
    );
    expect(program).toContain(
      "called: first === '' ? Intl.NumberFormat('en').format(1) + atob('YQ==') + btoa('a') : first",
    );
    expect(program).toContain(
      "decoded: first === '' ? new TextDecoder('utf-8').encoding + String(Intl.supportedValuesOf('calendar').length) : first",
    );
    expect(program).toContain(
      "described: first === '' ? String(Symbol('x')) + structuredClone('x', { transfer: [] }) : first",
    );
  });

  it('starts a state of an array `fill` puts a value at every index of, the holes of `Array(3)` too, and of what a typed array and a view made over a buffer within its bytes hold', async () => {
    const { app, compiled } = await compiling({
      'components/filled.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Filled({ projectId, first }: { projectId: string; first: string }) {',
        "  const [filled, setFilled] = useReactiveState<number[]>(first === '' ? Array(3).fill(0).map((each) => each + 1) : []);",
        "  const [zeroed, setZeroed] = useReactiveState<number[]>(first === '' ? Array(2).fill(0, 0) : []);",
        "  const [viewed, setViewed] = useReactiveState<number>(first === '' ? new Int32Array(new ArrayBuffer(8), 4).length + new Int16Array(new ArrayBuffer(8), 2, 3).length + new DataView(new ArrayBuffer(8), 2, 6).byteLength : 0);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setFilled([]); setZeroed([]); setViewed(0); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/filled.authority.mts');

    expect(program).toContain(
      "filled: first === '' ? Array(3).fill(0).map((each) => each + 1) : []",
    );
    expect(program).toContain("zeroed: first === '' ? Array(2).fill(0, 0) : []");
    expect(program).toContain(
      "viewed: first === '' ? new Int32Array(new ArrayBuffer(8), 4).length + new Int16Array(new ArrayBuffer(8), 2, 3).length + new DataView(new ArrayBuffer(8), 2, 6).byteLength : 0",
    );
  });

  it('starts a state of built-ins made of what they take, and of methods of a class’s own borrowed for what is of the class, or of what holds an `exec` for a pattern’s `test`', async () => {
    const { app, compiled } = await compiling({
      'components/branded.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Branded({ projectId, first }: { projectId: string; first: string }) {',
        "  const [branded, setBranded] = useReactiveState<number>(first === '' ? Date.prototype.getTime.call(new Date(0)) + Number.prototype.toFixed.call(1, 1).length + (RegExp.prototype.test.call(/a/, 'a') ? 1 : 0) + (RegExp.prototype.test.call({ exec: () => null } as unknown as RegExp, 'a') ? 1 : 0) + (Map.prototype.has.call(new Map(), 'a') ? 1 : 0) + String.prototype.trim.call({} as string).length + Uint8Array.prototype.slice.call(new Int8Array(2)).length + (new WeakMap([[{}, 1]]), 0) + (new WeakSet([{}]), 0) + (new Proxy({}, {}), 0) + (new Promise(() => undefined), 0) : 0);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setBranded(0)}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/branded.authority.mts');

    expect(program).toContain(
      "branded: first === '' ? Date.prototype.getTime.call(new Date(0)) + Number.prototype.toFixed.call(1, 1).length + (RegExp.prototype.test.call(/a/, 'a') ? 1 : 0) + (RegExp.prototype.test.call({ exec: () => null } as unknown as RegExp, 'a') ? 1 : 0) + (Map.prototype.has.call(new Map(), 'a') ? 1 : 0) + String.prototype.trim.call({} as string).length + Uint8Array.prototype.slice.call(new Int8Array(2)).length + (new WeakMap([[{}, 1]]), 0) + (new WeakSet([{}]), 0) + (new Proxy({}, {}), 0) + (new Promise(() => undefined), 0) : 0",
    );
  });

  it('starts a state of what the platform’s methods answer of what the code writes them whole, `new Headers().append(…)`', async () => {
    const { app, compiled } = await compiling({
      'components/appended.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Appended({ projectId, first }: { projectId: string; first: string }) {',
        "  const [appended, setAppended] = useReactiveState<string>(first === '' ? (new Headers().append('ok', 'x'), new URLSearchParams('a=1').get('a') ?? '') : first);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setAppended(first)}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/appended.authority.mts');

    expect(program).toContain(
      "appended: first === '' ? (new Headers().append('ok', 'x'), new URLSearchParams('a=1').get('a') ?? '') : first",
    );
  });

  it('takes a list’s key read through a cast to an interface of type parameters, which a type of the parameter’s name beside it answers not for', async () => {
    const { compiled: taken } = await compiling({
      'components/boxes.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import type { Box } from '@/domain/boxes';",
        '',
        'export default function Boxes({ projectId }: { projectId: string }) {',
        '  const [boxes, setBoxes] = useReactiveState<readonly { readonly id: string }[]>([]);',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setBoxes([{ id: \'t1\' }])}>open</button>',
        '      {boxes.map((box) => <TodoCommands key={(box as Box<string>).id} projectId={projectId} id={box.id} />)}',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/boxes.ts': file(
        // The name of the interface's parameter, which it reads of its own, not of this.
        'type T = string | null;',
        'export interface Box<T> {',
        '  readonly id: T;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('starts a state of a symbol given what takes any value, `abort`, or what reads nothing, and of callbacks of functions, or of `undefined` where it is taken', async () => {
    const { app, compiled } = await compiling({
      'components/called.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Called({ projectId, first }: { projectId: string; first: string }) {',
        "  const [aborted, setAborted] = useReactiveState<string>(first === '' ? (new AbortController().abort(Symbol('x')), new EventTarget(), 'ok') : first);",
        "  const [called, setCalled] = useReactiveState<number>(first === '' ? Array.from([1], undefined).length + Array.from([1], (each) => each).length + [2, 1].sort(undefined).length + [1].map((each) => each).length + 'ab'.replace('a', 1 as unknown as string).length : 0);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setAborted(first); setCalled(0); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/called.authority.mts');

    expect(program).toContain(
      "aborted: first === '' ? (new AbortController().abort(Symbol('x')), new EventTarget(), 'ok') : first",
    );
    expect(program).toContain(
      "called: first === '' ? Array.from([1], undefined).length + Array.from([1], (each) => each).length + [2, 1].sort(undefined).length + [1].map((each) => each).length + 'ab'.replace('a', 1 as unknown as string).length : 0",
    );
  });

  it('starts a state of a date’s text of a locale and options written whole, and of buffers sized within the most bytes they may grow to', async () => {
    const { app, compiled } = await compiling({
      'components/sized.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Sized({ projectId, first }: { projectId: string; first: string }) {',
        "  const [dated, setDated] = useReactiveState<string>(first === '' ? new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' }) : first);",
        "  const [sized, setSized] = useReactiveState<number>(first === '' ? new ArrayBuffer(8, { maxByteLength: 16 }).maxByteLength + (new ArrayBuffer(8, { maxByteLength: 16 }).resize(12), 0) + (new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(12), 0) + new ArrayBuffer(8).transfer(4).byteLength + new ArrayBuffer(8, { maxByteLength: undefined }).byteLength : 0);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setDated(first); setSized(0); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/sized.authority.mts');

    expect(program).toContain(
      "dated: first === '' ? new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' }) : first",
    );
    expect(program).toContain(
      "sized: first === '' ? new ArrayBuffer(8, { maxByteLength: 16 }).maxByteLength + (new ArrayBuffer(8, { maxByteLength: 16 }).resize(12), 0) + (new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(12), 0) + new ArrayBuffer(8).transfer(4).byteLength + new ArrayBuffer(8, { maxByteLength: undefined }).byteLength : 0",
    );
  });

  it('starts a state of descriptors written whole, of typed arrays of elements of their kind, and of `bigint`s of widths and values `BigInt.asIntN` takes', async () => {
    const { app, compiled } = await compiling({
      'components/kinded.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Kinded({ projectId, first }: { projectId: string; first: string }) {',
        "  const [described, setDescribed] = useReactiveState<boolean>(first === '' ? Reflect.defineProperty({}, 'x', { value: 1, enumerable: true }) && Reflect.defineProperty({}, 'y', { get: () => 1, set: undefined }) && Object.keys(Object.create(null, { z: { value: 1, enumerable: true } })).length === 1 : false);",
        "  const [typed, setTyped] = useReactiveState<number>(first === '' ? new BigInt64Array([1n]).length + new Int32Array([1]).length + BigInt64Array.of(1n, true as unknown as bigint).length + new BigInt64Array(2).fill(1n).length + Atomics.store(new Int32Array(1), 0, 1) : 0);",
        "  const [widened, setWidened] = useReactiveState<boolean>(first === '' ? BigInt.asIntN(8, 255n) === -1n && BigInt(2) === 2n && BigInt('3') === 3n : false);",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => { setDescribed(false); setTyped(0); setWidened(false); }}>clear</button>',
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/kinded.authority.mts');

    expect(program).toContain(
      "described: first === '' ? Reflect.defineProperty({}, 'x', { value: 1, enumerable: true }) && Reflect.defineProperty({}, 'y', { get: () => 1, set: undefined }) && Object.keys(Object.create(null, { z: { value: 1, enumerable: true } })).length === 1 : false",
    );
    expect(program).toContain(
      "typed: first === '' ? new BigInt64Array([1n]).length + new Int32Array([1]).length + BigInt64Array.of(1n, true as unknown as bigint).length + new BigInt64Array(2).fill(1n).length + Atomics.store(new Int32Array(1), 0, 1) : 0",
    );
    expect(program).toContain(
      "widened: first === '' ? BigInt.asIntN(8, 255n) === -1n && BigInt(2) === 2n && BigInt('3') === 3n : false",
    );
  });

  it('takes a typed array’s with index within its elements, and leaves an unknown index or length to the authority', async () => {
    const { compiled: taken } = await compiling({
      'components/replaced.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Replaced({ projectId, first, index, length }: { projectId: string; first: string; index: number; length: number }) {',
        "  const [valid, setValid] = useReactiveState<string>(first === '' ? (new Uint8Array(1).with(0, 0), new Uint8Array(1).with(-1, 0), new Uint8Array(1).with(-1.9, 0), new Uint8Array(1).with(0.9, 0), new Uint8Array(1).with(NaN, 0), new Uint8Array([0, 0]).with(1, 0), new Uint16Array(new ArrayBuffer(4)).with(-2, 0), new BigInt64Array(1).with(-1, 0n), new Uint8Array(1)['with'](0, 0), 'ok') : first);",
        "  const [unknown, setUnknown] = useReactiveState<string>(first === '' ? (new Uint8Array(1).with(index, 0), new Uint8Array(length).with(99, 0), 'ok') : first);",
        "  const [coerced, setCoerced] = useReactiveState<string>(first === '' ? (new Uint8Array(1).with(undefined as unknown as number, 0), new Uint8Array(1).with(void 0 as unknown as number, 0), new Uint8Array(1).with(null as unknown as number, 0), new Uint8Array(1).with(false as unknown as number, 0), new Uint8Array(2).with(true as unknown as number, 0), new Uint8Array(1).with('0' as unknown as number, 0), new Uint8Array(1).with(Number(0n), 0), 'ok') : first);",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setValid(''); setUnknown(''); setCoerced(''); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id={valid + unknown + coerced} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('starts a state of what a function the code writes answers called through `call` and `Reflect.apply`, of text split by a pattern of no group that captures, of the numbers `Date` reads of what it is given and a date’s time, of a character’s code within text, and of a function that calls itself', async () => {
    const { app, compiled } = await compiling({
      // A function that calls itself, read once on the way: its other return tells.
      'domain/countdown.ts': file(
        'export function countdown(n: number) {',
        '  return n > 0 ? countdown(n - 1) : 0;',
        '}',
      ),
      'components/called.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { countdown } from '@/domain/countdown';",
        '',
        'export default function Called({ projectId, first }: { projectId: string; first: string }) {',
        '  const trimmed = (text: string) => text.trim();',
        '  const [called, setCalled] = useReactiveState(trimmed.call(null, first));',
        "  const [parts, setParts] = useReactiveState(first.split(/(?:,)|;/).concat(first.split(',')));",
        "  const [when, setWhen] = useReactiveState(first === '' ? Date.UTC(2020, 0, 1) : Date.parse('2020-01-01'));",
        '  const [counted, setCounted] = useReactiveState(countdown(first.length));',
        '  const [applied, setApplied] = useReactiveState(Reflect.apply((text: string) => text, null, [first]));',
        "  const [numbered, setNumbered] = useReactiveState(first === '' ? +new Date(0) : 'x'.charCodeAt(0));",
        "  const [timed, setTimed] = useReactiveState(first === '' ? new Date(0).getTime() : 0);",
        '  return (',
        '    <section>',
        "      <button type=\"button\" onClick={() => { setCalled(''); setParts([]); setWhen(0); setCounted(0); setApplied(''); setNumbered(0); setTimed(0); }}>clear</button>",
        '      <TodoCommands projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/called.authority.mts');

    expect(program).toContain('called: trimmed.call(null, first)');
    expect(program).toContain("parts: first.split(/(?:,)|;/).concat(first.split(','))");
    expect(program).toContain(
      "when: first === '' ? Date.UTC(2020, 0, 1) : Date.parse('2020-01-01')",
    );
    expect(program).toContain('counted: countdown(first.length)');
    expect(program).toContain('applied: Reflect.apply((text: string) => text, null, [first])');
    expect(program).toContain("numbered: first === '' ? +new Date(0) : 'x'.charCodeAt(0)");
    expect(program).toContain("timed: first === '' ? new Date(0).getTime() : 0");
  });

  it('starts a hook’s local state of what the server part computes of a constant it reads twice', async () => {
    const restored = [
      '  const initialPanels = initialPanelsFor(selectedId);',
      '  const restored = initialPanels.length > 0 ? initialPanels : [];',
    ].join('\n');
    const { app, compiled } = await compiling({
      'components/desk.reactive.tsx': DESK.replace(
        '  const initialPanels = initialPanelsFor(selectedId);',
        () => restored,
      ).replace('usePanels(initialPanels)', 'usePanels(restored)'),
      'domain/panels.ts': PANELS_DOMAIN,
      'hooks/use-filter.ts': USE_FILTER,
      'hooks/use-panels.ts': USE_PANELS,
    });
    const program = output(compiled, app, 'components/desk.authority.mts');

    expect(program).toContain(
      '      "usePanels#0.panels": restored as readonly import(\'@/domain/panels\').Panel[],',
    );
    expect(program).toContain('export const updaters = Object.freeze({});');
  });

  it('starts a generic hook’s local state as the caller types it, of no type parameter', async () => {
    const { app, compiled } = await compiling({
      'components/picked.reactive.tsx': file(
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { usePicked } from '@/hooks/use-picked';",
        '',
        'export default function Picked({ projectId }: { projectId: string }) {',
        "  const { picked, setPicked } = usePicked(projectId === '' ? 't1' : 't2');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setPicked(\'t2\')}>pick</button>',
        '      <TodoCommands projectId={projectId} id={picked} />',
        '    </section>',
        '  );',
        '}',
      ),
      'hooks/use-picked.ts': file(
        "import { useReactiveState } from 'framework/react';",
        '',
        'export function usePicked<T extends string>(initial: T) {',
        '  const [picked, setPicked] = useReactiveState<T>(initial);',
        '  return { picked, setPicked };',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/picked.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain("\"usePicked#0.picked\": projectId === '' ? 't1' : 't2'");
    expect(program).not.toContain(' as T');
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('binds a name of its own for an item of a hook’s array a site is computed of, which the component leaves unbound', async () => {
    const { app, compiled } = await compiling({
      'components/paired.reactive.tsx': file(
        "import TodoResults from '@/components/todo-results.reactive';",
        "import type { TodoFilter } from '@/navigation';",
        "import { usePair } from '@/hooks/use-pair';",
        '',
        'export default function Paired({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
        '  const [shown] = usePair(initialFilter);',
        '  return (',
        '    <section>',
        '      <TodoResults projectId={projectId} filter={shown} />',
        '    </section>',
        '  );',
        '}',
      ),
      'hooks/use-pair.ts': file(
        "import { useReactiveState } from 'framework/react';",
        "import type { TodoFilter } from '@/navigation';",
        '',
        'export function usePair(initialFilter: TodoFilter) {',
        '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
        "  const shown: TodoFilter = filter === 'done' ? 'done' : 'all';",
        '  return [shown, filter, setFilter] as const;',
        '}',
      ),
    });
    const client = output(compiled, app, 'components/paired.client.tsx');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(client).toContain('const [, filter$2] = usePair(');
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('binds a name of its own for an item of a hook’s object a site is computed of, of a key no binding is named by', async () => {
    const quoted = await spelled("'my-filter'");
    const kept = await spelled('default');

    expect(quoted.client).toContain('const { "my-filter": item } = useSpelled(');
    expect(quoted.checked).toBe('');
    expect(kept.client).toContain('const { default: item } = useSpelled(');
    expect(kept.checked).toBe('');
  });

  /**
   * The Client Component of a component that reads a hook's item a site is computed of, the hook
   * returning the state it is of by `key`, unbound; and what checking its types reports.
   */
  async function spelled(
    key: string,
  ): Promise<{ readonly client: string; readonly checked: string }> {
    const { app, compiled } = await compiling({
      'components/spelled.reactive.tsx': file(
        "import TodoResults from '@/components/todo-results.reactive';",
        "import type { TodoFilter } from '@/navigation';",
        "import { useSpelled } from '@/hooks/use-spelled';",
        '',
        'export default function Spelled({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
        '  const { shown } = useSpelled(initialFilter);',
        '  return (',
        '    <section>',
        '      <TodoResults projectId={projectId} filter={shown} />',
        '    </section>',
        '  );',
        '}',
      ),
      'hooks/use-spelled.ts': file(
        "import { useReactiveState } from 'framework/react';",
        "import type { TodoFilter } from '@/navigation';",
        '',
        'export function useSpelled(initialFilter: TodoFilter) {',
        '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
        "  const shown: TodoFilter = filter === 'done' ? 'done' : 'all';",
        `  return { shown, ${key}: filter, setFilter };`,
        '}',
      ),
    });
    const client = output(compiled, app, 'components/spelled.client.tsx');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);
    return { checked: checked.stdout + checked.stderr, client };
  }

  it.each([
    "export const carrier = { toString() { return 'x'; }, get padStart() { return ''.padStart; } };",
    "export const carrier = Object.create({ padStart: ''.padStart, toString() { return 'x'; } });",
  ])('guards the actual native function carried by a shared method: %s', async (carrier) => {
    const { app, compiled } = await compiling({
      'domain/carrier.ts': `${carrier}\nexport function getCarrier() { return carrier; }\n`,
      'components/carried.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { getCarrier } from '@/domain/carrier';",
        '',
        'export default function Carried({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('a');",
        '  return <section><button type="button" onClick={() => setText(\'b\')}>b</button><TodoCommands projectId={projectId} id={getCarrier().padStart(20, text)} /></section>;',
        '}',
      ),
    });
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'carried.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, member, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), member, method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        "let result = 'rendered';",
        "try { withinSteps(() => d0.render({ text: 'ab' })); } catch (error) { result = error.name; }",
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toBe('TypeError');
  });

  it('keeps generic method type arguments and callee wrappers in guarded programs', async () => {
    const { app, compiled } = await compiling({
      'domain/generic-methods.ts':
        'export const functions = { echo<T>(value: T): T { return value; } };\n',
      'components/generic-methods.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { functions } from '@/domain/generic-methods';",
        'export default function GenericMethods({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('a');",
        '  return <section>',
        '    <button type="button" onClick={() => setText(\'b\')}>b</button>',
        '    <TodoCommands projectId={projectId} id={functions.echo<string>(text)} />',
        '    <TodoCommands projectId={projectId} id={(functions.echo as typeof functions.echo)<string>(text)} />',
        '    <TodoCommands projectId={projectId} id={(functions.echo!)<string>(text)} />',
        "    <TodoCommands projectId={projectId} id={functions['echo']<string>(text)} />",
        '    <TodoCommands projectId={projectId} id={String.fromCharCode(text.charCodeAt(0))} />',
        '  </section>;',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/generic-methods.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain('$.method(functions, "echo")<string>(text)');
    expect(checked.stdout + checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it('counts what each call answers, so text a view sends that `.split` and `.join` grow is refused past the steps a site may spend', async () => {
    const { app, compiled } = await compiling({
      'components/grown.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Grown({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('a');",
        "  const grown = text.split('').join('--').split('').join('--').split('').join('--').split('').join('--');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'b\')}>b</button>',
        '      <TodoCommands projectId={projectId} id={grown} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'grown.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (text) => {',
        '  try {',
        '    withinSteps(() => d0.render({ text }));',
        "    return 'rendered';",
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        "process.stdout.write(JSON.stringify([shown('ab'), shown('x'.repeat(2000))]));",
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['rendered', 'RangeError']);
  });

  it('stops an optional chain where it reads `undefined`, with each call within it counted', async () => {
    const { app, compiled } = await compiling({
      'components/chained.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Chained({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('a');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'x\')}>x</button>',
        "      <TodoCommands projectId={projectId} id={[text].find((each) => each === 'x')?.slice(0).concat('?') ?? 'none'} />",
        "      <TodoCommands projectId={projectId} id={[[text]].find((each) => each[0] === 'x')?.[0]?.concat('!').slice(0) ?? 'none'} />",
        '    </section>',
        '  );',
        '}',
      ),
    });
    const written = output(compiled, app, 'components/chained.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'chained.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0, d1 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (site, text) => {',
        '  try {',
        '    return withinSteps(() => site.render({ text })).props.id;',
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        "process.stdout.write(JSON.stringify([d0, d1].map((site) => [shown(site, 'a'), shown(site, 'x')])));",
      ].join('\n'),
      app.root,
    );

    expect(written).toContain(
      'id: ((value) => value == null ? undefined : $.counted($.method($.counted($.method(value, "slice")(0)), "concat")(\'?\')))($.counted($.method($.counted([text]), "find")((each) => $.counted(each === \'x\')))) ?? \'none\'',
    );
    expect(checked.stdout + checked.stderr).toBe('');
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual([
      ['none', 'x?'],
      ['none', 'x!'],
    ]);
  });

  it('counts what each `+`, template and array makes, so text a view sends that constants double is refused past the steps a site may spend', async () => {
    const { app, compiled } = await compiling({
      'components/doubled.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Doubled({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('a');",
        '  const a = text + text;',
        `  const b = \`\${a}\${a}\`;`,
        '  const c = b + b;',
        `  const d = \`\${c}\${c}\`;`,
        '  const e = d + d;',
        `  const f = \`\${e}\${e}\`;`,
        '  const g = f + f;',
        `  const h = \`\${g}\${g}\`;`,
        '  const i = h + h;',
        `  const j = \`\${i}\${i}\`;`,
        '  const k = j + j;',
        `  const l = \`\${k}\${k}\`;`,
        '  const items = [...[text], ...[text]];',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'b\')}>b</button>',
        '      <TodoCommands projectId={projectId} id={String(l.length + items.length)} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const written = output(compiled, app, 'components/doubled.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'doubled.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (text) => {',
        '  try {',
        '    return withinSteps(() => d0.render({ text })).props.id;',
        '  } catch (error) {',
        "    return error.message.includes('steps') ? 'steps' : error.name;",
        '  }',
        '};',
        "process.stdout.write(JSON.stringify([shown('a'), shown('x'.repeat(2000))]));",
      ].join('\n'),
      app.root,
    );

    expect(written).toContain('$.counted([...$.counted([text]), ...$.counted([text])])');
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['4098', 'steps']);
  });

  it('refuses a key the code computes that reaches what made a value, which a view sends: `[][key]` of `constructor` is `Array`', async () => {
    const { app, compiled } = await compiling({
      'components/keyed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Keyed({ projectId }: { projectId: string }) {',
        "  const [key, setKey] = useReactiveState('length');",
        '  const reached = ([key] as unknown as Record<string, unknown> | undefined)?.[key];',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setKey(\'at\')}>at</button>',
        '      <TodoCommands projectId={projectId} id={typeof reached} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const written = output(compiled, app, 'components/keyed.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'keyed.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, member, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), member, method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (key) => {',
        '  try {',
        '    return withinSteps(() => d0.render({ key })).props.id;',
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        "process.stdout.write(JSON.stringify([shown('length'), shown('constructor'), shown('__proto__')]));",
      ].join('\n'),
      app.root,
    );

    expect(written).toContain('?.[$.member(key)]');
    expect(checked.stdout + checked.stderr).toBe('');
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['number', 'TypeError', 'TypeError']);
  });

  it('refuses a value the code makes that holds a method of the language’s, which would take what it is called on for an array as long as a view says', async () => {
    const { app, compiled } = await compiling({
      'components/borrowed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Borrowed({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('{}');",
        '  const joined = ({ ...(JSON.parse(text) as object), join: [].join } as unknown as string[]).join();',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'{"size":1}\')}>size</button>',
        '      <TodoCommands projectId={projectId} id={joined} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'borrowed.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (text) => {',
        '  try {',
        '    return withinSteps(() => d0.render({ text })).props.id;',
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        "process.stdout.write(JSON.stringify([shown('{}'), shown('{\"length\":1000000}')]));",
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['TypeError', 'TypeError']);
  });

  it('counts the elements an object made spreadable says it holds before `concat` reads them, so a `length` a view sends is refused', async () => {
    const { app, compiled } = await compiling({
      'components/spread.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { spread } from '@/domain/spread';",
        '',
        'export default function Spread({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('{}');",
        '  const spreadAll = ([] as unknown[]).concat({ ...(JSON.parse(text) as object), [spread]: true });',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'{"size":1}\')}>size</button>',
        '      <TodoCommands projectId={projectId} id={String(spreadAll.length)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/spread.ts': file('export const spread: symbol = Symbol.isConcatSpreadable;'),
    });
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'spread.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        // What `concat` is called with: of an object of a million elements, never, where it is
        // refused as it is made.
        'const concat = Array.prototype.concat;',
        'const lengths = [];',
        'Array.prototype.concat = function (...given) {',
        '  lengths.push(given.map((each) => each.length));',
        '  return concat.apply(this, given);',
        '};',
        'const shown = (text) => {',
        '  try {',
        '    return withinSteps(() => d0.render({ text })).props.id;',
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        'const answers = [shown(\'{"length":2}\'), shown(\'{"length":1000000}\')];',
        'Array.prototype.concat = concat;',
        'process.stdout.write(JSON.stringify([...answers, lengths]));',
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['2', 'RangeError', [[2]]]);
  });

  it('counts what `*` and `<<` are computed of before they compute, so an integer of `bigint` a shared module answers is refused before it grows', async () => {
    const { app, compiled } = await compiling({
      'components/shifted.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { ONE, toBig } from '@/domain/big';",
        '',
        'export default function Shifted({ projectId }: { projectId: string }) {',
        '  const [count, setCount] = useReactiveState(1);',
        '  const shifted = (ONE << toBig(count).value) > ONE;',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setCount(2)}>2</button>',
        '      <TodoCommands projectId={projectId} id={String(count * 2) + String(shifted)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/big.ts': file(
        'export const ONE = 1n;',
        '',
        '/** An integer of `bigint` as large as `count` says, read of a getter, which nothing counts. */',
        'export function toBig(count: number): { readonly value: bigint } {',
        '  return {',
        '    get value(): bigint {',
        '      return BigInt(count);',
        '    },',
        '  };',
        '}',
      ),
    });
    const written = output(compiled, app, 'components/shifted.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const program = path.join(app.out, 'components', 'shifted.authority.mts');
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        `const { counted, method, withinSteps } = await import(${JSON.stringify(steps)});`,
        "const $ = { client: (part) => part, counted, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }), method };",
        `const { d0 } = (await import(${JSON.stringify(program)})).evaluate({ projectId: 'p1' }, $).sites;`,
        'const shown = (count) => {',
        '  try {',
        '    return withinSteps(() => d0.render({ count })).props.id;',
        '  } catch (error) {',
        '    return error.name;',
        '  }',
        '};',
        'process.stdout.write(JSON.stringify([shown(1), shown(1000000000)]));',
      ].join('\n'),
      app.root,
    );

    expect(written).toContain('$.counted(ONE) << $.counted(');
    expect(written).toContain('$.counted(count) * 2');
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout)).toStrictEqual(['TypeError', 'TypeError']);
  });

  it('reads the kind of a state a site reads of `as const`, of `satisfies`, and of a brand’s intersection', async () => {
    const { compiled } = await compiling({
      'components/branded.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Branded({ projectId, first }: { projectId: string; first: string }) {',
        "  const [constant, setConstant] = useReactiveState('t1' as const);",
        '  const [satisfied, setSatisfied] = useReactiveState(first satisfies string);',
        "  const [branded, setBranded] = useReactiveState<string & { readonly brand: 'Id' }>(",
        "    first as string & { readonly brand: 'Id' },",
        '  );',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setConstant(\'t1\')}>constant</button>',
        '      <button type="button" onClick={() => setSatisfied(\'t2\')}>satisfied</button>',
        '      <button type="button" onClick={() => setBranded(first as string & { readonly brand: \'Id\' })}>branded</button>',
        '      <TodoCommands projectId={projectId} id={constant + satisfied + branded} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it.each([
    ['append', "{ append(value: string) { return value + '!'; } }", 'first'],
    ['abort', '{ abort: (value: string) => value }', 'first'],
    ['setInt8', '{ setInt8: (value: string) => value }', 'first'],
    ['values', '{ values: (value: string) => [value].join() }', 'first'],
    ['entries', '{ entries: (value: string) => value }', 'first'],
    ['set', '{ set: (value: string) => value }', 'first'],
    ['union', '{ union: (value: string) => value }', 'first'],
    ['match', '{ match: (value: string) => value }', 'first'],
    ['then', '{ then: (value: string) => value }', 'first'],
    ['compile', '{ compile: (value: string) => value }', 'first'],
    ['subarray', '{ subarray: (value: string) => value }', 'first'],
    ['toFixed', '{ toFixed: (digits: number) => String(digits) }', '200'],
    ['normalize', '{ normalize: (form: string) => form }', "'bad'"],
  ])(
    'starts a state of what an object’s own `%s`, held by a constant, answers',
    async (name, helper, given) => {
      const { compiled } = await compiling({
        'components/owned.reactive.tsx': file(
          "import { useReactiveState } from 'framework/react';",
          "import TodoCommands from '@/components/todo-commands.reactive';",
          '',
          'export default function Owned({ projectId, first }: { projectId: string; first: string }) {',
          `  const helper = ${helper};`,
          `  const [owned, setOwned] = useReactiveState<string>(helper.${name}(${given}));`,
          '  return (',
          '    <section>',
          '      <button type="button" onClick={() => setOwned(\'\')}>clear</button>',
          '      <TodoCommands projectId={projectId} id={owned + first} />',
          '    </section>',
          '  );',
          '}',
        ),
      });

      expect(compiled.refusals).toStrictEqual([]);
    },
  );

  it.each(['append', 'values', 'set', 'match'])(
    'starts a state of what a module’s function `%s`, of its namespace, answers',
    async (name) => {
      const { compiled } = await compiling({
        'components/owned.reactive.tsx': file(
          "import { useReactiveState } from 'framework/react';",
          "import TodoCommands from '@/components/todo-commands.reactive';",
          "import * as lists from '@/domain/lists';",
          '',
          'export default function Owned({ projectId, first }: { projectId: string; first: string }) {',
          `  const [owned, setOwned] = useReactiveState<string>(lists.${name}(first));`,
          '  return (',
          '    <section>',
          '      <button type="button" onClick={() => setOwned(\'\')}>clear</button>',
          '      <TodoCommands projectId={projectId} id={owned} />',
          '    </section>',
          '  );',
          '}',
        ),
        'domain/lists.ts': file(
          `export function ${name}(value: string): string {`,
          '  return value;',
          '}',
        ),
      });

      expect(compiled.refusals).toStrictEqual([]);
    },
  );

  it('reads no throw of text’s methods into a module’s functions of their names, or an object’s own, `text.normalize(…)`', async () => {
    const { compiled } = await compiling({
      'components/normalized.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import * as text from '@/domain/text';",
        '',
        'export default function Normalized({ projectId }: { projectId: string }) {',
        "  const [value, setValue] = useReactiveState<string>(text.normalize('  Hi ') + text.replaceAll(/a/, 'b') + ({ toFixed: (digits: number) => String(digits) }).toFixed(200));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setValue(\'2\')}>2</button>',
        '      <TodoCommands projectId={projectId} id={value} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/text.ts': file(
        'export function normalize(value: string): string {',
        "  return value + '!';",
        '}',
        '',
        'export function replaceAll(pattern: RegExp, by: string): string {',
        '  return pattern.source + by;',
        '}',
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('folds no method of a module’s named as a function of the language’s, `helper.parseFloat`', async () => {
    const { compiled } = await compiling({
      'components/parsed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import * as helper from '@/domain/parse';",
        '',
        'export default function Parsed({ projectId }: { projectId: string }) {',
        "  const [value, setValue] = useReactiveState<number>(helper.parseFloat('x'));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setValue(2)}>2</button>',
        '      <TodoCommands projectId={projectId} id={String(value)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/parse.ts': file(
        'export function parseFloat(text: string): number {',
        '  return text.length;',
        '}',
      ),
    });

    expect(compiled.refusals).toStrictEqual([]);
  });

  it('writes a constant computed in place as the type it is annotated with', async () => {
    const { app, compiled } = await compiling({
      'components/annotated.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Annotated({ projectId }: { projectId: string }) {',
        "  const [selectedId, setSelectedId] = useReactiveState('t1');",
        '  const none: string[] = [];',
        '  const ids = none.concat([selectedId]);',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelectedId(\'t2\')}>t2</button>',
        "      <TodoCommands projectId={projectId} id={ids[0] ?? ''} />",
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/annotated.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain(
      'id: $.counted($.method(($.counted([]) as string[]), "concat")($.counted([selectedId])))[0] ?? \'\'',
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('writes a constant of an operator computed in place whole as the type it is annotated with', async () => {
    const { app, compiled } = await compiling({
      'components/annotated.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Annotated({ projectId }: { projectId: string }) {',
        "  const [selectedId, setSelectedId] = useReactiveState('t1');",
        "  const shown: 'none' | 't1' | 't2' = selectedId === '' ? 'none' : selectedId === 't1' ? 't1' : 't2';",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelectedId(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={shown} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/annotated.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain(
      "id: ((selectedId === '' ? 'none' : selectedId === 't1' ? 't1' : 't2') as 'none' | 't1' | 't2')",
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('reads a prop named as a global whose members the grammar holds to rules as the prop', async () => {
    const { app, compiled } = await compiling({
      'components/named.reactive.tsx': file(
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Named({ projectId, Math }: { projectId: string; Math: number }) {',
        "  const [selectedId, setSelectedId] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setSelectedId(\'t2\')}>t2</button>',
        "      <TodoCommands projectId={projectId} id={Math > 0 ? selectedId : ''} />",
        '    </section>',
        '  );',
        '}',
      ).replace(
        'import TodoCommands',
        () => "import { useReactiveState } from 'framework/react';\nimport TodoCommands",
      ),
    });
    const program = output(compiled, app, 'components/named.authority.mts');

    expect(program).toContain("id: Math > 0 ? selectedId : ''");
  });

  it('writes in place a hook’s function that takes the name of a global the component reads elsewhere', async () => {
    const { app, compiled } = await compiling({
      'components/scoped.reactive.tsx': file(
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { useCount } from '@/hooks/use-count';",
        '',
        'export default function Scoped({ projectId }: { projectId: string }) {',
        '  const { setCount, first } = useCount(1);',
        "  const label = String(first + Number('2'));",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setCount((value) => value + 1)}>more</button>',
        '      <TodoCommands projectId={projectId} id={label} />',
        '    </section>',
        '  );',
        '}',
      ),
      'hooks/use-count.ts': file(
        "import { useReactiveState } from 'framework/react';",
        '',
        'export function useCount(initial: number) {',
        '  const [count, setCount] = useReactiveState(initial);',
        '  const first = [count].map((Number) => Number)[0];',
        '  return { count, setCount, first };',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/scoped.authority.mts')).toContain(
      'id: $.counted(String($.counted($.counted($.method($.counted([count]), "map")((Number) => $.counted(Number)))[0] + $.counted(Number(\'2\')))))',
    );
  });

  it('keys the states of two hooks of one name, of two modules, by two calls of it', async () => {
    const choice = (other: string): string => {
      return file(
        "import { useReactiveState } from 'framework/react';",
        '',
        'export function useChoice(initial: string) {',
        '  const [choice, setChoice] = useReactiveState(initial);',
        `  const other = ${other};`,
        '  return { choice, setChoice, other };',
        '}',
      );
    };
    const { app, compiled } = await compiling({
      'components/choices.reactive.tsx': file(
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { useChoice } from '@/hooks/use-choice';",
        "import { useChoice as useOtherChoice } from '@/hooks/use-other-choice';",
        '',
        'export default function Choices({ projectId }: { projectId: string }) {',
        "  const { setChoice, other } = useChoice('t1');",
        "  const { setChoice: setOtherChoice, other: another } = useOtherChoice('t2');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setChoice(\'t2\')}>one</button>',
        '      <button type="button" onClick={() => setOtherChoice(\'t1\')}>two</button>',
        '      <TodoCommands projectId={projectId} id={other} />',
        '      <TodoCommands projectId={projectId} id={another} />',
        '    </section>',
        '  );',
        '}',
      ),
      'hooks/use-choice.ts': choice("choice === 't1' ? 't2' : 't1'"),
      'hooks/use-other-choice.ts': choice("choice + '!'"),
    });
    const program = output(compiled, app, 'components/choices.authority.mts');
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(program).toContain(
      'states: { "useChoice#0.choice": \'t1\' as string, "useChoice#1.choice": \'t2\' as string },',
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });

  it('registers two updates told apart only by the text around a template’s substitutions as two', async () => {
    const { app, compiled } = await compiling({
      'components/marks.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import { db } from '@/db';",
        '',
        'export default function Marks({ id }: { id: string }) {',
        '  const [title, setTitle] = useReactiveState(db.todos.ref(id).title);',
        '  return (',
        '    <p>',
        '      {title}',
        `      <button type="button" onClick={() => setTitle((current) => \`\${current}!\`)}>!</button>`,
        `      <button type="button" onClick={() => setTitle((current) => \`\${current}?\`)}>?</button>`,
        '    </p>',
        '  );',
        '}',
      ),
    });
    const program = output(compiled, app, 'components/marks.authority.mts');
    const applies = [
      ...program.matchAll(/"(u_[\da-f]{20})": \{ keys: \["title"\], kind: "apply"/gu),
    ];

    expect(new Set(applies.map((match) => match[1])).size).toBe(2);
  });

  it('reads a module that imports its own directory, `.`, as the module that directory’s index is', async () => {
    const { app, compiled } = await compiling({
      'components/twice.reactive.tsx': file(
        "import { twice } from '@/domain/twice';",
        '',
        'export default function Twice({ value }: { value: number }) {',
        '  return <p>{twice(value)}</p>;',
        '}',
      ),
      'domain/index.ts':
        'export function double(value: number): number {\n  return value * 2;\n}\n',
      'domain/twice.ts':
        "import { double } from '.';\n\nexport function twice(value: number): number {\n  return double(value);\n}\n",
    });

    expect(output(compiled, app, 'components/twice.authority.mts')).toContain(
      "import { twice } from '@/domain/twice';",
    );
  });

  it('keeps a component and a server module whose id is `__proto__` as their maps’ own keys', async () => {
    const { app, compiled } = await compiling({
      '__proto__.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import { db } from '@/db';",
        '',
        'export default function Proto({ id }: { id: string }) {',
        '  const [title, setTitle] = useReactiveState(db.todos.ref(id).title);',
        '  return <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />;',
        '}',
      ),
      '__proto__.ts': file(
        "'use server';",
        '',
        "import { db } from '@/db';",
        '',
        'export async function rename(id: string): Promise<void> {',
        '  await db.transaction(async () => {',
        "    await db.todos.update(id, { title: 'renamed' });",
        '  });',
        '}',
      ),
      'components/rename.reactive.tsx': file(
        "import { rename } from '@/__proto__';",
        '',
        'export default function Rename({ id }: { id: string }) {',
        '  return <form action={rename.bind(null, id)}><button>rename</button></form>;',
        '}',
      ),
    });

    // As it is, `"__proto__": …` sets an object literal's prototype; computed, it is a key.
    expect(output(compiled, app, 'elements.ts')).toMatch(/^ {4}\["__proto__"\]: /mu);
    expect(output(compiled, app, 'authority.mts')).toMatch(/\{ \["__proto__"\]: /u);
  });

  it('compiles a component of no props, and one whose props it renames', async () => {
    const { app, compiled } = await compiling({
      'components/plain.reactive.tsx': file(
        'export default function Plain() {',
        '  return <p>plain</p>;',
        '}',
      ),
      'components/renamed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import { db } from '@/db';",
        '',
        'export default function Renamed({ id: todoId }: { id: string }) {',
        '  const [title] = useReactiveState(db.todos.ref(todoId).title);',
        '  return <p data-id={todoId}>{title}</p>;',
        '}',
      ),
    });

    expect(output(compiled, app, 'components/plain.authority.mts')).toContain(
      'export function evaluate(_props: Readonly<Record<string, unknown>>, $: RenderScope) {\n  return $.h("p", null, "plain");\n}',
    );
    expect(output(compiled, app, 'components/plain.root.tsx')).toContain(
      'export default async function Plain() {\n  return renderRoot({ component: "components/plain", elements, props: {}, update, view });\n}',
    );
    expect(output(compiled, app, 'components/renamed.authority.mts')).toContain(
      '    props: { id: todoId },\n    states: { title: db.todos.ref(todoId).title },',
    );
    expect(output(compiled, app, 'components/renamed.client.tsx')).toContain(
      '  const { id: todoId } = part.props as { readonly id: string };',
    );
  });

  it('tells a shared module from one only the authority runs, and from one that runs on one side alone', async () => {
    const { app, compiled } = await compiling({
      'components/kinds.reactive.tsx': file(
        "import { pure } from '@/lib/pure';",
        "import { reads } from '@/lib/reads';",
        "import { library } from '@/lib/library';",
        "import { cycle } from '@/lib/cycle-a';",
        "import { isMaker } from '@/lib/kind';",
        "import { run } from '@/lib/maker';",
        "import { computed } from '@/lib/evaluator';",
        "import { pulled } from '@/lib/pulled';",
        "import { plain } from '@/lib/plain';",
        "import { aliased } from '@/lib/aliased';",
        '',
        'export default async function Kinds() {',
        '  const read = await reads();',
        '  const named = library;',
        '  const ran = typeof run + typeof computed + typeof pulled + typeof aliased;',
        '  return <p>{pure(read)}{cycle}{named}{ran}{String(isMaker(read))}{plain(read)}</p>;',
        '}',
      ),
      // Of what makes code of text, a module that tests what a value is, or types it, runs anywhere
      // alike; one that calls it does not.
      'lib/kind.ts': file(
        'export type Maker = Function;',
        'export const isMaker = (value: unknown): boolean =>',
        "  value instanceof Function || typeof eval !== 'function' || typeof globalThis.Function !== 'function';",
      ),
      'lib/maker.ts': file('export const run = (source: string): unknown => eval(source);'),
      'lib/evaluator.ts': file(
        "export const computed = (source: string): unknown => globalThis['eval'](source);",
      ),
      // A module that compares what made a value, reads its name, and tests the global object, runs
      // anywhere alike; one that holds the global object under a name of its own does not.
      'lib/plain.ts': file(
        'export function plain(value: string): string {',
        "  const kind = value.constructor === String && value.constructor.name === 'String';",
        "  return kind || typeof window === 'undefined' || 'x' in globalThis ? value : '';",
        '}',
      ),
      'lib/aliased.ts': file(
        'const globals = globalThis;',
        'export const aliased = () => globals.Math;',
      ),
      'lib/pulled.ts': file(
        'const { eval: taken } = globalThis;',
        'export const pulled = (source: string): unknown => taken(source);',
      ),
      'lib/cycle-a.ts': file(
        "import { other } from '@/lib/cycle-b';",
        "export const cycle = 'a';",
        'export const echo = other;',
      ),
      'lib/cycle-b.ts': file(
        "import { echo } from '@/lib/cycle-a';",
        "export const other = 'b';",
        'export const back = () => echo;',
      ),
      'lib/library.ts': file(
        "import { useId } from 'react';",
        'export const library = typeof useId;',
      ),
      'lib/pure.ts': file(
        "import type { User } from '@/auth';",
        'export const pure = (value: string): string => value.trim();',
        'export type Who = User;',
      ),
      'lib/reads.ts': file(
        "import { db } from '@/db';",
        'export const reads = async (): Promise<string> => String(Object.keys(db).length);',
      ),
    });

    expect(JSON.parse(output(compiled, app, 'manifest.json')) as unknown).toMatchObject({
      modules: {
        '@/lib/cycle-a': 'shared',
        '@/lib/evaluator': 'package',
        '@/lib/kind': 'shared',
        '@/lib/library': 'package',
        '@/lib/aliased': 'package',
        '@/lib/maker': 'package',
        '@/lib/plain': 'shared',
        '@/lib/pulled': 'package',
        '@/lib/pure': 'shared',
        '@/lib/reads': 'server',
      },
    });
  });

  it('refuses a module that runs on one side alone, read in the JSX the authority renders', async () => {
    const app = await application({
      'components/kinds.reactive.tsx': file(
        "import { library } from '@/lib/library';",
        '',
        'export default function Kinds() {',
        '  return <p>{library}</p>;',
        '}',
      ),
      'lib/library.ts': file(
        "import { useId } from 'react';",
        'export const library = typeof useId;',
      ),
    });
    apps.push(app);

    expect(refusalOf(compile(app))).toMatchObject({
      fileName: 'components/kinds.reactive.tsx',
      reason: expect.stringContaining(
        "`library` is `@/lib/library`'s, and is read in JSX the authority renders",
      ) as unknown,
    });
  });

  it('refuses two outputs of one path: a module of the application’s that takes a name the compile writes', async () => {
    const app = await application({
      'components/clash.reactive.tsx': file(
        "import { useElements } from '@/elements';",
        '',
        'export default function Clash() {',
        '  const [count] = useElements();',
        '  return <p>{count}</p>;',
        '}',
      ),
      'elements.ts': file(
        "import { useReactiveState } from 'framework/react';",
        'export function useElements() {',
        '  const [count] = useReactiveState(0);',
        '  return [count] as const;',
        '}',
      ),
    });
    apps.push(app);

    expect(refusalOf(compile(app)).message).toContain(
      'Two of what the compile writes are `elements.ts`',
    );
  });

  it('refuses a module of hooks outside the source directory, which it cannot copy', async () => {
    const app = await application({
      'components/far.reactive.tsx': file(
        "import { useFar } from '@far/hooks';",
        '',
        'export default function Far() {',
        '  const [value] = useFar();',
        '  return <p>{value}</p>;',
        '}',
      ),
    });
    apps.push(app);
    await mkdir(path.join(app.root, 'far'), { recursive: true });
    await writeFile(
      path.join(app.root, 'far/hooks.ts'),
      file(
        "import { useReactiveState } from 'framework/react';",
        'export function useFar() {',
        '  const [value] = useReactiveState(0);',
        '  return [value] as const;',
        '}',
      ),
    );
    await writeFile(
      app.tsconfig,
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
            '@far/*': ['./far/*'],
            'framework/*': ['../src/framework/*.ts'],
          },
        },
      }),
    );

    expect(refusalOf(compile(app)).message).toContain(
      "A module of custom hooks is the compile's to copy, so it is in its source directory.",
    );
  });
});

describe('dynamic sites, and the nodes a component is given', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;
  const apps: Application[] = [];

  beforeAll(async () => {
    api = openTypeScript();
    app = await application({
      'components/card.reactive.tsx': CARD,
      'components/frame.reactive.tsx': FRAME,
      'components/framed.reactive.tsx': FRAMED,
      'components/results.reactive.tsx': RESULTS,
      'components/workspace.reactive.tsx': WORKSPACE,
      'controls/disclosure.tsx': DISCLOSURE,
    });
    apps.push(app);
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const each of apps) {
      await removed(each);
    }
  });

  async function compiling(
    files: Readonly<Record<string, string>>,
  ): Promise<{ app: Application; compiled: Compiled }> {
    const made = await application(files);
    apps.push(made);
    const result = compiledApp(made, api);
    if (result.refusals.length > 0) {
      throw new Error(result.refusals.map((refusal) => refusal.message).join('\n'));
    }
    return { app: made, compiled: result };
  }

  it('takes a state a site reads typed of one kind of JSON, however its union writes it', async () => {
    const { compiled: taken } = await compiling({
      'components/kinds.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Kinds({ projectId }: { projectId: string }) {',
        '  const [step, setStep] = useReactiveState<1 | -1 | null>(1);',
        "  const [ids] = useReactiveState<readonly string[] | (string[] | null)>(['t1']);",
        "  const [key] = useReactiveState<NonNullable<'a' | null>>('a');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setStep(-1)}>back</button>',
        '      <TodoCommands projectId={projectId} id={String(step)} />',
        "      <TodoCommands projectId={projectId} id={ids === null ? '' : key} />",
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a state a site reads typed of an alias or an interface of one kind of JSON, imported, and a generic hook’s of its constraint', async () => {
    const { compiled: taken } = await compiling({
      'components/typed.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import type { Choice, Shape, Tagged } from '@/domain/choices';",
        '',
        'export default function Typed({ projectId, first }: { projectId: string; first: Readonly<{ choice: Choice }> }) {',
        '  const [choice, setChoice] = useReactiveState(first.choice);',
        '  const [shape] = useReactiveState<Shape | null>(null);',
        "  const [tag] = useReactiveState<Tagged['tag']>('x');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setChoice(\'b\')}>b</button>',
        "      <TodoCommands projectId={projectId} id={choice + tag + (shape === null ? '' : shape.id)} />",
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
      'domain/choices.ts': [
        "type Letter = 'a' | 'b';",
        'export type Choice = Letter;',
        'export interface Shape {',
        '  readonly id: string;',
        '}',
        'export interface Tagged extends Shape {',
        "  readonly tag: 'x' | 'y';",
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a state a site reads typed of JSON all through: entries that may be left out, of itself, of entries of text', async () => {
    const { compiled: taken } = await compiling({
      'components/nested.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import type { Tree } from '@/domain/tree';",
        '',
        'export default function Nested({ projectId }: { projectId: string }) {',
        '  const [tree] = useReactiveState<Tree | null>(null);',
        '  const [labels] = useReactiveState<Readonly<Record<string, string | undefined>>>({});',
        '  const [pairs] = useReactiveState<readonly (readonly [string, number])[]>([]);',
        "  const [seen] = useReactiveState({ ids: ['t1'], meta: { count: 1, done: false } });",
        '  return (',
        '    <section>',
        "      <TodoCommands projectId={projectId} id={(tree === null ? '' : tree.id) + Object.keys(labels).join('') + String(pairs.length) + seen.ids.join('')} />",
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
      'domain/tree.ts': [
        'export interface Tree {',
        '  readonly id: string;',
        '  readonly note?: string;',
        '  readonly children: readonly Tree[];',
        '  readonly options: { readonly color?: string };',
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a state a site reads typed of the language’s types of objects, of the members they make', async () => {
    const { compiled: taken } = await compiling({
      'components/made.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import type { Choice, Filter, Shown } from '@/domain/made';",
        '',
        'export default function Made({ projectId }: { projectId: string }) {',
        '  const [shown] = useReactiveState<Shown | null>(null);',
        "  const [labels] = useReactiveState<Record<'draft' | 'done', string>>({ draft: 'd', done: 'x' });",
        '  const [counts] = useReactiveState<Readonly<Record<Filter, number>>>({ all: 0, active: 0 });',
        '  const [patch] = useReactiveState<Partial<{ title: string; done: boolean }>>({});',
        "  const [whole] = useReactiveState<Required<{ title?: string }>>({ title: '' });",
        '  const [choice] = useReactiveState<Choice>(0);',
        '  return (',
        '    <section>',
        "      <TodoCommands projectId={projectId} id={(shown === null ? '' : shown.id) + labels.draft + String(patch.done) + whole.title + String(choice) + String(counts.all)} />",
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
      'domain/made.ts': [
        'interface Todo {',
        '  readonly id: string;',
        '  readonly title: string;',
        '  toggle(): void;',
        '}',
        "export type Shown = Pick<Omit<Todo, 'toggle'>, 'id' | 'title'>;",
        "export type Filter = 'all' | 'active';",
        'export enum Choice {',
        '  First,',
        '  Second = -2,',
        '  Third = 1e3,',
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a local state’s setter under another name, called from a handler, through `.call` too', async () => {
    const { compiled: taken } = await compiling({
      'components/again.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Again({ projectId }: { projectId: string }) {',
        "  const [id, setId] = useReactiveState('t1');",
        '  const again = setId;',
        "  const either = id === 't1' ? setId : again;",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => again(\'t2\')}>t2</button>',
        '      <button type="button" onClick={() => either.call(undefined, \'t3\')}>t3</button>',
        '      <TodoCommands projectId={projectId} id={id} />',
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes local writers in containers called or handed on from a handler, and reads their non-writing siblings while rendering', async () => {
    const { compiled: taken } = await compiling({
      'components/contained.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Contained({ projectId }: { projectId: string }) {',
        "  const [id, setId] = useReactiveState('t1');",
        "  const reset = (): void => { setId('t1'); };",
        "  const actions = { reset, change: setId, label: () => 'label' };",
        '  const elementRef = { current: null, reset };',
        '  const copies = [{ ...actions }];',
        '  const again = copies[0].reset;',
        '  return (',
        '    <section ref={elementRef}>',
        "      <p ref={actions.label}>{actions.label()}{({ reset: setId, label: () => 'inline' }).label()}</p>",
        '      <button type="button" onClick={actions.reset}>reset</button>',
        '      <button type="button" onClick={() => {',
        "        actions.change('t2');",
        "        copies[0]['change'].call(undefined, 't3');",
        "        copies[0].change.apply(undefined, ['t4']);",
        "        ['t5'].forEach(actions.change);",
        '        again();',
        '      }}>change</button>',
        '      <TodoCommands projectId={projectId} id={id} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes destructured local writers called from handlers, while rendering their non-writing siblings', async () => {
    const { compiled: taken } = await compiling({
      'components/destructured.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Destructured({ projectId }: { projectId: string }) {',
        "  const [id, setId] = useReactiveState('t1');",
        "  const [{ change, meta: { read } }, second] = [{ change: setId, meta: { read: () => 'label' } }, () => 'second'] as const;",
        "  const { nested: [, again, pure] } = { nested: [0, setId, () => 'pure'] as const };",
        "  const { ['nested']: { ['write']: renamed } } = { nested: { write: setId } };",
        '  const [only] = [read] as const;',
        '  return (',
        '    <section>',
        '      <p ref={read}>{read()}{second()}{pure()}{only()}</p>',
        '      <button type="button" onClick={() => {',
        "        change('t2');",
        "        again('t3');",
        "        renamed.call(undefined, 't4');",
        "        ['t5'].forEach(again);",
        '      }}>change</button>',
        '      <TodoCommands projectId={projectId} id={id} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes rest-bound writers in handlers, and renders only the non-writing rest entries and present defaults', async () => {
    const { compiled: taken } = await compiling({
      'components/rested.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Rested({ projectId }: { projectId: string }) {',
        "  const [id, setId] = useReactiveState('t1');",
        "  const { skip, ...pureObject } = { skip: setId, read: () => 'object' };",
        "  const [skipped, ...pureArray] = [setId, () => 'array'] as const;",
        "  const [spreadSkipped, ...pureSpread] = [setId, ...[() => 'spread']] as const;",
        "  const [, ...[omitted, ...pureNested]] = [0, setId, () => 'nested'] as const;",
        "  const { nested: { leave, ...pureDeep } } = { nested: { leave: setId, read: () => 'deep' } };",
        "  const excluded = 'write';",
        "  const { [excluded]: removed, ...computedPure } = { write: setId, read: () => 'computed' };",
        "  const [readArray = setId] = [() => 'defined-array'] as const;",
        "  const { read: readObject = setId } = { read: () => 'defined-object' };",
        "  const [{ read: readNested } = { read: setId }] = [{ read: () => 'defined-nested' }];",
        '  const { toString: objectText = setId } = pureObject;',
        '  const { toString: arrayText = setId } = pureArray;',
        '  const { ...actions } = { write: setId };',
        '  const [, ...writers] = [0, setId] as const;',
        '  const { nested: { ignored, ...deepWriters } } = { nested: { ignored: 0, write: setId } };',
        '  return (',
        '    <section>',
        '      <p ref={pureObject.read}>{pureObject.read()}{pureArray[0]()}{pureSpread[0]()}{pureNested[0]()}{pureDeep.read()}{computedPure.read()}{readArray()}{readObject()}{readNested()}{objectText()}{arrayText()}</p>',
        '      <button type="button" onClick={() => {',
        "        actions.write('t2');",
        "        writers[0]('t3');",
        "        deepWriters.write.call(undefined, 't4');",
        "        ['t5'].forEach(actions.write);",
        '      }}>change</button>',
        '      <TodoCommands projectId={projectId} id={id} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes local writers that reach each other through aliases when every call is a handler’s', async () => {
    const { compiled: taken } = await compiling({
      'components/cyclic.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Cyclic({ projectId }: { projectId: string }) {',
        "  const [id, setId] = useReactiveState('t1');",
        "  const reset = (next = 't2'): void => { if (id === 't1') again(next); };",
        "  const again = id === 't1' ? setId : reset;",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => again(\'t2\')}>again</button>',
        '      <button type="button" onClick={() => reset()}>reset</button>',
        '      <TodoCommands projectId={projectId} id={id} />',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a function of a module’s namespace named as a value’s method, which no rule of those names', async () => {
    const { compiled: taken } = await compiling({
      'components/named.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import * as helpers from '@/domain/helpers';",
        '',
        'export default function Named({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={helpers.search(text) + helpers.sort(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/helpers.ts': file(
        'export function search(text: string): string {',
        '  return text;',
        '}',
        '',
        'export function sort(text: string): string {',
        '  return text;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes what a shared module answers given to a site’s element: a function of a type of JSON, of type parameters — given a function where what it answers is of none of it — of no type returning JSON, and an entry of JSON of an object, `undefined` where JSON leaves it out', async () => {
    const { compiled: taken } = await compiling({
      'components/answered.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { first, hour, label, LABELS, NONE, pick, plain } from '@/domain/answers';",
        '',
        'export default function Answered({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={label(text)} />',
        '      <TodoCommands projectId={projectId} id={first([text])} />',
        '      <TodoCommands projectId={projectId} id={plain(text)} />',
        "      <TodoCommands projectId={projectId} id={text === 't1' ? LABELS.open : LABELS['none']} />",
        "      <TodoCommands projectId={projectId} id={text === 't2' ? NONE : text} />",
        "      <TodoCommands projectId={projectId} id={pick([text], (item) => item !== '')} />",
        '      <TodoCommands projectId={projectId} id={hour(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/answers.ts': file(
        'export function label(text: string): string {',
        "  return text + '!';",
        '}',
        '',
        'export function first<T>(items: readonly T[]): T {',
        '  return items[0] as T;',
        '}',
        '',
        'export function plain(text: string) {',
        '  return text;',
        '}',
        '',
        "export const LABELS = { none: undefined, open: 'Open' };",
        '',
        'export const NONE = undefined;',
        '',
        'export function pick<T>(items: readonly T[], by: (item: T) => boolean): T {',
        '  return items.find(by) as T;',
        '}',
        '',
        // A date's parts in UTC, its ISO text, a table, a date and a pattern of no `g` it reads but
        // never changes, and a test of whether a global of the language's is there, answer alike.
        "const NAMES = new Map([['t1', 'one']]);",
        'const WORD = /^t/;',
        'const EPOCH = new Date(0);',
        // A method of an object it keeps that reads `this`, and one of what a class makes each call
        // that writes through it, keep nothing between calls.
        "const FORMAT = { suffix: '!', label(value: string): string { return value + this.suffix; } };",
        'class Builder {',
        '  items: string[] = [];',
        '  add(value: string): Builder {',
        '    this.items.push(value);',
        '    return this;',
        '  }',
        '}',
        '',
        'export function hour(text: string): string {',
        "  return text + String(new Date(0).getUTCHours()) + new Date(0).toISOString() + (NAMES.get(text) ?? '') + String(WORD.test(text)) + String(EPOCH.getUTCSeconds()) + typeof Map + String('Set' in globalThis) + new Error('x').message + FORMAT.label(text) + new Builder().add(text).items.join() + new URL('https://example.com/' + text).pathname + EPOCH.toISOString() + String(new TextEncoder().encode(text).length) + JSON.stringify(structuredClone({ text }));",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that binds a method that reads what it keeps, `includes`, of no change', async () => {
    const { compiled: taken } = await compiling({
      'components/bound.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { bound } from '@/domain/bound';",
        '',
        'export default function Bound({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={bound(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/bound.ts': file(
        "const FILTERS = ['t1', 't2'];",
        'const has = FILTERS.includes.bind(FILTERS);',
        '',
        'export function bound(text: string): string {',
        "  return has(text) ? text : 't1';",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that makes a `Request` and redirects of URLs it shows absolute, and compression streams of the formats every side holds', async () => {
    const { compiled: taken } = await compiling({
      'components/requested.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { requested } from '@/domain/requested';",
        '',
        'export default function Requested({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={requested(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/requested.ts': file(
        "const BASE = 'https://example.com/';",
        '',
        'export function requested(text: string): string {',
        `  const urls = [new Request(\`https://example.com/\${text}\`).url, new Request(BASE + text).url, new Request(new URL(text, BASE)).url, Response.redirect('https://example.com/x').headers.get('location') ?? ''];`,
        "  const streams = [new CompressionStream('gzip'), new DecompressionStream('deflate-raw'), new CompressionStream('deflate')];",
        '  return urls.join() + String(streams.length);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that logs an error and closes what of its own holds a `close`, of no stream', async () => {
    const { compiled: taken } = await compiling({
      'components/logged.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { logged } from '@/domain/logged';",
        '',
        'export default function Logged({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={logged(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/logged.ts': file(
        'const logger = { close(): void {} };',
        '',
        'export function logged(text: string): string {',
        "  console.error('logging', text);",
        '  logger.close();',
        '  return text;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes optional chains that short-circuit known nullish reads, keys and arguments', async () => {
    const { compiled: taken } = await compiling({
      'components/optional.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function Optional({ projectId, first }: { projectId: string; first: string }) {',
        "  const [text, setText] = useReactiveState<string>(first === '' ? ((null as any)?.value.other, (undefined as any)?.value?.other, (null as any)?.[Number(Symbol('unused'))], (null as any)?.method(Number(Symbol('unused'))), ((null as any)?.value)?.other, (void 0 as any)?.value, (1 as any).missing, (true as any).missing, 'ok') : first);",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={text} /></button>;",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('leaves a shared helper’s Unicode data and numeric approximations to the application’s contract', async () => {
    const { compiled: taken } = await compiling({
      'components/engine.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { engineText } from '@/domain/engine';",
        'export default function Engine({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={engineText(text)} /></button>;",
        '}',
      ),
      'domain/engine.ts': file(
        'export function engineText(value: string): string {',
        '  const text = value.toUpperCase().toLowerCase().normalize().trim();',
        '  return text + String(Math.sin(Number(value))) + String(Math.exp(Number(value)));',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared helper reading ordinary properties named as code globals', async () => {
    const { compiled: taken } = await compiling({
      'components/ordinary.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { ordinary } from '@/domain/ordinary';",
        'export default function Ordinary({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return <TodoCommands projectId={projectId} id={ordinary(text)} />;',
        '}',
      ),
      'domain/ordinary.ts': file(
        'function parameter({ process: text }: { process: string }): string { return text; }',
        'export function ordinary(text: string): string {',
        '  const { self } = { self: text };',
        '  let window = text;',
        '  ({ window } = { window: self });',
        "  const reflected = Reflect.get({ require: window }, 'require') as string;",
        "  const described = Object.getOwnPropertyDescriptor({ eval: text }, 'eval');",
        '  return parameter({ process: reflected }) + String(described?.value ?? text);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared File timestamp shown defined through shorthand, aliases, computed keys or a fallback', async () => {
    const { compiled: taken } = await compiling({
      'components/stamped.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { stamped } from '@/domain/stamped';",
        'export default function Stamped({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={stamped(text)} /></button>;",
        '}',
      ),
      'domain/stamped.ts': file(
        'const lastModified = 0;',
        'const options = { lastModified };',
        'const alias = options;',
        "const key = 'lastModified';",
        'export function stamped(text: string, possible?: number): string {',
        "  const fixed = new File([], 'x', alias).lastModified;",
        "  const fallback = new File([], 'x', { lastModified: possible ?? 0 }).lastModified;",
        "  const computed = new File([], 'x', { [key]: lastModified }).lastModified;",
        "  const replaced = new File([], 'x', { lastModified: undefined, lastModified: 0 }).lastModified;",
        '  return text + String(fixed + fallback + computed + replaced);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared helper changing an Event made within each call', async () => {
    const { compiled: taken } = await compiling({
      'components/cancelled.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { cancelled } from '@/domain/cancelled';",
        'export default function Cancelled({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={cancelled(text)} /></button>;",
        '}',
      ),
      'domain/cancelled.ts': file(
        'export function cancelled(text: string): string {',
        "  const event = new Event('x', { cancelable: true });",
        '  event.preventDefault();',
        '  event.stopPropagation();',
        '  event.stopImmediatePropagation();',
        '  const target = new EventTarget();',
        "  target.addEventListener('x', (each) => each.preventDefault(), { once: true });",
        '  target.dispatchEvent(event);',
        '  EventTarget.prototype.dispatchEvent.call(target, event);',
        '  EventTarget.prototype.dispatchEvent.apply(target, [event]);',
        '  Reflect.apply(EventTarget.prototype.dispatchEvent, target, [event]);',
        '  const dispatch = target.dispatchEvent.bind(target);',
        '  dispatch(event);',
        '  const captured = target.dispatchEvent.bind(target, event);',
        '  captured();',
        '  return event.defaultPrevented ? text : text + String(event.cancelBubble);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes shared dates with fixed instants and bodies with no multipart boundary', async () => {
    const { compiled: taken } = await compiling({
      'components/fixed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { fixed } from '@/domain/fixed';",
        'export default function Fixed({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={fixed(text)} /></button>;",
        '}',
      ),
      'domain/fixed.ts': file(
        "const DAY = '2020-01-01';",
        "const STAMP = '2020-01-01T00:00:00Z';",
        'const ALIAS = STAMP;',
        'function numeric(value: number): number { return new Date(value).getTime(); }',
        'function copied(value: Date): number { return new Date(value).getTime(); }',
        'export function fixed(text: string): string {',
        "  const dates = [new Date(0), new Date(NaN), new Date(DAY), new Date(ALIAS), new Date('2020-01-01T09:00:00+09:00'), new Date(new Date(0))];",
        "  const options = { method: 'POST', body: text };",
        "  const ordinary = new Request('https://example.com', options).headers.get('content-type');",
        "  const overridden = new Request('https://example.com', { method: 'POST', ...{ body: new FormData() }, body: text }).headers.get('content-type');",
        '  const parsed = Date.parse(DAY) + Date.parse(ALIAS);',
        "  const unrelated = new Request('https://example.com', { method: 'POST', ['o' + 'ther']: new FormData() }).headers.get('content-type');",
        "  const choices = text ? { method: 'POST', body: text } : { method: 'POST', body: null };",
        "  const selected = new Request('https://example.com', choices).headers.get('content-type');",
        "  return text + dates.map((date) => date.getTime()).join() + String(numeric(0) + copied(new Date(0)) + parsed) + ordinary + overridden + unrelated + selected + new Response(text).headers.get('content-type');",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared helper making bodies with transparent line endings', async () => {
    const { compiled: taken } = await compiling({
      'components/transparent.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { transparent } from '@/domain/transparent';",
        'export default function Transparent({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={transparent(text)} /></button>;",
        '}',
      ),
      'domain/transparent.ts': file(
        "const endings = 'transparent';",
        'const options = { endings };',
        'const alias = options;',
        'export function transparent(text: string): string {',
        '  const plain = new Blob([text]).size + new Blob([text], {}).size;',
        "  const explicit = new Blob([text], { endings: 'transparent' }).size + new Blob([text], alias).size;",
        '  const defaulted = new Blob([text], { endings: undefined }).size + new Blob([text], undefined).size;',
        "  const overridden = new Blob([text], { ...JSON.parse(text), endings: 'transparent' }).size;",
        "  const dated = new File([text], 'x', { lastModified: 0, endings: 'transparent' }).size;",
        '  return text + String(plain + explicit + defaulted + overridden + dated);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes RegExp symbol methods that restore or clone the pattern, reset global matches, or change only a fresh local pattern', async () => {
    const { compiled: taken } = await compiling({
      'components/symbol-patterns.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { symbolPatterns } from '@/domain/symbol-patterns';",
        'export default function SymbolPatterns({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        "  return <button onClick={() => setText('t2')}><TodoCommands projectId={projectId} id={symbolPatterns(text)} /></button>;",
        '}',
      ),
      'domain/symbol-patterns.ts': file(
        'const PLAIN = /a/;',
        'const GLOBAL = /a/g;',
        'const STICKY = /a/y;',
        'const replace = GLOBAL[Symbol.replace].bind(GLOBAL);',
        'export function symbolPatterns(text: string): string {',
        '  const local = /a/y;',
        "  const localResult = String(local[Symbol.match](text)) + local[globalThis.Symbol.replace](text, '-');",
        "  const plain = String(PLAIN[Symbol.match](text)) + PLAIN[Symbol.replace](text, '-');",
        "  const global = String(RegExp.prototype[Symbol.match].call(GLOBAL, text)) + replace(text, '-');",
        '  const restored = RegExp.prototype[Symbol.search].call(STICKY, text);',
        '  const split = STICKY[Symbol.split](text).length;',
        '  const matches = [...STICKY[Symbol.matchAll](text)].length;',
        '  return text + localResult + plain + global + String(restored + split + matches);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that replaces and matches by a pattern of `g`, or of neither `g` nor `y`, and swaps and loops through names of its own', async () => {
    const { compiled: taken } = await compiling({
      'components/patterned.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { patterned } from '@/domain/patterned';",
        '',
        'export default function Patterned({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={patterned(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/patterned.ts': file(
        String.raw`const SPACES = /\s+/g;`,
        'const WORD = /^t/;',
        'const COPY = new RegExp(WORD);',
        "const flags = 'i';",
        "const MADE = new RegExp('t', flags);",
        "const OVERRIDE = new RegExp(/t/g, 'i');",
        'const MATCHED = new RegExp(/t/g);',
        '',
        'export function patterned(text: string): string {',
        "  let a = text.replace(SPACES, '');",
        "  let b = text.match(WORD) === null || text.match(SPACES) === null ? 'x' : 'y';",
        '  [a, b] = [b, a];',
        "  let last = '';",
        '  for (last of [a, b]) {',
        '    break;',
        '  }',
        '  return a + b + last + String(COPY.test(text)) + String(MADE.test(text)) + String(OVERRIDE.test(text)) + String(text.match(MATCHED));',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that borrows a method to call on what it makes there or on a pattern of neither `g` nor `y`, tests what it catches by its class, and writes a date it is given in UTC', async () => {
    const { compiled: taken } = await compiling({
      'components/borrowed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { borrowed } from '@/domain/borrowed-reads';",
        '',
        'export default function Borrowed({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={borrowed(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/borrowed-reads.ts': file(
        'const word = /t/;',
        "const FILTERS = ['t1', 't2'];",
        'function stamp(date: Date): string {',
        '  return date.toISOString();',
        '}',
        '',
        'export function borrowed(text: string): string {',
        '  const local: string[] = [];',
        '  Array.prototype.push.call(local, text);',
        '  let parsed = true;',
        '  try {',
        '    JSON.parse(text);',
        '  } catch (error) {',
        "    parsed = !(error instanceof SyntaxError) && new Error('x').message === 'x';",
        '  }',
        '  return RegExp.prototype.test.call(word, text) && Array.prototype.includes.call(FILTERS, text) && local.length > 0 && !parsed ? stamp(new Date(0)) : text;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that reads `Math` and `Date` by their members’ names, tests and compares them, takes `max` apart, extends `Error`, dates a `File`, reads an event’s type, and iterates an array it keeps or an iterator as it loads', async () => {
    const { compiled: taken } = await compiling({
      'components/alike.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { alike } from '@/domain/alike-reads';",
        '',
        'export default function Alike({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={alike(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/alike-reads.ts': file(
        'const { max } = Math;',
        'class AppError extends Error {}',
        "const FILTERS = ['t1', 't2'];",
        "const FIRST = [...['t1'].values()][0];",
        '',
        'export function alike(text: string): string {',
        "  const stamp = new File([], 'x', { lastModified: 0 }).lastModified + new Event('x').type.length + max(1, 2);",
        "  const dated = new Date(0) instanceof Date && typeof Math === 'object' && new Date(0).constructor === Date && URL.canParse('https://example.com');",
        "  const listed = FILTERS.includes(text) && Object.keys({ text }).length === 1 && new AppError('x').message === 'x';",
        '  for (const filter of FILTERS) {',
        '    if (filter === FIRST && stamp > 0 && dated && listed) {',
        '      return filter;',
        '    }',
        '  }',
        '  return text;',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('keeps shared metadata reads of fresh copies, primitives and unchanged module values', async () => {
    const { compiled: taken } = await compiling({
      'components/stable-metadata.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { label } from '@/domain/stable-metadata';",
        'export default function StableMetadata({ projectId, first }: { projectId: string; first: readonly string[] }) {',
        '  const [items, setItems] = useReactiveState(first);',
        '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
        '}',
      ),
      'domain/stable-metadata.ts': file(
        'const KEPT = Object.freeze({ ready: true });',
        'export function label(items: readonly string[]): string {',
        '  const copy = [...items];',
        "  const fresh = { value: 'fresh' };",
        '  return String(Object.isFrozen(copy)) + String(Object.isSealed(fresh)) +',
        '    String(Object.isExtensible({})) + String(Object.isFrozen(1)) +',
        "    String(Object.getOwnPropertyDescriptor({ value: 1 }, 'value')?.writable) +",
        '    String(Object.isFrozen(KEPT)) + String(Reflect.isExtensible([])) +',
        '    String(Object.isFrozen(items.length > 0 ? fresh : fresh)) +',
        "    String(Reflect.getOwnPropertyDescriptor(fresh, 'value')?.writable);",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a shared module that locks what it makes there or as it loads, makes text of its values, reads an entry’s name, and keeps calls of functions whose answers write nothing the call declared, nor through `this`', async () => {
    const { compiled: taken } = await compiling({
      'components/settled.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { settle } from '@/domain/settled-calls';",
        '',
        'export default function Settled({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('t1');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'t2\')}>t2</button>',
        '      <TodoCommands projectId={projectId} id={settle(text)} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/settled-calls.ts': file(
        "const FILTERS = Object.freeze(['t1', 't2']);",
        'const helpers = { pick(value: string): string { return value; } };',
        'function sourceOf(value: string): string {',
        '  return value.toString();',
        '}',
        'function makeCounter() {',
        '  let n = 0;',
        '  return () => ++n;',
        '}',
        // A call kept as the module loads whose answer reads what it declared, or whose own
        // functions, called within it alone, write it.
        'function makeReader() {',
        '  const n = 1;',
        '  return () => n;',
        '}',
        'const read = makeReader();',
        'function makeLookup() {',
        '  const index: Record<string, boolean> = {};',
        '  FILTERS.forEach((item) => {',
        '    index[item] = true;',
        '  });',
        '  return (id: string) => index[id] === true;',
        '}',
        'const has = makeLookup();',
        'function makeIndex() {',
        '  const index: Record<string, boolean> = {};',
        '  const add = (id: string) => {',
        '    index[id] = true;',
        '  };',
        '  FILTERS.forEach(add);',
        '  return index;',
        '}',
        'const INDEX = makeIndex();',
        'function makeHolder() {',
        '  return { n: 1, read() { return this.n; } };',
        '}',
        'const holder = makeHolder();',
        '',
        'export function settle(text: string): string {',
        '  const next = makeCounter();',
        '  return text + String(FILTERS.includes(text)) + Object.freeze({ text }).text + helpers.pick.name + String(text) + sourceOf(text) + String(next()) + String(read()) + String(has(text)) + String(holder.read()) + String(INDEX[text]);',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it.each([
    { what: 'text', type: 'string', answer: 'panel.panelId', key: 'keyOf(panel)' },
    { what: 'number', type: 'number', answer: 'panel.panelId.length', key: 'keyOf(panel)' },
    {
      what: 'nullable fallback',
      type: 'string | null',
      answer: 'panel.panelId || null',
      key: 'keyOf(panel) ?? panel.panelId',
    },
    {
      what: 'optional fallback',
      type: 'string | undefined',
      answer: 'panel.panelId || undefined',
      key: 'keyOf(panel) ?? panel.panelId',
    },
    {
      what: 'typed result member',
      type: '{ readonly id?: string }',
      answer: '{ id: panel.panelId }',
      key: 'keyOf(panel).id ?? panel.panelId',
    },
    {
      what: 're-exported type alias',
      type: 'TextKey',
      answer: 'panel.panelId',
      key: 'keyOf(panel)',
    },
    {
      what: 'namespace arrow',
      type: 'string',
      answer: 'panel.panelId',
      key: 'helpers.keyOf(panel)',
    },
    { what: 'imported callee alias', type: 'string', answer: 'panel.panelId', key: 'read(panel)' },
    { what: 'generic return', type: 'T', answer: 'panel.panelId as T', key: 'keyOf(panel)' },
    { what: 'public overload', type: 'string', answer: 'panel.panelId', key: 'keyOf(panel)' },
  ])('takes declared-return list keys of $what', async ({ what, type, answer, key }) => {
    const { compiled: taken } = await compiling({
      'components/declared-key.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { keyOf } from '@/domain/key-export';",
        "import { keyOf as read } from '@/domain/key-export';",
        "import * as helpers from '@/domain/key-export';",
        '',
        'export default function DeclaredKey({ projectId, initial }: { projectId: string; initial: readonly { readonly panelId: string }[] }) {',
        '  const [panels, setPanels] = useReactiveState(initial);',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setPanels([])}>clear</button>',
        variant(
          '      {panels.map((panel) => <TodoCommands key={__KEY__} projectId={projectId} id={panel.panelId} />)}',
          '__KEY__',
          key,
        ),
        '    </section>',
        '  );',
        '}',
      ),
      'domain/key-export.ts': "export { keyOf } from './declared-key';\n",
      'domain/key-kind.ts': 'export type TextKey = string;\n',
      'domain/declared-key.ts': file(
        "import type { TextKey } from './key-kind';",
        'type T = bigint;',
        declaredKeyHelper(what, type, answer),
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a list’s key of a member its type says may be left out where it falls back, `??`, on one its items hold', async () => {
    const { compiled: taken } = await compiling({
      'components/fallback-keys.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function FallbackKeys({ projectId }: { projectId: string }) {',
        '  const [panels, setPanels] = useReactiveState<readonly { readonly panelId?: string; readonly todoId: string }[]>([]);',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setPanels([{ todoId: \'t1\' }])}>open</button>',
        '      {panels.map((panel) => <TodoCommands key={panel.panelId ?? panel.todoId} projectId={projectId} id={panel.todoId} />)}',
        '    </section>',
        '  );',
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a state of a type of itself through what the language makes of it, `Partial<Tree>`, read once', async () => {
    const { compiled: taken } = await compiling({
      'components/tree-view.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import type { Tree } from '@/domain/tree';",
        '',
        'export default function TreeView({ projectId }: { projectId: string }) {',
        "  const [tree, setTree] = useReactiveState<Tree>({ children: [], id: 't1' });",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setTree({ children: [], id: \'t2\' })}>t2</button>',
        '      <TodoCommands projectId={projectId} id={tree.id} />',
        '    </section>',
        '  );',
        '}',
      ),
      'domain/tree.ts': file(
        'export type Tree = {',
        '  readonly id: string;',
        '  readonly children: readonly Partial<Tree>[];',
        '};',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes a state started of what a shared function typed of a predicate answers, a boolean, and of a global’s function of JSON beside one of no JSON', async () => {
    const { compiled: taken } = await compiling({
      'components/checked.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { isText } from '@/domain/checks';",
        '',
        'export default function Checked({ projectId }: { projectId: string }) {',
        '  const [checked, setChecked] = useReactiveState<boolean>(isText(projectId));',
        '  const [locales, setLocales] = useReactiveState<readonly string[]>(Intl.NumberFormat.supportedLocalesOf([projectId]));',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setChecked(false)}>uncheck</button>',
        '      <button type="button" onClick={() => setLocales([])}>clear</button>',
        "      <TodoCommands projectId={projectId} id={checked ? 't1' : locales.join('')} />",
        '    </section>',
        '  );',
        '}',
      ),
      'domain/checks.ts': file(
        'export function isText(value: unknown): value is string {',
        "  return typeof value === 'string';",
        '}',
      ),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('takes radices both sides answer alike, a `this` given an arrow function, which has none of its own, and an array filled with a number of its sign, `fill(-1)`', async () => {
    const { compiled: taken } = await compiling({
      'components/radices.reactive.tsx': [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function Radices({ projectId }: { projectId: string }) {',
        "  const [text, setText] = useReactiveState('10');",
        '  const read = parseInt(text) + parseInt(text, 10) + Number.parseInt(text, 0x10) + parseInt(text, 2);',
        '  const written = read.toString() + read.toString(10) + String(read);',
        "  const kept = [text].map((each) => each, [text]).join('');",
        "  const dashed = text.replaceAll('-', '$$`');",
        "  const signed = [read, read].fill(-1).join('');",
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setText(\'11\')}>11</button>',
        '      <TodoCommands projectId={projectId} id={written + kept + dashed + signed} />',
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(taken.refusals).toStrictEqual([]);
  });

  it('renders a reactive child of local states at a dynamic site: its inputs, its guard, its element', () => {
    const program = output(compiled, app, 'components/workspace.authority.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(program).toContain(
      [
        '  const heading = projectId.toUpperCase();',
        '  return $.client({',
        '    props: { choices },',
        '    states: { filter: initialFilter, selectedId: initialSelectedId, showDetails: true },',
        '    slots: { s0: children },',
        '    sites: {',
        '      d0: { inputs: ["filter"], render: ({ filter }) => $.h(Results, { heading: heading, projectId: projectId, filter: filter }) },',
        `      d1: { inputs: ["selectedId", "showDetails"], guard: ({ showDetails, selectedId }) => showDetails && selectedId !== '', render: ({ selectedId }) => $.h(TodoDetails, { key: $.counted(\`\${projectId}:\${selectedId}\`), projectId: projectId, id: selectedId }) },`,
        '    },',
        '  });',
      ].join('\n'),
    );
    expect(program).toContain(
      'const Results = componentRef("components/results");\nconst TodoDetails = componentRef("components/todo-details");',
    );
    expect(program).toContain(
      "import type { ReactNode } from 'react';\nimport type { TodoFilter } from '@/navigation';",
    );
  });

  it('shows each site where it stood, for the inputs the browser holds, under its conditions as written', () => {
    const client = output(compiled, app, 'components/workspace.client.tsx');

    expect(client).toContain(
      "import { type ClientPartProps, localOf, slotOf, useReactiveState, useSites } from '@arkorlab/reactive-state/react';\nimport { Suspense } from 'react';\nimport Disclosure from '@/controls/disclosure';",
    );
    expect(client).toContain(
      [
        '  const [filter, setFilter] = useReactiveState(localOf<States["filter"]>(part, "filter"));',
        '  const [selectedId, setSelectedId] = useReactiveState(localOf<States["selectedId"]>(part, "selectedId"));',
        '  const [showDetails, setShowDetails] = useReactiveState(localOf<States["showDetails"]>(part, "showDetails"));',
        "  const [memo, setMemo] = useReactiveState('');",
        '  const sites = useSites(part);',
        "  const missing = selectedId !== '' && !choices.some(todo => todo.id === selectedId);",
      ].join('\n'),
    );
    expect(client).toContain(
      [
        '      <Suspense fallback={<p>loading</p>}>',
        '        {sites.of("d0", { filter })}',
        "        {showDetails && selectedId !== '' ? (",
        '          sites.of("d1", { selectedId }, { showDetails })',
        '        ) : (',
        '          <p>closed</p>',
        '        )}',
        '      </Suspense>',
      ].join('\n'),
    );
    expect(client).toContain('onClick={() => setShowDetails(open => !open)}');
    expect(client).not.toMatch(/Results|TodoDetails|heading|projectId/u);
  });

  it('shows the nodes a component is given in a slot, and renders its root without them', () => {
    const client = output(compiled, app, 'components/workspace.client.tsx');

    expect(client).toContain('      <Disclosure title="totals">{slotOf(part, "s0")}</Disclosure>');
    expect(client).toContain(
      '  const { choices } = part.props as { readonly choices: readonly { readonly id: string; readonly title: string }[] };',
    );
    expect(output(compiled, app, 'components/workspace.root.tsx')).toContain(
      [
        "import type { ReactNode } from 'react';",
        "import type { TodoFilter } from '@/navigation';",
        "import { elements } from '../elements';",
        "import { update, view } from '../server-functions';",
        '',
        'export default async function Workspace(props: Omit<{',
        '  projectId: string;',
        '  initialFilter: TodoFilter;',
        '  initialSelectedId: string;',
        '  choices: readonly { readonly id: string; readonly title: string }[];',
        '  children: ReactNode;',
        '}, "children">) {',
        '  return renderRoot({ component: "components/workspace", elements, props, update, view });',
        '}',
      ].join('\n'),
    );
  });

  it('renders the nodes a component of no state is given, and the children a parent gives one', () => {
    expect(output(compiled, app, 'components/frame.authority.mts')).toContain(
      'export function evaluate({ title, children }: { title: string; children: ReactNode }, $: RenderScope) {\n  return $.h("main", null, $.h("h2", null, title), $.h("div", null, children));\n}',
    );
    expect(output(compiled, app, 'components/frame.root.tsx')).toContain(
      'export default async function Frame(props: Omit<{ title: string; children: ReactNode }, "children">) {',
    );
    expect(output(compiled, app, 'components/framed.authority.mts')).toContain(
      '  return $.h(Frame, { title: "framed" }, $.h(TodoDetails, { projectId: projectId, id: "t1" }));',
    );
  });

  it('makes a slot of a prop typed as React’s node or element, under any name', () => {
    const program = output(compiled, app, 'components/card.authority.mts');
    const client = output(compiled, app, 'components/card.client.tsx');

    expect(program).toContain(
      '    props: { label },\n    states: {},\n    slots: { s0: header, s1: footer },\n  });',
    );
    expect(program).toContain(
      "import type * as React from 'react';\nimport type { ReactNode } from 'react';",
    );
    expect(client).toContain(
      '      {slotOf(part, "s0")}\n      <button type="button" onClick={() => setOpen(value => !value)}>{label}</button>',
    );
    expect(client).toContain('      <footer>{slotOf(part, "s1")}</footer>');
    expect(client).toContain('  const { label } = part.props as { readonly label: string };');
    expect(output(compiled, app, 'components/card.root.tsx')).toContain(
      'export default async function Card(props: Omit<{\n  header: ReactNode; footer: React.ReactElement | null; label: string;\n}, "header" | "footer">) {',
    );
  });

  it('renders the root of a component whose parameter names its props’ type without the props TypeScript types as nodes', async () => {
    const made = await compiling({
      'components/named.reactive.tsx': file(
        "import type { NamedProps } from '@/named-props';",
        '',
        'export default function Named({ header, label, children }: NamedProps) {',
        '  return <section>{header}<h2>{label}</h2>{children}</section>;',
        '}',
      ),
      'named-props.ts': file(
        "import type { ReactNode } from 'react';",
        '',
        'export interface NamedProps {',
        '  readonly header: ReactNode;',
        '  readonly label: string;',
        '  readonly children?: ReactNode;',
        '}',
      ),
    });
    const root = output(made.compiled, made.app, 'components/named.root.tsx');

    expect(root).toContain(
      "import { renderRoot, type RootProps } from '@arkorlab/reactive-state/next';\nimport type { NamedProps } from '@/named-props';",
    );
    expect(root).toContain(
      'export default async function Named(props: RootProps<NamedProps, "children">) {',
    );
  });

  it('tells a prop of nodes under another name, of React’s global types, or a list of them, and hoists what holds one whole', async () => {
    const made = await compiling({
      'components/edge.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        '',
        'export default function Edge({ children: kids, badge, icons, label }: {',
        '  children?: React.ReactNode;',
        '  badge: JSX.Element | undefined;',
        '  icons: readonly React.ReactElement[];',
        '  label: string;',
        '}) {',
        '  const [count, setCount] = useReactiveState(0);',
        '  return (',
        '    <section>',
        '      {kids ?? <p>none</p>}',
        '      <button type="button" onClick={() => setCount(n => n + 1)}>{label} {count}</button>',
        '      {badge}{icons}',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(made.compiled, made.app, 'components/edge.authority.mts');

    expect(program).toContain(
      '    props: { label },\n    states: {},\n    slots: { s0: kids ?? $.h("p", null, "none"), s1: badge, s2: icons },',
    );
    expect(output(made.compiled, made.app, 'components/edge.client.tsx')).toContain(
      '      {slotOf(part, "s0")}\n      <button type="button" onClick={() => setCount(n => n + 1)}>{label} {count}</button>\n      {slotOf(part, "s1")}{slotOf(part, "s2")}',
    );
    expect(output(made.compiled, made.app, 'components/edge.root.tsx')).toContain(
      '}, "children" | "badge" | "icons">) {',
    );
  });

  it('says in its manifest each site, what it is rendered of and what its guard reads, and each prop of nodes', () => {
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly components: Readonly<Record<string, unknown>>;
    };

    expect(manifest.components['components/workspace']).toMatchObject({
      nodes: ['children'],
      renders: ['components/results', 'components/todo-details'],
      sites: {
        d0: { guard: [], inputs: ['filter'] },
        d1: { guard: ['showDetails', 'selectedId'], inputs: ['selectedId', 'showDetails'] },
      },
      slots: ['s0'],
      states: ['filter', 'selectedId', 'showDetails'],
    });
    expect(manifest.components['components/card']).toMatchObject({
      nodes: ['header', 'footer'],
      sites: {},
      slots: ['s0', 's1'],
    });
  });

  it('writes a program whose sites Node runs: the guard of the states, the element of the inputs', () => {
    writeOutputs(compiled.outputs, app.out);
    const program = path.join(app.out, 'components/workspace.authority.mts');
    const ran = node(
      [
        `const program = await import(${JSON.stringify(program)});`,
        "const $ = { client: (part) => part, counted: (value) => value, method: (receiver, key) => { const fn = receiver[key]; return (...args) => Reflect.apply(fn, receiver, args); }, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }) };",
        "const part = program.evaluate({ projectId: 'p1', initialFilter: 'all', initialSelectedId: 't1', choices: [], children: 'kids' }, $);",
        'const { d0, d1 } = part.sites;',
        'process.stdout.write(JSON.stringify({',
        "  closed: d1.guard({ filter: 'all', selectedId: 't1', showDetails: false }),",
        "  details: d1.render({ selectedId: 't2' }),",
        '  inputs: [d0.inputs, d1.inputs],',
        "  results: d0.render({ filter: 'done' }),",
        "  shown: d1.guard({ filter: 'all', selectedId: 't1', showDetails: true }),",
        '  slots: part.slots,',
        '  states: part.states,',
        "  unselected: d1.guard({ filter: 'all', selectedId: '', showDetails: true }),",
        '}));',
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout) as unknown).toStrictEqual({
      closed: false,
      details: {
        children: [],
        props: { id: 't2', key: 'p1:t2', projectId: 'p1' },
        type: { component: 'components/todo-details', kind: 'component' },
      },
      inputs: [['filter'], ['selectedId', 'showDetails']],
      results: {
        children: [],
        props: { filter: 'done', heading: 'P1', projectId: 'p1' },
        type: { component: 'components/results', kind: 'component' },
      },
      shown: true,
      slots: { s0: 'kids' },
      states: { filter: 'all', selectedId: 't1', showDetails: true },
      unselected: false,
    });
  });

  it('writes what the application’s type check accepts: the sites, the slots of nodes, the roots without them', () => {
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it.each([
    [`c ? ${X} : null`, ['({ c }) => c']],
    [`c ? null : ${X}`, ['({ c }) => !c']],
    [`a || ${X}`, ['({ a }) => !a']],
    [`a ?? ${X}`, ['({ a }) => a == null']],
    [`a && (b ? null : ${X})`, ['({ a, b }) => a && !b']],
    [`x === 1 ? null : ${X}`, ['() => !(x === 1)']],
    [`c && (a || b ? ${X} : null)`, ['({ c, a, b }) => c && (a || b)']],
    [`f ? ${X} : ${Y}`, ['({ f }) => f', '({ f }) => !f']],
  ])(
    'guards the site of `%s` by what its conditions hold where it shows',
    async (shown, guards) => {
      const made = await compiling({ 'components/guarded.reactive.tsx': guarded(shown) });
      const program = output(made.compiled, made.app, 'components/guarded.authority.mts');

      expect(guardsIn(program)).toStrictEqual(guards);
    },
  );

  it('renders a site again of a state its key alone reads, which the Client Component still holds', async () => {
    const made = await compiling({
      'components/keyed.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoDetails from '@/components/todo-details.reactive';",
        '',
        'export default function Keyed({ projectId }: { projectId: string }) {',
        '  const [version, setVersion] = useReactiveState(0);',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => setVersion(n => n + 1)}>again</button>',
        '      <TodoDetails key={version} projectId={projectId} id="t1" />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(made.compiled, made.app, 'components/keyed.authority.mts');
    const client = output(made.compiled, made.app, 'components/keyed.client.tsx');

    expect(program).toContain(
      '      d0: { inputs: ["version"], render: ({ version }) => $.h(TodoDetails, { key: version, projectId: projectId, id: "t1" }) },',
    );
    expect(program).toContain('    states: { version: 0 },');
    expect(client).toContain(
      '  const [version, setVersion] = useReactiveState(localOf<States["version"]>(part, "version"));',
    );
    expect(client).toContain('      {sites.of("d0", { version })}');
  });

  it('renders a reactive child a condition of the browser’s stands over at a site of no input', async () => {
    const editor = variant(
      await source('components/todo-editor.reactive.tsx'),
      '      <TodoCommands projectId={projectId} id={id} />',
      '      {expanded && <TodoCommands projectId={projectId} id={id} />}',
    );
    const made = await compiling({ 'components/todo-editor.reactive.tsx': editor });
    const program = output(made.compiled, made.app, 'components/todo-editor.authority.mts');
    const client = output(made.compiled, made.app, 'components/todo-editor.client.tsx');

    expect(program).toContain(
      '    slots: {},\n    sites: {\n      d0: { inputs: ["expanded"], guard: ({ expanded }) => expanded, render: () => $.h(TodoCommands, { projectId: projectId, id: id }) },\n    },',
    );
    expect(program).toContain('      expanded: false,');
    expect(client).toContain(
      '  const [expanded, setExpanded] = useReactiveState(localOf<States["expanded"]>(part, "expanded"));',
    );
    expect(client).toContain('      {expanded && sites.of("d0", {}, { expanded })}');
    expect(client).not.toContain('TodoCommands');
  });

  it('starts a state a site reads on the authority, typed as its type argument types it', async () => {
    const made = await compiling({
      'components/results.reactive.tsx': RESULTS,
      'components/views.reactive.tsx': file(
        "import Link from 'next/link';",
        "import { useReactiveState } from 'framework/react';",
        "import { projectHref, type TodoFilter } from '@/navigation';",
        "import Results from '@/components/results.reactive';",
        '',
        'export default function Views({ projectId }: { projectId: string }) {',
        "  const [filter, setFilter] = useReactiveState<TodoFilter>('active');",
        '  return (',
        '    <section>',
        '      <Link href={projectHref(projectId, filter)}>link</Link>',
        '      <button type="button" onClick={() => setFilter(\'done\')}>done</button>',
        '      <Results heading="views" projectId={projectId} filter={filter} />',
        '    </section>',
        '  );',
        '}',
      ),
    });
    const program = output(made.compiled, made.app, 'components/views.authority.mts');
    writeOutputs(made.compiled.outputs, made.app.out);
    const checked = typeCheck(made.app);

    expect(program).toContain("    states: { filter: 'active' as TodoFilter },");
    expect(program).toContain("import type { TodoFilter } from '@/navigation';");
    expect(output(made.compiled, made.app, 'components/views.client.tsx')).toContain(
      '  const [filter, setFilter] = useReactiveState(localOf<States["filter"]>(part, "filter"));',
    );
    expect(checked.stdout + checked.stderr).toBe('');
  });
});

/** The project's pure normalization of a filter, shared by the authority and the browser. */
const TODO_FILTER = file(
  "import type { TodoFilter } from '@/navigation';",
  '',
  'export function normalizeFilter(value: string): TodoFilter {',
  "  return value === 'active' || value === 'done' ? value : 'all';",
  '}',
);

/** A hook of a local state, and a value it computes of it by a shared helper. */
const USE_TODO_FILTER = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import { normalizeFilter } from '@/domain/todo-filter';",
  '',
  'export function useTodoFilter(initialFilter: TodoFilter) {',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  '  const effectiveFilter = normalizeFilter(filter);',
  '',
  '  return { filter, setFilter, effectiveFilter };',
  '}',
);

/** A component that lists of a filter, `computed` the code it computes what it lists of. */
function filtered(name: string, computed: readonly string[], lists: string): string {
  return file(
    "import { Suspense } from 'react';",
    "import { useReactiveState } from 'framework/react';",
    "import type { TodoFilter } from '@/navigation';",
    "import TodoResults from '@/components/todo-results.reactive';",
    "import { normalizeFilter } from '@/domain/todo-filter';",
    "import { useTodoFilter } from '@/hooks/use-todo-filter';",
    '',
    `export default function ${name}({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {`,
    ...computed.map((line) => `  ${line}`),
    '  return (',
    '    <section>',
    '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
    '      <Suspense fallback={<p>loading</p>}>',
    '        <TodoResults projectId={projectId} filter={LISTS} />'.replace('LISTS', () => lists),
    '      </Suspense>',
    '    </section>',
    '  );',
    '}',
  );
}

/** Node code that sets `ran[component]` to the filters `component`'s site `d0` lists of three, `key` its input. */
function listing(out: string, component: string, key: string): string {
  const program = path.join(out, 'components', `${component}.authority.mts`);
  return [
    `{ const program = await import(${JSON.stringify(program)});`,
    "  const { d0 } = program.evaluate({ projectId: 'p1', initialFilter: 'all' }, $).sites;",
    `  ran[${JSON.stringify(component)}] = ['done', 'bogus', 'active'].map((value) => d0.render({ ${JSON.stringify(key)}: value }).props.filter); }`,
  ].join('\n');
}

describe('dynamic sites of what the browser computes of its local states (v3)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;

  beforeAll(async () => {
    api = openTypeScript();
    app = await application({
      'components/aliased.reactive.tsx': filtered(
        'Aliased',
        [
          'const { filter, setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
          'const filterAlias = effectiveFilter;',
          'const query = { filter: filterAlias };',
        ],
        'query.filter',
      ),
      'components/hooked.reactive.tsx': filtered(
        'Hooked',
        [
          'const { filter, setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
          'const renderedFilter = effectiveFilter;',
        ],
        'renderedFilter',
      ),
      'components/unbound.reactive.tsx': filtered(
        'Unbound',
        [
          'const { setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
          "const filter = 'shown';",
        ],
        'effectiveFilter',
      ),
      'components/inline.reactive.tsx': filtered(
        'Inline',
        [
          'const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
          'const renderedFilter = normalizeFilter(filter);',
        ],
        'renderedFilter',
      ),
      'domain/todo-filter.ts': TODO_FILTER,
      'hooks/use-todo-filter.ts': USE_TODO_FILTER,
    });
    compiled = compiledApp(app, api);
    if (compiled.refusals.length > 0) {
      throw new Error(compiled.refusals.map((refusal) => refusal.message).join('\n'));
    }
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('renders a site of a value a hook computes of its state: the state sent, the value computed again of it', () => {
    const program = output(compiled, app, 'components/hooked.authority.mts');
    const client = output(compiled, app, 'components/hooked.client.tsx');

    expect(program).toContain("import { normalizeFilter } from '@/domain/todo-filter';");
    expect(program).toContain(
      '      d0: { inputs: ["useTodoFilter#0.filter"], render: ({ "useTodoFilter#0.filter": filter }) => $.h(TodoResults, { projectId: projectId, filter: $.counted(normalizeFilter(filter)) }) },',
    );
    expect(client).toContain('        {sites.of("d0", { "useTodoFilter#0.filter": filter })}');
  });

  it('computes again what an alias, an object and its property hold, as the browser does', () => {
    expect(output(compiled, app, 'components/aliased.authority.mts')).toContain(
      'render: ({ "useTodoFilter#0.filter": filter }) => $.h(TodoResults, { projectId: projectId, filter: ($.counted({ filter: $.counted(normalizeFilter(filter)) })).filter }) },',
    );
  });

  it('binds in its Client Component the state of a hook the component binds no name of, which the site is sent', () => {
    const client = output(compiled, app, 'components/unbound.client.tsx');

    // The component names `filter` itself: the item is bound under a name of its own.
    expect(client).toContain(
      '  const { setFilter, filter: filter$2 } = useTodoFilter(localOf<States["useTodoFilter#0.filter"]>(part, "useTodoFilter#0.filter"));',
    );
    expect(client).toContain('{sites.of("d0", { "useTodoFilter#0.filter": filter$2 })}');
  });

  it('computes again what the component computes of its own state, by a shared module', () => {
    expect(output(compiled, app, 'components/inline.authority.mts')).toContain(
      'd0: { inputs: ["filter"], render: ({ filter }) => $.h(TodoResults, { projectId: projectId, filter: $.counted(normalizeFilter(filter)) }) },',
    );
  });

  it('writes programs that list each filter as the application normalizes it, written any of the three ways', () => {
    writeOutputs(compiled.outputs, app.out);
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        "const $ = { client: (part) => part, counted: (value) => value, method: (receiver, key) => { const fn = receiver[key]; return (...args) => Reflect.apply(fn, receiver, args); }, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }) };",
        'const ran = {};',
        listing(app.out, 'hooked', 'useTodoFilter#0.filter'),
        listing(app.out, 'aliased', 'useTodoFilter#0.filter'),
        listing(app.out, 'inline', 'filter'),
        'process.stdout.write(JSON.stringify(ran));',
      ].join('\n'),
      app.root,
    );

    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout) as unknown).toStrictEqual({
      aliased: ['done', 'all', 'active'],
      hooked: ['done', 'all', 'active'],
      inline: ['done', 'all', 'active'],
    });
  });

  it('writes what the application’s type check accepts', () => {
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
  });
});

describe('borrowed methods', () => {
  // R108: the borrowed function retains its own semantics and defers unread inputs.
  it('takes valid borrowed method arguments and leaves unknown arguments for the authority', async () => {
    using api = openTypeScript();
    const app = await application({
      'components/borrowed-arguments.reactive.tsx': file(
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        '',
        'export default function BorrowedArguments({ projectId, first, values, index, args }: { projectId: string; first: string; values: number[]; index: number; args: unknown[] }) {',
        '  const digits = [2];',
        '  const fixed = Number.prototype.toFixed;',
        "  const [id, setId] = useReactiveState<string>(first === '' ? (",
        '    Array.prototype.reduce.call([1], (a, b) => a + b),',
        '    Array.prototype.reduce.apply([], [(a, b) => a + b, 0]),',
        '    Reflect.apply(Array.prototype.reduceRight, [], [(a, b) => a + b, 0]),',
        '    Array.prototype.with.call([1], -1, 0),',
        '    Array.prototype.with.call(new BigInt64Array(1), 0, 1),',
        '    fixed.apply(1, digits),',
        "    Reflect.apply(String.prototype.repeat, 'x', [1]),",
        '    Date.prototype.toISOString.call(new Date(0)),',
        '    DataView.prototype.getInt8.apply(new DataView(new ArrayBuffer(1)), [0]),',
        "    Headers.prototype.append.call(new Headers(), 'x', 'y'),",
        '    BigInt64Array.prototype.fill.call(new BigInt64Array(1), 1n),',
        "    Reflect.apply(Number.prototype.toLocaleString, 1, ['en-US']),",
        '    Array.prototype.map.call([], (value) => value),',
        '    Array.prototype.toString.call(1, 1),',
        "    Object.prototype.toLocaleString.call(1, 'bad_locale'),",
        '    Array.prototype.reduce.call(values, (a, b) => a + b),',
        '    Array.prototype.with.call([1], index, 0),',
        '    Reflect.apply(Array.prototype.reduce, [], args),',
        "    'ok') : first);",
        '  return <section><button onClick={() => setId(first)}>change</button><TodoCommands projectId={projectId} id={id} /></section>;',
        '}',
      ),
    });

    try {
      expect(compiledApp(app, api).refusals).toStrictEqual([]);
    } finally {
      await removed(app);
    }
  });
});

/** A component that calls a hook twice, and reads one value it computes in two sites. */
const TWICE = file(
  "import { Suspense } from 'react';",
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useTodoFilter } from '@/hooks/use-todo-filter';",
  '',
  'export default function Twice({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { filter, setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
  "  const { filter: other, setFilter: setOther, effectiveFilter: otherFilter } = useTodoFilter('done');",
  '  const shownFilter = effectiveFilter;',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <button type="button" onClick={() => setOther(\'all\')}>{other}</button>',
  '      <Suspense fallback={<p>loading</p>}>',
  '        <TodoResults projectId={projectId} filter={shownFilter} />',
  '        <TodoResults projectId={projectId} filter={otherFilter} />',
  '        <TodoResults projectId={projectId} filter={shownFilter} />',
  '      </Suspense>',
  '    </section>',
  '  );',
  '}',
);

/** A hook whose value asserts a type its module imports, which the component imports none of. */
const USE_SHOWN_FILTER = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import type { Shown } from '@/domain/shown';",
  "import { normalizeFilter } from '@/domain/todo-filter';",
  '',
  'export function useShownFilter(initialFilter: TodoFilter) {',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  '  const shown = normalizeFilter(filter) as Shown;',
  '',
  '  return { filter, setFilter, shown };',
  '}',
);

const TYPED = file(
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useShownFilter } from '@/hooks/use-shown-filter';",
  '',
  'export default function Typed({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { filter, setFilter, shown } = useShownFilter(initialFilter);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <TodoResults projectId={projectId} filter={shown} />',
  '    </section>',
  '  );',
  '}',
);

/** A component whose site's own code declares the name of the hook's state it is rendered of. */
const SHADOWED = file(
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useTodoFilter } from '@/hooks/use-todo-filter';",
  '',
  'export default function Shadowed({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>done</button>',
  "      <TodoResults projectId={projectId} filter={['x'].map((filter) => (filter === 'x' ? effectiveFilter : 'all'))[0] ?? 'all'} />",
  '    </section>',
  '  );',
  '}',
);

/** A component whose own state has the name of a hook's state its site is rendered of. */
const MIXED = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useTodoFilter } from '@/hooks/use-todo-filter';",
  '',
  'export default function Mixed({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { setFilter: setOther, effectiveFilter } = useTodoFilter(initialFilter);',
  "  const [filter, setFilter] = useReactiveState<TodoFilter>('all');",
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <button type="button" onClick={() => setOther(\'done\')}>other</button>',
  "      <TodoResults projectId={projectId} filter={filter === 'all' ? effectiveFilter : filter} />",
  '    </section>',
  '  );',
  '}',
);

/** A hook a site's value is computed of a parameter of, which its type types wider than a call writes it. */
const USE_MODE = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  '',
  "export function useMode(initialFilter: TodoFilter, mode: 'all' | 'done') {",
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  "  const shown: TodoFilter = mode === 'done' ? 'done' : filter;",
  '',
  '  return { filter, setFilter, shown };',
  '}',
);

const MODED = file(
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useMode } from '@/hooks/use-mode';",
  '',
  'export default function Moded({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  "  const { filter, setFilter, shown } = useMode(initialFilter, 'all');",
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <TodoResults projectId={projectId} filter={shown} />',
  '    </section>',
  '  );',
  '}',
);

/** A component whose handler, declared first, reads a constant a site is computed of, declared after it. */
const AHEAD = file(
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useTodoFilter } from '@/hooks/use-todo-filter';",
  '',
  'export default function Ahead({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { filter, setFilter, effectiveFilter } = useTodoFilter(initialFilter);',
  '  const again = () => setFilter(shownFilter);',
  '  const shownFilter = effectiveFilter;',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={again}>{filter}</button>',
  '      <TodoResults projectId={projectId} filter={shownFilter} />',
  '    </section>',
  '  );',
  '}',
);

/** A hook whose state has a name the Client Component's own code reads: `part`. */
const USE_PART = file(
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import { normalizeFilter } from '@/domain/todo-filter';",
  '',
  'export function usePart(initialPart: TodoFilter) {',
  '  const [part, setPart] = useReactiveState<TodoFilter>(initialPart);',
  '  const label = normalizeFilter(part);',
  '',
  '  return { part, setPart, label };',
  '}',
);

const PARTED = file(
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { usePart } from '@/hooks/use-part';",
  '',
  'export default function Parted({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { setPart, label } = usePart(initialFilter);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setPart(\'done\')}>done</button>',
  '      <TodoResults projectId={projectId} filter={label} />',
  '    </section>',
  '  );',
  '}',
);

/** The line of `Twice`'s program that renders the site `name` of the hook's state `key`. */
function twiceSite(name: string, key: string): string {
  return `      ${name}: { inputs: ["${key}"], render: ({ "${key}": filter }) => $.h(TodoResults, { projectId: projectId, filter: $.counted(normalizeFilter(filter)) }) },`;
}

describe('what a dynamic site’s values are computed of, written where its function stands', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;

  beforeAll(async () => {
    api = openTypeScript();
    app = await application({
      'components/ahead.reactive.tsx': AHEAD,
      'components/mixed.reactive.tsx': MIXED,
      'components/moded.reactive.tsx': MODED,
      'components/parted.reactive.tsx': PARTED,
      'components/shadowed.reactive.tsx': SHADOWED,
      'components/twice.reactive.tsx': TWICE,
      'components/typed.reactive.tsx': TYPED,
      'domain/shown.ts': file("export type Shown = 'active' | 'all' | 'done';"),
      'domain/todo-filter.ts': TODO_FILTER,
      'hooks/use-mode.ts': USE_MODE,
      'hooks/use-part.ts': USE_PART,
      'hooks/use-shown-filter.ts': USE_SHOWN_FILTER,
      'hooks/use-todo-filter.ts': USE_TODO_FILTER,
    });
    compiled = compiledApp(app, api);
    if (compiled.refusals.length > 0) {
      throw new Error(compiled.refusals.map((refusal) => refusal.message).join('\n'));
    }
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('computes each call of a hook of its own states, and each site of all the states its value is computed of', () => {
    const program = output(compiled, app, 'components/twice.authority.mts');
    const client = output(compiled, app, 'components/twice.client.tsx');

    expect(program).toContain(twiceSite('d0', 'useTodoFilter#0.filter'));
    expect(program).toContain(twiceSite('d1', 'useTodoFilter#1.filter'));
    // A value two sites read is followed for each.
    expect(program).toContain(twiceSite('d2', 'useTodoFilter#0.filter'));
    expect(client).toContain('{sites.of("d0", { "useTodoFilter#0.filter": filter })}');
    expect(client).toContain('{sites.of("d1", { "useTodoFilter#1.filter": other })}');
    expect(client).toContain('{sites.of("d2", { "useTodoFilter#0.filter": filter })}');
  });

  it('imports a type a hook’s code names as the hook’s module imports it', () => {
    const program = output(compiled, app, 'components/typed.authority.mts');

    expect(program).toContain("import type { Shown } from '@/domain/shown';");
    expect(program).toContain('filter: ($.counted(normalizeFilter(filter)) as Shown)');
  });

  it('names an input apart from what the site’s own code declares', () => {
    const program = output(compiled, app, 'components/shadowed.authority.mts');
    const client = output(compiled, app, 'components/shadowed.client.tsx');

    expect(program).toContain(
      "render: ({ \"useTodoFilter#0.filter\": filter$2 }) => $.h(TodoResults, { projectId: projectId, filter: $.counted($.method($.counted(['x']), \"map\")((filter) => $.counted((filter === 'x' ? $.counted(normalizeFilter(filter$2)) : 'all'))))[0] ?? 'all' }) },",
    );
    expect(client).toContain('{sites.of("d0", { "useTodoFilter#0.filter": filter$2 })}');
  });

  it('names a hook’s state apart from the component’s own of that name', () => {
    const program = output(compiled, app, 'components/mixed.authority.mts');
    const client = output(compiled, app, 'components/mixed.client.tsx');

    expect(program).toContain(
      'render: ({ "useTodoFilter#0.filter": filter$2, filter }) => $.h(TodoResults, { projectId: projectId, filter: filter === \'all\' ? $.counted(normalizeFilter(filter$2)) : filter }) },',
    );
    expect(client).toContain('{sites.of("d0", { "useTodoFilter#0.filter": filter$2, filter })}');
  });

  it('binds an item of a hook’s call under no name the Client Component reads itself', () => {
    const client = output(compiled, app, 'components/parted.client.tsx');

    expect(client).toContain(
      '  const { setPart, part: part$2 } = usePart(localOf<States["usePart#0.part"]>(part, "usePart#0.part"));',
    );
    expect(client).toContain('{sites.of("d0", { "usePart#0.part": part$2 })}');
  });

  it('keeps in the browser a constant a site is computed of that a function kept reads, declared before it', () => {
    const client = output(compiled, app, 'components/ahead.client.tsx');

    expect(client).toContain('const again = () => setFilter(shownFilter);');
    expect(client).toContain('const shownFilter = effectiveFilter;');
  });

  it('types what a call gives a hook’s parameter as the parameter’s annotation does, as the hook’s code reads it', () => {
    const program = output(compiled, app, 'components/moded.authority.mts');

    expect(program).toContain("(('all' as 'all' | 'done') === 'done' ? 'done' : filter)");
  });

  it('writes what the application’s type check accepts', () => {
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
  });
});

/** A component that shows the detail of each panel open, `array` what it maps, `computed` how. */
function panelled(
  name: string,
  {
    array,
    computed,
    imports,
  }: { array: string; computed: readonly string[]; imports: readonly string[] },
): string {
  return file(
    "import { Suspense } from 'react';",
    "import { PanelCard } from '@/controls/todo-panels';",
    "import TodoDetails from '@/components/todo-details.reactive';",
    ...imports,
    '',
    `export default function ${name}({ projectId, initialSelectedId }: { projectId: string; initialSelectedId: string }) {`,
    '  const initialPanels = initialPanelsFor(initialSelectedId);',
    ...computed.map((line) => `  ${line}`),
    '  return (',
    '    <section>',
    '      <button type="button" onClick={() => openPanel(\'t2\')}>open</button>',
    '      <Suspense fallback={<p>loading</p>}>',
    '        {ARRAY.map((panel) => ('.replace('ARRAY', () => array),
    '          <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
    "            <TodoDetails key={projectId + ':' + panel.todoId} projectId={projectId} id={panel.todoId} />",
    '          </PanelCard>',
    '        ))}',
    '      </Suspense>',
    '    </section>',
    '  );',
    '}',
  );
}

const HOOKED_PANELS = {
  array: 'panels',
  computed: ['const { panels, openPanel } = useTodoPanels(initialPanels);'],
  imports: [
    "import { initialPanelsFor } from '@/domain/todo-panels';",
    "import { useTodoPanels } from '@/hooks/use-todo-panels';",
  ],
};

/** The program of `component` of the application `out` holds, its list `d0` run of `panels`, `key` its input. */
function itemsListed(out: string, component: string, key: string): string {
  const program = path.join(out, 'components', `${component}.authority.mts`);
  const panels = JSON.stringify([
    { panelId: 'A', todoId: 't1' },
    { panelId: 'B', todoId: 't1' },
    { panelId: 'C', todoId: 't2' },
  ]);
  return [
    `{ const program = await import(${JSON.stringify(program)});`,
    "  const { d0 } = program.evaluate({ projectId: 'p1', initialSelectedId: 't1' }, $).sites;",
    `  ran[${JSON.stringify(component)}] = d0.each({ ${JSON.stringify(key)}: ${panels} }).map(({ item, key, render }) => ({ item, key, props: render().props })); }`,
  ].join('\n');
}

describe('list sites: a reactive component the browser renders for each item of a keyed `.map()` (v3)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;

  beforeAll(async () => {
    api = openTypeScript();
    app = await application({
      'components/aliased-panels.reactive.tsx': panelled('AliasedPanels', {
        ...HOOKED_PANELS,
        array: 'cards',
        computed: [
          ...HOOKED_PANELS.computed,
          'const sourcePanels = panels;',
          'const cards = sourcePanels.map((item) => ({ panelId: item.panelId, todoId: item.todoId }));',
        ],
      }),
      'components/hooked-panels.reactive.tsx': panelled('HookedPanels', HOOKED_PANELS),
      'components/identity-panels.reactive.tsx': panelled('IdentityPanels', {
        ...HOOKED_PANELS,
        array: 'others',
        computed: [
          ...HOOKED_PANELS.computed,
          'const cards = panels.map((panel) => ({ panelId: panel.panelId, todoId: panel.todoId }));',
          "const firstCard = cards.find((card) => card.todoId !== '');",
          'const others = cards.filter((card) => card !== firstCard);',
        ],
      }),
      'components/sorted-panels.reactive.tsx': panelled('SortedPanels', {
        ...HOOKED_PANELS,
        array: 'ordered',
        computed: [
          ...HOOKED_PANELS.computed,
          "const ordered = [...panels].sort().toReversed().filter((panel) => String(panel.todoId) !== '');",
        ],
      }),
      'components/padded-panels.reactive.tsx': panelled('PaddedPanels', {
        ...HOOKED_PANELS,
        array: 'labelled',
        computed: [
          ...HOOKED_PANELS.computed,
          "const labelled = panels.filter((card) => card.todoId.padStart(2, '0').includes('t') && 'ab'.repeat(2) !== '');",
        ],
      }),
      'components/keyed-details.reactive.tsx': file(
        "import TodoDetails from '@/components/todo-details.reactive';",
        "import { initialPanelsFor } from '@/domain/todo-panels';",
        "import { useTodoPanels } from '@/hooks/use-todo-panels';",
        '',
        'export default function KeyedDetails({ projectId, initialSelectedId }: { projectId: string; initialSelectedId: string }) {',
        '  const { panels, openPanel } = useTodoPanels(initialPanelsFor(initialSelectedId));',
        '  return (',
        '    <section>',
        '      <button type="button" onClick={() => openPanel(\'t2\')}>open</button>',
        "      {panels.map((panel) => <TodoDetails key={projectId + ':' + panel.panelId} projectId={projectId} id={panel.todoId} />)}",
        '    </section>',
        '  );',
        '}',
      ),
      'components/inline-panels.reactive.tsx': panelled('InlinePanels', {
        array: 'panels',
        computed: [
          'const [panels, setPanels] = useReactiveState<readonly TodoPanel[]>(initialPanels);',
          'const openPanel = (todoId: string): void => {',
          '  const candidate: TodoPanel = { panelId: crypto.randomUUID(), todoId };',
          '  setPanels((current) => appendPanels(current, [candidate]));',
          '};',
        ],
        imports: [
          "import { useReactiveState } from 'framework/react';",
          "import { appendPanels, initialPanelsFor, type TodoPanel } from '@/domain/todo-panels';",
        ],
      }),
    });
    compiled = compiledApp(app, api);
    if (compiled.refusals.length > 0) {
      throw new Error(compiled.refusals.map((refusal) => refusal.message).join('\n'));
    }
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('maps the array again of the state it reads, to each item’s key, the item, and its element', () => {
    const program = output(compiled, app, 'components/hooked-panels.authority.mts');

    expect(program).toContain(
      '      d0: { inputs: ["useTodoPanels#0.panels"], each: ({ "useTodoPanels#0.panels": panels }) => $.method(panels, "map")((panel) => $.counted({ item: panel, key: panel.panelId, render: () => $.h(TodoDetails, { key: $.counted(projectId + \':\' + panel.todoId), projectId: projectId, id: panel.todoId }) })) },',
    );
  });

  it('keeps the browser’s `.map()`, each item shown by its key and the item', () => {
    const client = output(compiled, app, 'components/hooked-panels.client.tsx');

    expect(client).toContain('        {panels.map((panel) => (');
    expect(client).toContain(
      '          <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
    );
    expect(client).toContain(
      '            {sites.item("d0", { "useTodoPanels#0.panels": panels }, { item: panel, key: panel.panelId })}',
    );
  });

  it('keys an item of its own element by what the browser computes too', () => {
    const client = output(compiled, app, 'components/keyed-details.client.tsx');

    expect(client).toContain('const { projectId } = part.props');
    expect(client).toContain(
      '      {panels.map((panel) => sites.item("d0", { "useTodoPanels#0.panels": panels }, { item: panel, key: projectId + \':\' + panel.panelId }))}',
    );
  });

  it('maps an array sorted on a copy, or by what answers a new one, of globals of what they are given alone', () => {
    const program = output(compiled, app, 'components/sorted-panels.authority.mts');

    expect(program).toContain(
      `each: ({ "useTodoPanels#0.panels": panels }) => $.method($.counted($.method($.counted($.method($.counted($.method($.counted([...panels]), "sort")()), "toReversed")()), "filter")((panel) => $.counted($.counted(String(panel.todoId)) !== ''))), "map")((panel) => $.counted({ item: panel, key: panel.panelId,`,
    );
  });

  it('computes text as long as the code says', () => {
    const program = output(compiled, app, 'components/padded-panels.authority.mts');

    expect(program).toContain(
      'each: ({ "useTodoPanels#0.panels": panels }) => $.method($.counted($.method(panels, "filter")((card) => $.counted($.counted($.method($.counted($.method(card.todoId, "padStart")(2, \'0\')), "includes")(\'t\')) && $.counted($.method(\'ab\', "repeat")(2)) !== \'\'))), "map")((panel) => $.counted({',
    );
  });

  it('computes a value read twice once, so an item one read finds is an item of the other’s array', () => {
    writeOutputs(compiled.outputs, app.out);
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        "const $ = { client: (part) => part, counted: (value) => value, method: (receiver, key) => { const fn = receiver[key]; return (...args) => Reflect.apply(fn, receiver, args); }, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }) };",
        'const ran = {};',
        itemsListed(app.out, 'identity-panels', 'useTodoPanels#0.panels'),
        'process.stdout.write(JSON.stringify(ran));',
      ].join('\n'),
      app.root,
    );
    const listed = JSON.parse(ran.stdout) as Readonly<
      Record<string, readonly { readonly key: string }[]>
    >;

    expect(output(compiled, app, 'components/identity-panels.authority.mts')).toContain(
      'each: ({ "useTodoPanels#0.panels": panels }) => { const cards = $.counted($.method(panels, "map")((panel) => ($.counted({ panelId: panel.panelId, todoId: panel.todoId })))); return $.method($.counted($.method(cards, "filter")((card) => $.counted(card !== $.counted($.method(cards, "find")((card) => $.counted(card.todoId !== \'\')))))), "map")((panel) => $.counted({',
    );
    expect(ran.stderr).toBe('');
    expect(listed['identity-panels']?.map(({ key }) => key)).toStrictEqual(['B', 'C']);
  });

  it('says in the manifest which sites are lists', () => {
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly components: Readonly<Record<string, { readonly sites: unknown }>>;
    };

    expect(manifest.components['components/hooked-panels']?.sites).toStrictEqual({
      d0: { guard: [], inputs: ['useTodoPanels#0.panels'], list: true },
    });
  });

  it('writes programs that list each panel alike, the array of a hook’s state, of the component’s, or of a copy of an alias', () => {
    writeOutputs(compiled.outputs, app.out);
    const ran = node(
      [
        "const { registerPaths } = await import('@arkorlab/reactive-state/authority');",
        `registerPaths(${JSON.stringify(app.tsconfig)});`,
        "const $ = { client: (part) => part, counted: (value) => value, method: (receiver, key) => { const fn = receiver[key]; return (...args) => Reflect.apply(fn, receiver, args); }, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }) };",
        'const ran = {};',
        itemsListed(app.out, 'hooked-panels', 'useTodoPanels#0.panels'),
        itemsListed(app.out, 'inline-panels', 'panels'),
        itemsListed(app.out, 'aliased-panels', 'useTodoPanels#0.panels'),
        'process.stdout.write(JSON.stringify(ran));',
      ].join('\n'),
      app.root,
    );
    const listed = JSON.parse(ran.stdout) as Readonly<Record<string, unknown>>;
    const items = ['A', 'B', 'C'].map((key, index) => {
      const todoId = index < 2 ? 't1' : 't2';
      return {
        item: { panelId: key, todoId },
        key,
        props: { id: todoId, key: `p1:${todoId}`, projectId: 'p1' },
      };
    });

    expect(ran.stderr).toBe('');
    expect(listed).toStrictEqual({
      'aliased-panels': items,
      'hooked-panels': items,
      'inline-panels': items,
    });
  });

  it('writes what the application’s type check accepts', () => {
    writeOutputs(compiled.outputs, app.out);
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
  });
});

describe('a shared module with local error type aliases', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) {
      await removed(app);
    }
  });

  it.each([
    'type PR479R6PromiseData<T> = T extends Promise<infer U> ? U : never; function frames(error: PR479R6PromiseData<Promise<{ stack: string }>>): string { return error.stack; }',
    'type PR479R8OptionalData<T> = T extends (value?: string) => unknown ? { stack: string } : Error; function frames(error: PR479R8OptionalData<(value: string | undefined) => void>): string { return error.stack; }',
    'type PR479R8VoidData<T> = T extends () => unknown ? { stack: string } : Error; function frames(error: PR479R8VoidData<(value: void) => void>): string { return error.stack; }',
    'interface PR479R7InterfaceData { stack: string } interface Failure extends PR479R7InterfaceData {} function frames(error: Failure): string { return error.stack; }',
    'type PR479R7ComposedData<T> = T extends { [key: string]: infer V } ? V : never; function frames(error: PR479R7ComposedData<{ [key: string]: Promise<{ stack: string }> }> extends Promise<infer V> ? V : never): string { return error.stack; }',
    'type PR479R7OptionalData<T> = T extends (value?: string) => infer R ? R : { stack: string }; function frames(error: PR479R7OptionalData<(value: string | undefined) => { stack: string }>): string { return error.stack; }',
    'type PR479R7NestedData<T> = T extends (value: { nested: infer V }) => unknown ? V : never; function frames(error: PR479R7NestedData<(value: { nested: { stack: string } }) => void>): string { return error.stack; }',
    'type PR479R7FunctionData<T> = T extends () => infer R ? R : never; function frames(error: PR479R7FunctionData<() => { stack: string }>): string { return error.stack; }',
    'type PR479R7VariadicData<T> = T extends (...args: never[]) => infer R ? R : never; function frames(error: PR479R7VariadicData<() => { stack: string }>): string { return error.stack; }',
    'type PR479R7StringIndexData<T> = T extends { [key: string]: infer V } ? V : never; function frames(error: PR479R7StringIndexData<{ [key: string]: { stack: string } }>): string { return error.stack; }',
    'type PR479R7NumberIndexData<T> = T extends { [key: number]: infer V } ? V : never; function frames(error: PR479R7NumberIndexData<{ [key: number]: { stack: string } }>): string { return error.stack; }',
    'type PR479R6TupleData<T> = T extends [infer H, ...unknown[]] ? H : never; function frames(error: PR479R6TupleData<[{ stack: string }]>): string { return error.stack; }',
    'type PR479R6IndexData = { [key: string]: { stack: string } }; function frames(error: PR479R6IndexData["failure"]): string { return error.stack; }',
    'type PR479R6Numeric<T> = T extends number ? { stack: string } : Error; function frames(error: PR479R6Numeric<-1>): string { return error.stack; }',
    'type PR479R6Subclass<T> = T extends RangeError ? { stack: string } : Error; function frames(error: PR479R6Subclass<TypeError>): string { return error.stack; }',
    'const Base = class { stack = "data"; }; class Error extends Base {} function frames(error: Error): string { return error.stack; }',
    'type Wrapped<T> = T extends boolean | Error ? { stack: string } : Error; function frames(error: Wrapped<boolean>): string { return error.stack; }',
    'type Take<T> = T extends { error: infer U } ? U : never; function frames(error: Take<{ error: { stack: string } } | { error: { stack: string }; unrelated: Error }>): string { return error.stack; }',

    'type Wrapped<T> = T extends object ? { stack: string } : Error; function frames(error: Wrapped<string[]>): string { return error.stack; }',

    'type Wrapped<T> = T extends infer Inferred ? Inferred : never; function frames(error: Wrapped<{ stack: string }>): string { return error.stack; }',
    'type Wrapped = Readonly<{ stack: string }>; function frames(error: Wrapped): string { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<{ stack: string }> : T; function frames(error: Wrapped<string>): string { return error.stack; }',
    "type Wrapped = { error: Error; data: { stack: string } }['data']; function frames(error: Wrapped): string { return error.stack; }",
    'interface Failure {} class Failure { stack = "data"; } function frames(error: Failure): string { return error.stack; }',
    'type Readonly<T> = { stack: string }; type Wrapped = Readonly<Error>; function frames(error: Wrapped): string { return error.stack; }',

    'type Wrapped<T> = T extends unknown ? T : never; function frames(error: Wrapped<{ stack: string }>): string { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? { stack: string } : Error; function frames(error: Wrapped<Error>): string { return error.stack; }',
    'type Wrapped<T> = T extends string ? Error : { stack: string }; function frames(error: Wrapped<number>): string { return error.stack; }',
    'class Data { stack = "data"; } class Error extends Data {} function frames(error: Error): string { return error.stack; }',
    'function dec(_value: unknown) { return (_class: unknown) => {}; } const Data = @dec(((error: Error) => error.stack)({ stack: "data" })) class Error { stack = "data"; }; function frames(_value: unknown): string { return new Data().stack; }',
    "function frames(value: unknown): string { switch ('data') { case 'data': type Error = { stack: string }; function read(error: Error): string { return error.stack; } return read({ stack: 'data' }); default: return ''; } }",
    "function frames(value: unknown): string { switch ('data') { case 'data': interface Error { stack: string }; function read(error: Error): string { return error.stack; } return read({ stack: 'data' }); default: return ''; } }",
    "function frames(value: unknown): string { switch ('data') { case 'data': class Error { stack = 'data'; }; function read(error: Error): string { return error.stack; } return read({ stack: 'data' }); default: return ''; } }",
    'type Wrapped<T> = { stack: string }; function frames(error: Wrapped<Error>): string { return error.stack; }',
    "type Identity<T> = T; type Maybe<T> = Identity<T> | undefined; function frames(error: Maybe<{ stack: string }>): string { return error?.stack ?? ''; }",
    "type Maybe<T = { stack: string }> = T | undefined; function frames(error: Maybe): string { return error?.stack ?? ''; }",
    'type Wrapped<Error> = Error; function frames(error: Wrapped<{ stack: string }>): string { return error.stack; }',
    'type Identity<T> = T; function frames<Error extends { stack: string }>(error: Identity<Error>): string { return error.stack; }',
    'type Wrapped = { readonly stack: string }; function frames(error: Wrapped): string { return error.stack; }',
    "type Wrapped = Error; function frames(value: unknown): string { type Wrapped = { readonly stack: string }; const error: Wrapped = { stack: 'data' }; return error.stack; }",
    'type Wrapped = Error; function frames<Wrapped extends { stack: string }>(error: Wrapped): string { return error.stack; }',
    'type Error = { readonly stack: string }; type Wrapped = Error; function frames(error: Wrapped): string { return error.stack; }',
    "import type { Error } from '@/domain/error-data'; type Wrapped = Error; function frames(error: Wrapped): string { return error.stack; }",
    "import type Error from '@/domain/error-data'; type Wrapped = Error; function frames(error: Wrapped): string { return error.stack; }",
  ])(
    'keeps application stack data shared across type aliases and shadows: %s',
    async (declarations) => {
      const helper = [
        "import type { TodoFilter } from '@/navigation';",
        declarations,
        'export function normalizeFilter(value: string): TodoFilter {',
        "  return frames({ stack: 'data' }).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';",
        '}',
      ].join('\n');
      const app = await application({
        'domain/error-data.ts':
          'export type Error = { readonly stack: string }; export type { Error as default };',
        'domain/todo-filter.ts': helper,
      });
      apps.push(app);
      const compiled = compiledApp(app, api);

      expect(compiled.refusals).toStrictEqual([]);
      expect(output(compiled, app, 'components/project-workspace.authority.mts')).toContain(
        'normalizeFilter',
      );
    },
  );
});

describe('intersection never data admission', () => {
  const { apps, compile } = compilerApplications();

  it('keeps PR479IntersectionNeverData plain branches shared', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type PR479IntersectionNeverData = (string & number) extends never ? { stack: string } : { stack: string }; function frames(error: PR479IntersectionNeverData): string { return error.stack; }',
        "export function normalizeFilter(value: string): TodoFilter { return frames({ stack: 'fixed' }).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('nested any field data admission', () => {
  const { apps, compile } = compilerApplications();

  it('keeps nested any fields outside whole-any normalization', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = ({ item: any } | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({ stack: \"fixed\" })).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('async find parameter fallback data boundary', () => {
  const { apps, compile } = compilerApplications();

  it('keeps async find getter receiver data outside the parameter fallback', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){function collect(input:{errors:Error[]}){return input.errors.find(async()=>false)!.stack;}return collect({get errors(){Object.assign(error,{stack:"fixed"});return[error];}});}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('callback rest container admission', () => {
  const { apps, compile } = compilerApplications();

  it('keeps PR479CallbackRestFreshArray separate from its argument', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{result=(values as {stack?:string}).stack});return result;}',
        "export function normalizeFilter(value: string): TodoFilter { return String(frames(new Error('ours'))).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    });

    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('date array text renders', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      kind: 'native Date words private',
      source: 'export function Widget(){return <p>{[new Date(0)].toString()}</p>;}',
      shared: false,
    },
    {
      kind: 'ordinary array words shared',
      source: 'export function Widget(){return <p>{["fixed",0,null].toString()}</p>;}',
      shared: true,
    },
  ])('keeps $kind', async ({ source: widget, shared }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${widget}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(shared);
  });
});

describe('mapper rest container admission', () => {
  const { apps, compile } = compilerApplications();

  it('keeps PR479MapperRestFreshArray distinct from its first argument', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return ([error].map((...values:unknown[])=>values)[0] as {stack?:string}).stack;}',
        "export function normalizeFilter(value: string): TodoFilter { return String(frames(new Error('ours'))).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('closed parameter utility binder admission', () => {
  const { apps, compile } = compilerApplications();

  it('takes the native parameter utility own-unknown data branch', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = Parameters<<T>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({ stack: \"fixed\" })).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('promise resolve evaluated root arguments', () => {
  const { apps, compile } = compilerApplications();

  it('takes the repaired Promise resolve root tail', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then()).stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('pr479 whole-any target precision', () => {
  const { apps, compile } = compilerApplications();

  it('pr479 whole-any unknown target data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = (any | string) extends unknown ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({ stack: \"fixed\" })).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('raw own arraylike data boundary', () => {
  const { apps, compile } = compilerApplications();

  it('raw own arraylike keeps data behind an opaque getter', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return String.raw({raw:{get 0(){Object.assign(error,{name:"",message:"fixed"});return error as never;},length:1}});}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('regexp-like selected text fields', () => {
  const { apps, compile } = compilerApplications();

  it('takes flags that replace the RegExp-like unused Error field', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:"fixed",flags:error} as never,"i").flags;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native Error cause data boundary', () => {
  const { apps, compile } = compilerApplications();

  it('cause literal member data remains admitted', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\nfunction frames(){return(new Error("ours",{cause:{stack:"fixed"}}).cause as{stack:string}).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames()).length>40?"all":value==="active"||value==="done"?value:"all";}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native inherited JSON member data', () => {
  const { apps, compile } = compilerApplications();

  it('inherited JSON property list keeps own data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return JSON.stringify({__proto__:error,stack:'fixed'},['stack']);}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('html attribute data boundaries', () => {
  const { apps, compile } = compilerApplications();

  it('html ignored attributes keep data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return ('x'.link as(...args:unknown[])=>string)('fixed',error);}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native String Date array renders', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      kind: 'native String Date array private',
      source: 'export function Widget(){return <p>{String([new Date(0)])}</p>;}',
      shared: false,
    },
    {
      kind: 'ordinary String array shared',
      source: 'export function Widget(){return <p>{String(["fixed",0,null])}</p>;}',
      shared: true,
    },
  ])('keeps $kind', async ({ source: widget, shared }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${widget}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(shared);
  });
});

describe('callable whole-any parameter data', () => {
  const { apps, compile } = compilerApplications();

  it('callable unknown parameter keeps data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = ((value:number)=>void) extends ((value:unknown|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({stack:\"fixed\"})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('finite Map result data boundaries', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'missing-value-same-key-clears-error',
      helper:
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){try{return new Map([['first',error],['first'] as never]).values().next().value!.stack;}catch{return'fixed';}}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    {
      id: 'get-reported-spread-safe',
      helper:
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...(['safe'] as const))!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
  ])('$id', async ({ helper }) => {
    const app = await application({ 'domain/todo-filter.ts': helper });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('set mixed identity bounds', () => {
  const { apps, compile } = compilerApplications();

  it('keeps Error-only parameter primitive slots', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(value:Error,error:Error){return new AggregateError(new Set([value,0,error]),\"ours\").errors[1]?.stack??\"fixed\";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"first\"),new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('implicit Date array template renders', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      kind: 'implicit Date array template private',
      source: `export function Widget(){return <p>{\`\${[new Date(0)]}\`}</p>;}`,
      shared: false,
    },
    {
      kind: 'ordinary array template shared',
      source: `export function Widget(){return <p>{\`\${["fixed",0,null]}\`}</p>;}`,
      shared: true,
    },
  ])('keeps $kind', async ({ source: widget, shared }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${widget}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(shared);
  });
});

describe('closed InstanceType own binder data', () => {
  const { apps, compile } = compilerApplications();

  it('takes native InstanceType own-unknown data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = InstanceType<new<T>() => T extends string ? Error : {stack: string}>; function frames(value: Failure) { return value.stack; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({stack:\"fixed\"})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('inherited Object written shadows', () => {
  const { apps, compile } = compilerApplications();

  it('keeps an incompatible own method value ordinary', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Failure={toString():number} extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:\"fixed\"})).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('binary Date array text renders', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      kind: 'binary Date array text private',
      source: "export function Widget(){return <p>{'' + [new Date(0)]}</p>;}",
      shared: false,
    },
    {
      kind: 'ordinary array addition shared',
      source: 'export function Widget(){return <p>{\'\' + ["fixed",0,null]}</p>;}',
      shared: true,
    },
  ])('keeps $kind', async ({ source: widget, shared }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${widget}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(shared);
  });
});

describe('nested whole-any pattern data', () => {
  const { apps, compile } = compilerApplications();

  it('nested ordinary union keeps data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = {value:number|string} extends {value:number} ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({stack:\"fixed\"})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('repeated resolved structural data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps the selected ordinary data branch', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype A0=number;type A1={x:A0,y:A0};type A2={x:A1,y:A1};type A3={x:A2,y:A2};type A4={x:A3,y:A3};type Failure=A4 extends A4?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:'fixed'})).length>40?'all':value==='active'||value==='done'?value:'all';}\n",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('clone inherited Error data', () => {
  const { apps, compile } = compilerApplications();

  it('takes empty ordinary cloned prototypes', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return structuredClone(Object.create(error)).stack ?? \"fixed\";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly named replacer middleware', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a readonly named replacer middleware', async () => {
    const app = await application({
      'app/boards/[projectId]/middleware.ts':
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction read(_key:string,value:unknown){return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);
  });
});

describe('map SameValueZero keys', () => {
  const { apps, compile } = compilerApplications();

  it('last native NaN key selects fixed data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return (new Map<number,unknown>([[NaN,error],[Number.NaN,{stack:\"fixed\"}]]).get(0/0) as {stack:string}).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('array with omitted replacement', () => {
  const { apps, compile } = compilerApplications();

  it('native with omission installs undefined', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(0)[0]?.stack ?? \"fixed\";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('interface any index ordinary result', () => {
  const { apps, compile } = compilerApplications();

  it('takes the native any-index ordinary branch', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'interface Bag{x:string}type Failure=Bag extends {[key:string]:any}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({stack:'fixed'})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('own array text argument', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a source-written array text method', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        "function frames(error:Error){const values=[error];values.toString=()=> 'fixed';return 'x'.concat(values as never);}",
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('later argument preserves array text override', () => {
  const { apps, compile } = compilerApplications();

  it('keeps complete argument evaluation before text conversion', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        "function frames(error:Error){const values=[error];return 'x'.concat(values as never,(values.toString=()=> 'fixed',''));}",
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('nonconstructible ignored tail preserves array opacity', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a native failure before array text conversion', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        "function frames(error:Error){return ('x'.startsWith as (...args:unknown[])=>boolean)([error],0,new (String.prototype as unknown as new()=>unknown)());}",
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native String scalar Date alias admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: 'export function Widget(){const text=String;return <p>{text(new Date(0))}</p>;}',
      private: true,
    },
    {
      source:
        'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";const text=String;return <p>{text(date)}</p>;}',
      private: false,
    },
  ])(
    'keeps the written Date conversion boundary $private',
    async ({ source: widgetSource, private: privateRender }) => {
      const app = await application({
        'controls/widget.tsx': `'use client';\n${widgetSource}`,
        'app/boards/layout.tsx': [
          "import type {ReactNode} from 'react';",
          "import {Widget} from '@/controls/widget';",
          'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
        ].join('\n'),
      });
      apps.push(app);
      const compiled = compile(app);
      const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
        routes: { route: string; shared: boolean; private?: string }[];
      };
      const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
      const found = {
        refusals: compiled.refusals,
        shared: board?.shared,
        private: board?.private !== undefined,
      };
      const expected = { refusals: [], shared: !privateRender, private: privateRender };

      expect(found).toStrictEqual(expected);
    },
  );
});

describe('readonly native at middleware', () => {
  const { apps, compile } = compilerApplications();

  it('keeps readonly native at middleware', async () => {
    const app = await application({
      'app/boards/[projectId]/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.at(0);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('unguarded not-found boundary root', () => {
  const { apps, compile } = compilerApplications();

  it('keeps an unregistered root outside route guards', async () => {
    const app = await application({
      'components/not-found-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';\nexport default function NotFoundStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n",
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('sparse Array.from identity undefined', () => {
  const { apps, compile } = compilerApplications();

  it('keeps an identity-mapped hole as undefined data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function frames(error:Error){return Array.from([,error],value=>value)[0]?.stack??"fixed";}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('sparse Array.from nonconstructor tail', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a throwing ignored argument ahead of the mapper result', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function frames(error:Error){return Array.from([,],()=>error,new (Array.from as unknown as new()=>unknown)())[0]!.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('omitted Map set replacement', () => {
  const { apps, compile } = compilerApplications();

  it('known omitted value clears the original Error', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\nfunction frames(error:Error){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?\'all\':value===\'active\'||value===\'done\'?value:\'all\';}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('typed native Error initializer words', () => {
  const { apps, compile } = compilerApplications();

  it('keeps the message supplied by a direct Error initializer', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function words(){const {message}:Error=new Error("ours");return message;}',
        "export function normalizeFilter(value:string):TodoFilter{return words().length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('noncoercing constructor message comparison', () => {
  const { apps, compile } = compilerApplications();

  it('keeps written message words selected by strict identity', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'class Failure extends Error{constructor(error:Error){super(error===undefined?"missing":"present");}}function frames(error:Error){return new Failure(error).message;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('closed tuple at data selection', () => {
  const { apps, compile } = compilerApplications();

  it('selects the fixed data slot', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return [error,{stack:\"fixed\"}].at(...([1] as const))!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('whole unknown conditional distribution', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a whole unknown argument on its data branch', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|string>;function frames(value:Failure){return value.stack??"";}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({stack:\"fixed\"})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('numeric Omit key identity keeps data', () => {
  const { apps, compile } = compilerApplications();

  it('removes the matching numeric key before an ordinary data replacement', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'type Failure=Omit<{0:Error},0>&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return frames({0:{stack:'fixed'}}).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('identity mapped numeric omission data', () => {
  const { apps, compile } = compilerApplications();

  it('retains existing mapped source transparency for a matching key omission', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'type Copy<T>={[P in keyof T]:T[P]};type Failure=Omit<Copy<{0:Error}>,0>&{0:{stack:string}};function frames(value:Failure){return value[0].stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return frames({0:{stack:'fixed'}}).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('filter defaults retain selected data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps the first compacted ordinary data slot', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return [,{stack:"fixed"},error].filter((value:Error|{stack:string}|undefined=(()=>undefined)())=>true)[0]!.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return frames(new Error("ours")).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly named native middleware', () => {
  const { apps, compile } = compilerApplications();

  it('keeps readonly named native middleware', async () => {
    const app = await application({
      'app/boards/[projectId]/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction read(item:{allowed:boolean}){return item.allowed;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(read);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('date join separator render admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'date separator is request specific',
      value: "['a','b'].join(new Date(0) as never)",
      private: true,
    },
    {
      what: 'utc separator remains shared',
      value: "['a','b'].join(new Date(0).toUTCString())",
      private: false,
    },
  ])('$what', async ({ value, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\nexport function Widget(){return <p>{${value}}</p>;}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});

describe('callable metadata data branch', () => {
  const { apps, compile } = compilerApplications();

  it('keeps the exact Function length data branch', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Data={stack:string};type Failure={():string} extends {length:number}?Data:Error;function frames(value:Failure){return value.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return frames({stack:"fixed"}).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('nullish proxy forwarding data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a source-written target data field', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return new Proxy({x:{stack:"fixed"}},{get:undefined} as never).x.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return frames(new Error("ours")).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('nullish proxy replacement data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a later written own trap', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){const handler:{get:undefined|(()=>{stack:string})}={get:undefined};handler.get=()=>({stack:"fixed"});return new Proxy({x:error},handler).x.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('absent finally data admission', () => {
  const { apps, compile } = compilerApplications();

  it('keeps ordinary fulfilled data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'async function frames(){return(await Promise.resolve({stack:"fixed"}).finally()).stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames()).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('generic Error fields keep written data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps fixed data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return Error.prototype.toString.call({name:\"ours\",message:\"fixed\"});}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('reducer const result keeps ordinary data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps fixed data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return [0].reduce((acc)=>{const result=acc;return result;},{stack:\"fixed\"}).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('typepair empty admits data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps data selected by an empty discriminant', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        "type Failure=({kind:'a'}&{kind:'b'}) extends {missing:number}?{stack:string}:Error;function frames(value:Failure){return value.stack;}",
        'export function normalizeFilter(value:string):TodoFilter{return frames({stack:"fixed"}).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('typepair awaited data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps a noncallable then object as data', async () => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure=Awaited<{then:number;error:{stack:string}}>;function frames(value:Failure){return value.error.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return frames({then:1,error:{stack:"fixed"}}).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native utility unknown extract data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps ordinary data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Extract<unknown|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:"fixed"})).length>40?"all":value==="active"||value==="done"?value:"all";}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native utility unknown exclude data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps ordinary data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Exclude<unknown|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:"fixed"})).length>40?"all":value==="active"||value==="done"?value:"all";}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native utility boolean exclude data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps ordinary data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Exclude<boolean,true|false>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:"fixed"})).length>40?"all":value==="active"||value==="done"?value:"all";}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native utility boolean extract data', () => {
  const { apps, compile } = compilerApplications();

  it('keeps ordinary data', async () => {
    const app = await application({
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Extract<boolean,true>;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({stack:"fixed"})).length>40?"all":value==="active"||value==="done"?value:"all";}',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly native search middleware', () => {
  const { apps, compile } = compilerApplications();

  it('keeps readonly search middleware', async () => {
    const app = await application({
      'app/boards/[projectId]/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.find(()=>true);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('borrowed Date parser render admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'local parser is request specific',
      value: 'String(Date.parse.call(null,"2020-01-01T00:00"))',
      private: true,
    },
    {
      what: 'fixed parser remains shared',
      value: 'String(Date.parse.call(null,"2020-01-01T00:00Z"))',
      private: false,
    },
  ])('$what', async ({ value, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\nexport function Widget(){return <p>{${value}}</p>;}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});

describe('readonly native slice middleware', () => {
  const { apps, compile } = compilerApplications();

  it('keeps readonly slice middleware', async () => {
    const app = await application({
      'app/boards/[projectId]/middleware.ts':
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.slice();\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('borrowed array Date conversion render admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'borrowed array Date text is request specific',
      value: "Array.prototype.join.call([new Date(0)],'')",
      private: true,
    },
    {
      what: 'borrowed String Date is request specific',
      value: 'String.call(null,new Date(0))',
      private: true,
    },
    {
      what: 'borrowed String data remains shared',
      value: 'String.call(null,"fixed")',
      private: false,
    },
    {
      what: 'borrowed ISO array remains shared',
      value: "Array.prototype.join.call([new Date(0).toISOString()],'')",
      private: false,
    },
  ])('$what', async ({ value, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\nexport function Widget(){return <p>{${value}}</p>;}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});

describe('array Date addition assignment sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'Date array addition assignment stays private',
      source: "let text='';text += [new Date(0)];",
      private: true,
    },
    {
      what: 'ISO array addition assignment stays shared',
      source: "let text='';text += [new Date(0).toISOString()];",
      private: false,
    },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){',
        row.source,
        'return <p>{text}</p>;',
        '}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('mutable array Date binary addition sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'mutable Date array binary text stays private',
      source: "let text='';let dates=[new Date(0)];",
      expression: 'text+dates',
      private: true,
    },
    {
      what: 'mutable scalar array binary text stays shared',
      source: "let text='';let values=[1,'x',true];",
      expression: 'text+values',
      private: false,
    },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){',
        row.source,
        ['return <p>{', row.expression, '}</p>;'].join(''),
        '}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('bound Intl formatter clock sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { what: 'omitted bound date stays private', date: '', private: true },
    { what: 'explicit bound epoch stays shared', date: ',0', private: false },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){return <p>{JSON.stringify(',
        `Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'})${row.date})()`,
        ')}</p>;}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('readonly native reordering middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'reversed-fresh-wrapper-slot-write',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toReversed()[0]={allowed:true};\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'readonly-toSorted-quiet-two-items',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.toSorted();\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('mutable Date text consumer sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'mutable native Date arrays stay private',
      body: 'let dates=[new Date(0)];',
      expression: 'String(dates)',
      private: true,
    },
    {
      what: 'finite native String Date spread stays private',
      body: '',
      expression: 'String(...[new Date(0)] as const)',
      private: true,
    },
    {
      what: 'mutable ISO data arrays stay shared',
      body: 'let dates=[new Date(0).toISOString()];',
      expression: 'String(dates)',
      private: false,
    },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){',
        row.body,
        ['return <p>{', row.expression, '}</p>;'].join(''),
        '}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('native raw tag Date array sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'native raw Date array tag stays private',
      body: '',
      expression: `String.raw\`\${[new Date(0)]}\``,
      private: true,
    },
    {
      what: 'native raw consumed Date array stays private',
      body: 'let dates=[new Date(0)];',
      expression: "String.raw({raw:['','']},dates)",
      private: true,
    },
    {
      what: 'native raw unconsumed Date array stays shared',
      body: 'let dates=[new Date(0)];',
      expression: "String.raw({raw:['fixed']},dates)",
      private: false,
    },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){',
        row.body,
        ['return <p>{', row.expression, '}</p>;'].join(''),
        '}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('independent literal container middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'readonly-object-holder',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};\nawait requirePublishedProject(params.projectId);\nvoid box.decision;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'object-wrapper-replaced-before-read',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};box.decision={allowed:false};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native raw earlier array Date sharing admission', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'earlier empty raw array retains later Date text',
      body: '',
      expression: `String.raw\`\${[]}\${[new Date(0)]}\``,
      private: true,
    },
    {
      what: 'earlier local raw array retains later Date text',
      body: 'let prefix=[1];',
      expression: `String.raw\`\${prefix}\${[new Date(0)]}\``,
      private: true,
    },
    {
      what: 'only primitive raw arrays keep shared data',
      body: '',
      expression: `String.raw\`\${[1]}\${['x']}\``,
      private: false,
    },
  ])('$what', async (row) => {
    const app = await application({
      'controls/widget.tsx': [
        "'use client';",
        'export function Widget(){',
        row.body,
        ['return <p>{', row.expression, '}</p>;'].join(''),
        '}',
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('authorization boundary without guards', () => {
  const { apps, compile } = compilerApplications();

  it.each(['forbidden', 'unauthorized'])('keeps %s roots outside guards', async (kind) => {
    const app = await application({
      '../next.config.mjs': 'export default {experimental:{authInterrupts:true}};\n',
      'components/boundary-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';\nexport default function BoundaryStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n",
      'app/boards/[projectId]/page.tsx': `import {${kind}} from 'next/navigation';export default function Page(){${kind}();}\n`,
      [`app/boards/[projectId]/${kind}.tsx`]:
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly native toSpliced middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'spliced-readonly-copy-pin',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.toSpliced()[0]!.allowed;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'spliced-fresh-slot-pin',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\nconst copy=decision.toSpliced();copy[0]={allowed:true};\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly native copied middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'concat-fresh-argument-slot',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat([{allowed:false}])[1]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'map-fresh-payload-control',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.map(()=>fresh)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      nativeExpected: 'false',
      originalPayloadExpectedToChange: false,
      refused: false,
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native Date join spread conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){return <p>{[new Date(0)].join(...[''] as const)}</p>;}`,
      private: true,
    },
    {
      source: `export function Widget(){return <p>{['x','y'].join(...[new Date(0) as unknown as string] as const)}</p>;}`,
      private: true,
    },
    {
      source: `export function Widget(){return <p>{[1,'x'].join(...['|'] as const)}</p>;}`,
      private: false,
    },
  ])('keeps written native join text inputs $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('native Date parser spread conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
      private: true,
    },
    {
      source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00Z'] as const))}</p>;}`,
      private: false,
    },
  ])('keeps written native parser text inputs $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('immediate captured Date array conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){const dates=[new Date(0)];const render=()=>dates.join(...[''] as const);return <p>{render()}</p>;}`,
      private: true,
    },
    {
      source: `export function Widget(){const dates=[new Date(0)];const render=function(){return dates.join('');};return <p>{render()}</p>;}`,
      private: true,
    },
    {
      source: `export function Widget(){const dates=[new Date(0).toISOString()];const render=()=>dates.join('');return <p>{render()}</p>;}`,
      private: false,
    },
  ])('keeps immediate local native Date text $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board?.shared).toBe(!row.private);
    expect(board?.private !== undefined).toBe(row.private);
  });
});

describe('readonly native iterator middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'fresh-result-value-replacement',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst result=decision.values().next();result.value={allowed:false};result.value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'readonly-native-result',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nvoid decision.values().next().value!.allowed;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('readonly native entry iterator middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'fresh-entry-payload-replacement',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst pair=decision.entries().next().value!;pair[1]={allowed:false};pair[1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
    {
      id: 'readonly-whole-entry-pair',
      source:
        "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\nconst pair=decision.entries().next().value!;void pair;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
      refused: false,
      nativeExpected: 'false',
    },
  ])('$id', async ({ source: middlewareSource }) => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': middlewareSource });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('commonjs root main pins', () => {
  const { apps, compile } = compilerApplications();
  const cases: readonly {
    readonly id: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      id: 'ordinary-commonjs-root-pin',
      files: {
        'app/boards/[projectId]/page.tsx':
          "const {default:Board}=require('@/controls/ordinary');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
        'controls/ordinary.tsx':
          'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}\n',
      },
    },
    {
      id: 'shadowed-require-pin',
      files: {
        'app/boards/[projectId]/page.tsx':
          "function require(_name:string){return{default:({projectId}:{projectId:string})=><p>{projectId}</p>};}\nconst {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      },
    },
  ];

  it.each(cases)('$id', async ({ files }) => {
    const app = await application(files);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('rendered client multipart constructions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { expression: "new Response(new FormData()).headers.get('content-type')", privateRender: true },
    { expression: "new FormData().has('name') ? 'yes' : 'no'", privateRender: false },
  ])(
    'keeps the construction boundary private: $privateRender',
    async ({ expression, privateRender }) => {
      const app = await application({
        'controls/widget.tsx': `'use client'; export function Widget(){return <p>{${expression}}</p>;}`,
        'app/boards/layout.tsx': [
          "import type {ReactNode} from 'react';",
          "import {Widget} from '@/controls/widget';",
          'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
        ].join('\n'),
      });
      apps.push(app);
      const compiled = compile(app);
      const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
        routes: { route: string; shared: boolean; private?: string }[];
      };
      const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

      expect({
        refusals: compiled.refusals,
        shared: board?.shared,
        private: board?.private !== undefined,
      }).toStrictEqual({ refusals: [], shared: !privateRender, private: privateRender });
    },
  );
});

describe('commonjs wrapper main pins', () => {
  const { apps, compile } = compilerApplications();
  const cases: readonly {
    readonly id: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      id: 'ordinary-commonjs-wrapper-pin',
      files: {
        'app/boards/[projectId]/page.tsx':
          "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
        'controls/wrapper.tsx':
          "const{default:Board}=require('@/controls/ordinary');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}",
        'controls/ordinary.tsx':
          'export default function Board({projectId}:{projectId:string}){return <p>{projectId}</p>;}',
      },
    },
    {
      id: 'shadowed-wrapper-require-pin',
      files: {
        'app/boards/[projectId]/page.tsx':
          "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
        'controls/wrapper.tsx':
          "function require(_name:string){return{default:({projectId}:{projectId:string})=><p>{projectId}</p>};}\nconst{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
      },
    },
  ];

  it.each(cases)('$id', async ({ files }) => {
    const app = await application(files);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('value reexport main pins', () => {
  const { apps, compile } = compilerApplications();
  const cases: readonly {
    readonly id: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      id: 'whole-type-only-reexport-pin',
      files: {
        'app/boards/[projectId]/page.tsx':
          "export type {default} from '@/controls/board-page';\nexport default function Page(){return <p>fixed</p>;}\n",
        'controls/board-page.tsx':
          "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      },
    },
    {
      id: 'ordinary-default-reexport-pin',
      files: {
        'app/boards/[projectId]/page.tsx': "export {default} from '@/controls/ordinary';",
        'controls/ordinary.tsx': 'export default function Page(){return <p>fixed</p>;}\n',
        'app/boards/middleware.ts':
          "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      },
    },
  ];

  it.each(cases)('$id', async ({ files }) => {
    const app = await application(files);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native multipart constructor aliases', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { body: 'new FormData()', privateRender: true },
    { body: "'fixed'", privateRender: false },
  ])('preserves native alias body identity: $privateRender', async ({ body, privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client'; export function Widget(){const BodyResponse=Response;return <p>{new BodyResponse(${body}).headers.get('content-type')}</p>;}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !privateRender, private: privateRender });
  });
});

describe('native string concat Date conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){return <p>{''.concat(new Date(0) as unknown as string)}</p>;}`,
      private: true,
    },
    { source: `export function Widget(){return <p>{''.concat('fixed')}</p>;}`, private: false },
  ])('retains a native concat text input $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !row.private, private: row.private });
  });
});

describe('native DurationFormat default locale', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { locale: '', privateRender: true },
    { locale: "'en-US'", privateRender: false },
  ])('retains the native locale boundary: $privateRender', async ({ locale, privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client'; export function Widget(){return <p>{new Intl.DurationFormat(${locale}).format({hours:1})}</p>;}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !privateRender, private: privateRender });
  });
});

describe('parallel slot default main pins', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      what: 'plain',
      defaultSource: 'export default function Page(){return <p>plain</p>;}\n',
    },
    {
      what: 'root',
      defaultSource:
        'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
    },
  ])('keeps an unguarded $what default accepted', async ({ defaultSource }) => {
    const app = await application({
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'components/slot-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';export default function SlotStatus({projectId}:{projectId:string}){const [value,setValue]=useReactiveState<string>(projectId);return <section><button onClick={()=>setValue('next')}>{value}</button></section>;}\n",
      'app/boards/@panel/default.tsx': defaultSource,
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

describe('native string padding Date conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){return <p>{''.padStart(70,new Date(0) as never)}</p>;}`,
      private: true,
    },
    { source: `export function Widget(){return <p>{''.padStart(5,'fixed')}</p>;}`, private: false },
  ])('retains a native padding fill input $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !row.private, private: row.private });
  });
});

describe('native string replacement Date conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){return <p>{''.replace('',new Date(0) as never)}</p>;}`,
      private: true,
    },
    { source: `export function Widget(){return <p>{''.replace('','fixed')}</p>;}`, private: false },
  ])('retains a native replacement text input $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !row.private, private: row.private });
  });
});

describe('native string replacement search Date conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(new Date(0) as never,'epoch')}</p>;}`,
      private: true,
    },
    { source: `export function Widget(){return <p>{''.replace('','fixed')}</p>;}`, private: false },
  ])('retains a native replacement text input $private', async (row) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${row.source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !row.private, private: row.private });
  });
});
