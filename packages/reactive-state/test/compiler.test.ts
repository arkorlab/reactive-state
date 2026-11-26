import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

import { type Compiled, compileApp, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import { PROTOCOL_VERSION } from '../src/program.ts';
import {
  application,
  type Application,
  cli,
  compiledApp,
  node,
  output,
  removed,
  source,
  typeCheck,
  variant,
  variantSource,
} from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A `set`'s id, as the contract says to hash it: its owner, the state, and `set`. */
function setId(owner: string, site: string): string {
  const hash = createHash('sha256').update(`${owner}:${site}:set`).digest('hex');
  return `u_${hash.slice(0, 20)}`;
}

const EDITOR = 'components/todo-editor';
const SET_TITLE = setId(EDITOR, 'title');
const SET_COMPLETED = setId(EDITOR, 'completed');
const SET_CAN_EDIT = setId('components/member-editor', 'canEdit');
const WORKSPACE = 'components/project-workspace';

/** Five separate CLI processes compile and inspect the application in this integration case. */
const CLI_TIMEOUT_MS = 30_000;

/** Every file a compile of the application writes, from its root. */
const OUTPUTS = [
  '.reactive/actions/publication.ts',
  '.reactive/actions/todos.ts',
  '.reactive/authority.mts',
  '.reactive/components/member-editor.authority.mts',
  '.reactive/components/member-editor.client.tsx',
  '.reactive/components/member-editor.root.tsx',
  '.reactive/components/project-access.authority.mts',
  '.reactive/components/project-access.root.tsx',
  '.reactive/components/project-commands.authority.mts',
  '.reactive/components/project-commands.root.tsx',
  '.reactive/components/project-content.authority.mts',
  '.reactive/components/project-content.root.tsx',
  '.reactive/components/project-layout.authority.mts',
  '.reactive/components/project-layout.root.tsx',
  '.reactive/components/project-summary.authority.mts',
  '.reactive/components/project-summary.root.tsx',
  '.reactive/components/project-workspace.authority.mts',
  '.reactive/components/project-workspace.client.tsx',
  '.reactive/components/project-workspace.root.tsx',
  '.reactive/components/project.authority.mts',
  '.reactive/components/project.root.tsx',
  '.reactive/components/public-board-layout.authority.mts',
  '.reactive/components/public-board-layout.root.tsx',
  '.reactive/components/public-board-stats.authority.mts',
  '.reactive/components/public-board-stats.root.tsx',
  '.reactive/components/public-board-todos.authority.mts',
  '.reactive/components/public-board-todos.root.tsx',
  '.reactive/components/public-board.authority.mts',
  '.reactive/components/public-board.root.tsx',
  '.reactive/components/publication-settings.authority.mts',
  '.reactive/components/publication-settings.client.tsx',
  '.reactive/components/publication-settings.root.tsx',
  '.reactive/components/todo-commands.authority.mts',
  '.reactive/components/todo-commands.root.tsx',
  '.reactive/components/todo-details.authority.mts',
  '.reactive/components/todo-details.root.tsx',
  '.reactive/components/todo-editor.authority.mts',
  '.reactive/components/todo-editor.client.tsx',
  '.reactive/components/todo-editor.root.tsx',
  '.reactive/components/todo-list.authority.mts',
  '.reactive/components/todo-list.root.tsx',
  '.reactive/components/todo-readonly.authority.mts',
  '.reactive/components/todo-readonly.client.tsx',
  '.reactive/components/todo-readonly.root.tsx',
  '.reactive/components/todo-results.authority.mts',
  '.reactive/components/todo-results.root.tsx',
  '.reactive/components/todo-row.authority.mts',
  '.reactive/components/todo-row.client.tsx',
  '.reactive/components/todo-row.root.tsx',
  '.reactive/elements.ts',
  '.reactive/hooks/use-estimate.ts',
  '.reactive/hooks/use-todo-filter.ts',
  '.reactive/hooks/use-todo-panels.ts',
  '.reactive/manifest.json',
  '.reactive/routes.ts',
  '.reactive/server-functions.ts',
  'src/app/api/reactive-state/[...path]/route.ts',
];

/** The id of the one `apply` a program registers. */
function applyIdIn(program: string): string {
  const line = program.split('\n').find((each) => each.includes('kind: "apply"')) ?? '';
  const id = /^ {2}"(u_[\da-f]{20})"/u.exec(line)?.[1];
  if (id === undefined) {
    throw new Error(`No apply is registered in:\n${program}`);
  }
  return id;
}

/** The files the command line says `what` of, each line of `stderr` one: their names alone. */
function namedIn(stderr: string, what: string): readonly string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(what))
    .map((line) => path.basename(line.slice(what.length)));
}

/** The line of `updaters` that registers `id`. */
function entryOf(program: string, id: string): string {
  return program.split('\n').find((line) => line.includes(`"${id}": {`)) ?? '';
}

/**
 * Loads the authority's registry the compile wrote for `app` in a Node of its own, as the Node
 * authority loads it (`registerPaths`), and answers what `body` — an expression that reads
 * `registry` — evaluates to, through JSON.
 */
function inAuthority(app: Application, body: string): unknown {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const ran = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const registry = await import(${JSON.stringify(path.join(app.out, 'authority.mts'))});`,
      `process.stdout.write(JSON.stringify(${body}));`,
    ].join('\n'),
    app.root,
  );
  if (ran.status !== 0) {
    throw new Error(ran.stderr);
  }
  return JSON.parse(ran.stdout) as unknown;
}

/** The TodoEditor's Client Component, as the contract shapes it. */
const EDITOR_CLIENT = [
  '// Generated by @arkorlab/reactive-state from components/todo-editor.reactive.tsx. Do not edit: change the component and compile it again.',
  "'use client';",
  '',
  "import { type ClientPartProps, slotOf, stateOf, useReactiveState } from '@arkorlab/reactive-state/react';",
  "import { TextInput, Checkbox } from '@/ui';",
  "import { useEstimate } from '../hooks/use-estimate';",
  "import type { States } from './todo-editor.authority.mts';",
  '',
  'export default function TodoEditor({ part }: ClientPartProps) {',
  '  const [title, setTitle] = useReactiveState(stateOf<States["title"]>(part, "title"));',
  '  const [completed, setCompleted] = useReactiveState(stateOf<States["completed"]>(part, "completed"));',
  '  const [step, setStep] = useReactiveState(1);',
  '  const [expanded, setExpanded] = useReactiveState(false);',
  "  const [draft, setDraft] = useReactiveState('');",
  '  const [estimate, increase] = useEstimate(stateOf<States["useEstimate#0.estimate"]>(part, "useEstimate#0.estimate"), step);',
  "  const status = completed ? '完了' : '未完了';",
  '',
  '  return (',
  '    <section data-testid="editor">',
  '      <TextInput aria-label="タイトル" value={title} onChange={setTitle} />',
  '      <Checkbox aria-label="完了" checked={completed} onCheckedChange={setCompleted} />',
  '      <p>{status}</p>',
  '',
  '      <label>',
  '        加算する見積もり',
  '        <select value={step} onChange={event => setStep(Number(event.currentTarget.value))}>',
  '          <option value={1}>1</option>',
  '          <option value={5}>5</option>',
  '        </select>',
  '      </label>',
  '      <button type="button" onClick={increase}>見積もり {estimate} に {step} 加算</button>',
  '',
  '      <button type="button" onClick={() => setExpanded(open => !open)}>詳細</button>',
  '      {expanded && (',
  '        <label>',
  '          自分だけのメモ',
  '          <textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} />',
  '        </label>',
  '      )}',
  '',
  '      {slotOf(part, "s0")}',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

describe('the compiler, of the Project Todo application as its author wrote it', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;
  /** What the compile wrote at `file`, its build id written `b_BUILD`. */
  const read = (file: string): string =>
    output(compiled, app, file).replaceAll(compiled.buildId, 'b_BUILD');

  beforeAll(async () => {
    api = openTypeScript();
    app = await application();
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('compiles every component, the hook and the operations they reach, and refuses nothing', () => {
    const written = [...compiled.outputs.keys()].map((file) => path.relative(app.root, file));

    expect(compiled.refusals).toStrictEqual([]);
    expect(written.toSorted((a, b) => a.localeCompare(b, 'en'))).toStrictEqual(OUTPUTS);
  });

  it('writes the TodoEditor’s program: its server part, its states, its slot, its updaters', () => {
    const program = read('components/todo-editor.authority.mts');
    const apply = applyIdIn(program);

    expect(program)
      .toBe(`// Generated by @arkorlab/reactive-state from components/todo-editor.reactive.tsx. Do not edit: change the component and compile it again.
import { componentRef, type ProgramUpdater, type RenderScope, type StatesOf } from '@arkorlab/reactive-state/program';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanEditTodo } from '@/permissions';
import { addEstimate } from '@/domain/estimate';

export const protocolVersion = ${String(PROTOCOL_VERSION)};
export const buildId = "b_BUILD";
export const component = "components/todo-editor";
const TodoCommands = componentRef("components/todo-commands");

export async function evaluate({ projectId, id }: {
  projectId: string; id: string;
}, $: RenderScope) {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);

  const ref = db.todos.ref(id);
  return $.client({
    props: {},
    states: { title: ref.title, completed: ref.completed, "useEstimate#0.estimate": ref.estimate },
    slots: { s0: $.h(TodoCommands, { projectId: projectId, id: id }) },
  });
}

export type States = StatesOf<typeof evaluate>;
export const writable = Object.freeze(["title", "completed", "useEstimate#0.estimate"]);
export const updaters = Object.freeze({
  "${SET_TITLE}": { keys: ["title"], kind: "set" },
  "${SET_COMPLETED}": { keys: ["completed"], kind: "set" },
  "${apply}": { keys: ["useEstimate#0.estimate"], kind: "apply", apply: (current: number, { step }: { step: number }): number => addEstimate(current, step) },
} satisfies Readonly<Record<string, ProgramUpdater>>);
`);
  });

  it('writes the TodoEditor’s Client Component: its JSX as written, its child a slot', () => {
    expect(read('components/todo-editor.client.tsx')).toBe(EDITOR_CLIENT);
  });

  it('writes the copy of useEstimate the browser runs: its input the authority’s, its update registered', () => {
    const apply = applyIdIn(read('components/todo-editor.authority.mts'));

    expect(read('hooks/use-estimate.ts'))
      .toBe(`// Generated by @arkorlab/reactive-state from hooks/use-estimate.ts. Do not edit: change the module and compile it again.
import { type StateInput, useReactiveState } from '@arkorlab/reactive-state/react';
import { addEstimate } from '@/domain/estimate';

// No authentication or transport declarations here: the caller's scope is retained.
export function useEstimate(ref: StateInput<number>, step: number) {
  const [estimate, setEstimate] = useReactiveState(ref);
  const increase = () => {
    setEstimate.compiled("${apply}", { step }, current => addEstimate(current, step));
  };
  return [estimate, increase] as const;
}
`);
  });

  it('writes Project, which has no state, as a program that renders its JSX as data, children and all', () => {
    expect(read('components/project.authority.mts'))
      .toBe(`// Generated by @arkorlab/reactive-state from components/project.reactive.tsx. Do not edit: change the component and compile it again.
import { componentRef, type RenderScope } from '@arkorlab/reactive-state/program';
import type { TodoFilter } from '@/navigation';

export const protocolVersion = ${String(PROTOCOL_VERSION)};
export const buildId = "b_BUILD";
export const component = "components/project";
const ProjectAccess = componentRef("components/project-access");
const ProjectContent = componentRef("components/project-content");

export function evaluate({ projectId, filter, selectedId }: {
  projectId: string;
  filter: TodoFilter;
  selectedId?: string;
}, $: RenderScope) {
  return (
    $.h(ProjectAccess, { projectId: projectId },
      $.h(ProjectContent, { projectId: projectId, initialFilter: filter, initialSelectedId: selectedId ?? '' }),
    )
  );
}

export const writable = Object.freeze([]);
export const updaters = Object.freeze({});
`);
  });

  it('writes ProjectAccess and ProjectLayout, which render the children they are given where they say', () => {
    const access = read('components/project-access.authority.mts');
    const layout = read('components/project-layout.authority.mts');

    expect(access).toContain(
      [
        'export async function evaluate({ projectId, children }: {',
        '  projectId: string;',
        '  children: ReactNode;',
        '}, $: RenderScope) {',
        '  const user = await requireUser();',
        '  await requireProjectAccess(user, projectId);',
        '',
        '  return $.h($.fragment, null, children);',
        '}',
      ].join('\n'),
    );
    expect(layout).toContain(
      [
        '    $.h("main", { "data-testid": "project-layout" },',
        '      $.h("h2", null, title),',
        '      $.h("div", { className: "project-layout" }, children),',
        '    )',
      ].join('\n'),
    );
    expect(access).toContain("import type { ReactNode } from 'react';");
  });

  it('writes ProjectContent, which hands the workspace, the commands and the members to its layout', () => {
    const program = read('components/project-content.authority.mts');
    const lines = [
      'const ProjectLayout = componentRef("components/project-layout");',
      'const ProjectWorkspace = componentRef("components/project-workspace");',
      'const ProjectSummary = componentRef("components/project-summary");',
      'const ProjectCommands = componentRef("components/project-commands");',
      'const MemberEditor = componentRef("components/member-editor");',
      'export async function evaluate({ projectId, initialFilter, initialSelectedId }: {',
      '  const choices = await db.todos.findMany({',
      [
        '    $.h(ProjectLayout, { title: access.project.title },',
        '      $.h(ProjectWorkspace, { key: JSON.stringify([projectId, initialFilter, initialSelectedId]), projectId: projectId, initialFilter: initialFilter, initialSelectedId: initialSelectedId, choices: choices },',
        '        $.h(ProjectSummary, { projectId: projectId }),',
        '      ),',
        '      access.canEdit && $.h(ProjectCommands, { projectId: projectId }),',
      ].join('\n'),
      '            $.h(MemberEditor, { key: membership.id, projectId: projectId, id: membership.id })',
      'export const writable = Object.freeze([]);\nexport const updaters = Object.freeze({});',
    ];

    for (const line of lines) {
      expect(program).toContain(line);
    }

    expect(program).not.toContain('States');
  });

  it('writes ProjectWorkspace’s program: the states its sites are rendered of, its children a slot, its list', () => {
    const program = read(`${WORKSPACE}.authority.mts`);

    // Each hook's state starts from a value of the page's: a local state, which the page sends for
    // the sites, each of which the authority computes again of it — the filter as the application
    // normalizes it, a detail for each panel.
    expect(program)
      .toBe(`// Generated by @arkorlab/reactive-state from components/project-workspace.reactive.tsx. Do not edit: change the component and compile it again.
import { componentRef, type RenderScope, type StatesOf } from '@arkorlab/reactive-state/program';
import type { ReactNode } from 'react';
import { requireUser } from '@/auth';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';
import { initialPanelsFor } from '@/domain/todo-panels';
import { normalizeFilter } from '@/domain/todo-filter';

export const protocolVersion = ${String(PROTOCOL_VERSION)};
export const buildId = "b_BUILD";
export const component = "components/project-workspace";
const TodoResults = componentRef("components/todo-results");
const TodoDetails = componentRef("components/todo-details");

export async function evaluate({ projectId, initialFilter, initialSelectedId, choices, children }: {
  projectId: string;
  initialFilter: TodoFilter;
  initialSelectedId: string;
  choices: readonly { readonly id: string; readonly title: string }[];
  children: ReactNode;
}, $: RenderScope) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const initialPanels = initialPanelsFor(initialSelectedId);
  return $.client({
    props: { choices },
    states: {
      "useTodoFilter#0.filter": initialFilter as import('@/navigation').TodoFilter,
      "useTodoPanels#0.panels": initialPanels as readonly import('@/domain/todo-panels').TodoPanel[],
    },
    slots: { s0: children },
    sites: {
      d0: { inputs: ["useTodoFilter#0.filter"], render: ({ "useTodoFilter#0.filter": filter }) => $.h(TodoResults, { projectId: projectId, filter: $.counted(normalizeFilter(filter)) }) },
      d1: { inputs: ["useTodoPanels#0.panels"], each: ({ "useTodoPanels#0.panels": panels }) => $.method(panels, "map")((panel) => $.counted({ item: panel, key: panel.panelId, render: () => $.h(TodoDetails, { key: $.counted(\`\${projectId}:\${panel.todoId}\`), projectId: projectId, id: panel.todoId }) })) },
    },
  });
}

export type States = StatesOf<typeof evaluate>;
export const writable = Object.freeze([]);
export const updaters = Object.freeze({});
`);
  });

  it('writes ProjectWorkspace’s Client Component: its hooks’ states, each panel’s detail an item of the list, its memos its own', () => {
    const client = read(`${WORKSPACE}.client.tsx`);
    const lines = [
      "import { type ClientPartProps, localOf, slotOf, useReactiveState, useSites } from '@arkorlab/reactive-state/react';",
      "import { useTodoFilter } from '../hooks/use-todo-filter';\nimport { useTodoPanels } from '../hooks/use-todo-panels';",
      '  const { choices } = part.props as { readonly choices: readonly { readonly id: string; readonly title: string }[] };',
      "  const [workspaceMemo, setWorkspaceMemo] = useReactiveState('');",
      '  const { filter, setFilter, effectiveFilter } = useTodoFilter(localOf<States["useTodoFilter#0.filter"]>(part, "useTodoFilter#0.filter"));',
      '  const { panels, openPanel, openMany, closePanel, closeAll, movePanel, replaceTodo } = useTodoPanels(localOf<States["useTodoPanels#0.panels"]>(part, "useTodoPanels#0.panels"));',
      '  const sites = useSites(part);',
      // A constant that reads a name stays where only a site reads it, since reading a name may
      // run or throw, and is read once so that the name it declares is used.
      '  const renderedFilter = effectiveFilter;\n  void renderedFilter;',
      '        {sites.of("d0", { "useTodoFilter#0.filter": filter })}',
      [
        '          {panels.map(panel => (',
        '            <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
        '              {sites.item("d1", { "useTodoPanels#0.panels": panels }, { item: panel, key: panel.panelId })}',
        '            </PanelCard>',
      ].join('\n'),
    ];

    for (const line of lines) {
      expect(client).toContain(line);
    }

    // What only the sites render, the authority renders again: the browser holds none of it.
    for (const absent of ['TodoResults', 'TodoDetails', 'children']) {
      expect(client).not.toContain(absent);
    }
  });

  it('writes TodoDetails with its early return, and its comments, as written', () => {
    expect(read('components/todo-details.authority.mts')).toContain(
      [
        '  // No hooks precede/follow this conditional in this component.',
        '  if (todo === null || todo.projectId !== projectId) {',
        '    return $.h("p", { role: "status" }, "選択した Todo は削除または移動されました。");',
        '  }',
        '',
        '  return access.canEdit',
        '    ? $.h(TodoEditor, { key: id, projectId: projectId, id: id })',
        '    : $.h(TodoReadOnly, { key: id, projectId: projectId, id: id });',
        '}',
      ].join('\n'),
    );
  });

  it('writes TodoList, a synchronous component, as a synchronous program', () => {
    const program = read('components/todo-list.authority.mts');

    expect(program).toContain('export function evaluate({ projectId, ids, filter }: {');
    expect(program).toContain(
      '      ids.map(id => $.h(TodoRow, { key: id, projectId: projectId, id: id, filter: filter })),',
    );
    expect(program).toContain(
      '$.h("p", { "data-testid": "empty-list" }, "該当する Todo はありません。")',
    );
  });

  it('gives TodoRow’s Client Component the props it reads, typed as written', () => {
    const row = read('components/todo-row.client.tsx');
    const program = read('components/todo-row.authority.mts');

    expect(program).toContain(
      [
        '  return $.client({',
        '    props: { projectId, id, filter },',
        '    states: { title: ref.title, completed: ref.completed, estimate: ref.estimate },',
        '    slots: {},',
        '  });',
      ].join('\n'),
    );
    expect(program).toContain(
      'export const writable = Object.freeze([]);\nexport const updaters = Object.freeze({});',
    );
    expect(row).toContain(
      '  const { projectId, id, filter } = part.props as { readonly projectId: string; readonly id: string; readonly filter: TodoFilter };',
    );
    expect(row).toContain(
      "import Link from 'next/link';\nimport { projectHref } from '@/navigation';\nimport type { TodoFilter } from '@/navigation';",
    );
    expect(row).toContain(
      '  const [title] = useReactiveState(stateOf<States["title"]>(part, "title"));',
    );
    expect(row).toContain(
      "      <Link href={projectHref(projectId, filter, id)}>{title || '無題'}</Link>",
    );
  });

  it('gives MemberEditor’s the one prop it reads, and TodoReadOnly’s none', () => {
    const member = read('components/member-editor.client.tsx');
    const program = read('components/member-editor.authority.mts');

    expect(program).toContain('    states: { canEdit: db.memberships.ref(id).canEdit },');
    expect(program).toContain(`  "${SET_CAN_EDIT}": { keys: ["canEdit"], kind: "set" },`);
    expect(member).toContain('  const { id } = part.props as { readonly id: string };');
    expect(member).toContain('      <Checkbox checked={canEdit} onCheckedChange={setCanEdit} />');
    expect(read('components/todo-readonly.client.tsx')).not.toContain('part.props');
  });

  it('binds ProjectCommands’ and TodoCommands’ server operations by reference, and calls none', () => {
    const project = read('components/project-commands.authority.mts');
    const todo = read('components/todo-commands.authority.mts');

    expect(project).toContain('const createTodo = actionRef("actions/todos", "createTodo");');
    expect(project).toContain('      $.h("form", { action: createTodo.bind(null, projectId) },');
    expect(project).toContain(
      '        $.h("input", { name: "title", "aria-label": "新しい Todo", required: true, maxLength: 200 }),',
    );
    expect(todo).toContain('const moveTodo = actionRef("actions/todos", "moveTodo");');
    expect(todo).toContain('      $.h("form", { action: deleteTodo.bind(null, projectId, id) },');
    expect(project).not.toContain('@/actions/todos');
  });

  it('writes a root entry for every component, which renders it through the authority', () => {
    expect(read('components/project.root.tsx')).toBe(
      [
        '// Generated by @arkorlab/reactive-state from components/project.reactive.tsx. Do not edit: change the component and compile it again.',
        "import { renderRoot } from '@arkorlab/reactive-state/next';",
        "import type { TodoFilter } from '@/navigation';",
        "import { elements } from '../elements';",
        "import { update, view } from '../server-functions';",
        '',
        'export default async function Project(props: {',
        '  projectId: string;',
        '  filter: TodoFilter;',
        '  selectedId?: string;',
        '}) {',
        '  return renderRoot({ component: "components/project", elements, props, route: "/projects/[projectId]", update, view });',
        '}',
        '',
      ].join('\n'),
    );
    // A page renders a root without the children the authority renders it with alone.
    expect(read('components/project-layout.root.tsx')).toContain(
      [
        'export default async function ProjectLayout(props: Omit<{',
        '  title: string;',
        '  children: ReactNode;',
        '}, "children">) {',
      ].join('\n'),
    );
  });

  it('writes the elements the host renders the authority’s tree with', () => {
    const elements = read('elements.ts');

    expect(elements).toContain("import type { Elements } from '@arkorlab/reactive-state/next';");
    expect(elements).toContain('  build: "b_BUILD",');
    // No component the authority renders renders a module's element: the rows' links are the browser's.
    expect(elements).toContain('  modules: {},');
    expect(elements).toContain(
      '"components/project-workspace": client$components$project_workspace,',
    );
    expect(elements).toContain(
      "import client$components$todo_editor from './components/todo-editor.client';",
    );
    expect(elements).toContain('"components/todo-editor": client$components$todo_editor,');
    expect(elements).toContain('"actions/todos#deleteTodo": action$actions$todos_deleteTodo,');
    expect(elements).not.toContain('todo-list.client');
  });

  it('writes the authority’s registry, the stubs, the Server Function and the route', () => {
    const registry = read('authority.mts');
    const route = compiled.outputs.get(
      path.join(app.appDir, 'api/reactive-state/[...path]/route.ts'),
    );

    expect(registry).toContain(
      "import * as program$components$project from './components/project.authority.mts';",
    );
    expect(registry).toContain(
      "import * as operations$actions$todos from '@/actions/todos';\nimport { db } from '@/db';",
    );
    expect(registry).toContain(
      'export const operations = { "actions/publication": operations$actions$publication, "actions/todos": operations$actions$todos };\nexport const database = db;',
    );
    expect(read('actions/todos.ts')).toContain(
      [
        "'use server';",
        '',
        "import { operate } from '@arkorlab/reactive-state/next';",
        "import type * as source from '@/actions/todos';",
        '',
        'export async function createTodo(...args: Parameters<typeof source.createTodo>): Promise<Awaited<ReturnType<typeof source.createTodo>>> {',
        '  return operate("actions/todos", "createTodo", args, "b_BUILD") as Promise<Awaited<ReturnType<typeof source.createTodo>>>;',
        '}',
      ].join('\n'),
    );
    expect(read('server-functions.ts')).toContain(
      'export async function update(input: unknown): Promise<Result<FieldReceipt>> {\n  return updateField(input);\n}',
    );
    expect(read('server-functions.ts')).toContain(
      [
        "import { updateField, viewRoot, type ViewAnswer } from '@arkorlab/reactive-state/next';",
        "import type { FieldReceipt, Result } from '@arkorlab/reactive-state/program';",
        "import { elements } from './elements';",
      ].join('\n'),
    );
    expect(read('server-functions.ts')).toContain(
      'export async function view(input: unknown): Promise<Result<ViewAnswer>> {\n  return viewRoot(input, elements);\n}',
    );
    expect(route).toContain(
      [
        "import { routeHandlers } from '@arkorlab/reactive-state/next/route';",
        '',
        "import { envelopes, routes } from '../../../../../.reactive/routes';",
        '',
        'export const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } = routeHandlers({ envelopes, routes });',
      ].join('\n'),
    );
  });

  it('says in its manifest what each component is, and what each module is to the compile', () => {
    const manifest = JSON.parse(read('manifest.json')) as Record<string, Record<string, unknown>>;

    expect(manifest['components']?.[EDITOR]).toMatchObject({
      client: true,
      nodes: [],
      sites: {},
      slots: ['s0'],
      states: ['title', 'completed', 'useEstimate#0.estimate'],
      writable: ['title', 'completed', 'useEstimate#0.estimate'],
    });
    expect(manifest['limitations']).toStrictEqual([
      'packages-outside-build-id',
      'hook-state-parameters-from-the-server',
      'reactive-children-in-slots-or-sites',
      'site-inputs-checked-by-json-kind',
    ]);
    expect(manifest['modules']).toMatchObject({
      '@/actions/todos': 'operations',
      '@/auth': 'server',
      '@/db': 'server',
      '@/domain/estimate': 'shared',
      '@/hooks/use-estimate': 'hooks',
      '@/navigation': 'shared',
      '@/permissions': 'server',
      '@/ui': 'client',
      'next/link': 'element',
    });
    expect(manifest['buildId']).toBe('b_BUILD');
  });

  it('names one build in every output, a hash of what it read and what it wrote', () => {
    const builds = new Set(
      [...compiled.outputs.values()].flatMap((text) =>
        [...text.matchAll(/b_[\da-f]{20}/gu)].map((match) => match[0]),
      ),
    );

    expect(compiled.buildId).toMatch(/^b_[\da-f]{20}$/u);
    expect(builds).toStrictEqual(new Set([compiled.buildId]));
  });

  // Allow CI scheduling headroom for two full compilations and filesystem setup.
  it('writes the same build again from the same sources, and another from another', async () => {
    const again = compiledApp(app, api);
    const other = await application({
      'domain/estimate.ts': variant(await source('domain/estimate.ts'), '1_000_000', '999_999'),
    });
    const otherBuild = compiledApp(other, api).buildId;
    await removed(other);

    expect(again.buildId).toBe(compiled.buildId);
    expect([...again.outputs]).toStrictEqual([...compiled.outputs]);
    expect(otherBuild).not.toBe(compiled.buildId);
  }, 15_000);

  it('writes another build where a module only a server operation reads changes', async () => {
    const other = await application({
      'input.ts': variant(await source('input.ts'), 'must be text', 'must be a text'),
    });
    const otherBuild = compiledApp(other, api).buildId;
    await removed(other);

    expect(otherBuild).not.toBe(compiled.buildId);
  });

  it('writes another build where a module only a Client Component reads changes', async () => {
    const ui = await source('ui.tsx');
    const reading = (label: string): Readonly<Record<string, string>> => {
      return {
        'format.ts': `export const LABEL = '${label}';\n`,
        'ui.tsx': variant(
          ui,
          "import { useRef, useState } from 'react';",
          "import { useRef, useState } from 'react';\nimport { LABEL } from '@/format';\n\nexport const labelled = LABEL;",
        ),
      };
    };
    const apps = [await application(reading('one')), await application(reading('two'))];
    const builds = apps.map((each) => compiledApp(each, api).buildId);
    for (const each of apps) {
      await removed(each);
    }

    expect(builds[0]).not.toBe(builds[1]);
  });

  it('writes another build where a module a Client Component loads as it runs changes', async () => {
    const ui = await source('ui.tsx');
    const loading = (label: string): Readonly<Record<string, string>> => {
      return {
        'format.ts': `export const LABEL = '${label}';\n`,
        'ui.tsx': `${ui}\nexport async function labelled(): Promise<string> {\n  return (await import('@/format')).LABEL;\n}\n`,
      };
    };
    const apps = [await application(loading('one')), await application(loading('two'))];
    const builds = apps.map((each) => compiledApp(each, api).buildId);
    for (const each of apps) {
      await removed(each);
    }

    expect(builds[0]).not.toBe(builds[1]);
  });

  it('writes another build where the database it is told of changes, though no component imports it', async () => {
    const declared = await source('db.ts');
    const apps = [
      await application({ 'schema.ts': declared }),
      await application({ 'schema.ts': variant(declared, "title: '開発'", "title: '設計'") }),
    ];
    const builds = apps.map((each) => {
      return compileApp({
        api,
        appDir: each.appDir,
        database: '@/schema#db',
        outDir: each.out,
        srcDir: each.src,
      }).buildId;
    });
    for (const each of apps) {
      await removed(each);
    }

    expect(builds[0]).not.toBe(builds[1]);
  });

  it('writes nothing TypeScript does not parse', () => {
    const diagnostics = [...compiled.outputs].flatMap(([file, text]) => {
      if (file.endsWith('.json')) {
        return [];
      }
      const parsed = api.transpileModule(text, { fileName: file, reportDiagnostics: true });
      return (parsed.diagnostics ?? []).map((diagnostic) => `${file}: ${diagnostic.text}`);
    });

    expect(diagnostics).toStrictEqual([]);
    expect(() => JSON.parse(read('manifest.json')) as unknown).not.toThrow();
  });

  it('writes what the application’s type check accepts, each program a `ComponentProgram`', async () => {
    writeOutputs(compiled.outputs, app.out);
    await writeFile(
      path.join(app.root, 'probe.mts'),
      [
        "import type { ComponentProgram } from '@arkorlab/reactive-state/program';",
        "import { programs } from './.reactive/authority.mts';",
        "import * as editor from './.reactive/components/todo-editor.authority.mts';",
        '',
        'export const all: readonly ComponentProgram[] = programs;',
        'export const one: ComponentProgram = editor;',
        '',
      ].join('\n'),
    );
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it('writes programs the Node authority loads, whose updates and JSX run as data', () => {
    writeOutputs(compiled.outputs, app.out);
    const loaded = inAuthority(
      app,
      `(() => {
        const program = (id) => registry.programs.find((each) => each.component === id);
        const editor = program('components/todo-editor');
        const scope = { client: (part) => part, counted: (value) => value, method: (receiver, key) => { const fn = receiver[key]; return (...args) => Reflect.apply(fn, receiver, args); }, fragment: 'fragment', h: (type, props, ...children) => ({ children, props, type }) };
        return {
          apply: editor.updaters[Object.keys(editor.updaters).find((id) => editor.updaters[id].kind === 'apply')].apply(5, { step: 3 }),
          build: registry.buildId,
          components: registry.programs.map((each) => each.component),
          list: program('components/todo-list').evaluate({ filter: 'all', ids: ['t1', 't2'], projectId: 'p1' }, scope),
          operations: Object.keys(registry.operations),
          writable: editor.writable,
        };
      })()`,
    );

    expect(loaded).toStrictEqual({
      apply: 8,
      build: compiled.buildId,
      components: [
        'components/member-editor',
        'components/project',
        'components/project-access',
        'components/project-commands',
        'components/project-content',
        'components/project-layout',
        'components/project-summary',
        'components/project-workspace',
        'components/public-board',
        'components/public-board-layout',
        'components/public-board-stats',
        'components/public-board-todos',
        'components/publication-settings',
        'components/todo-commands',
        'components/todo-details',
        'components/todo-editor',
        'components/todo-list',
        'components/todo-readonly',
        'components/todo-results',
        'components/todo-row',
      ],
      list: {
        children: [
          ['t1', 't2'].map((id) => {
            return {
              children: [],
              props: { filter: 'all', id, key: id, projectId: 'p1' },
              type: { component: 'components/todo-row', kind: 'component' },
            };
          }),
        ],
        props: null,
        type: 'ul',
      },
      operations: ['actions/publication', 'actions/todos'],
      writable: ['title', 'completed', 'useEstimate#0.estimate'],
    });
  });
});

describe('the compiler, of the workspace of the application’s second version (`variants/v2`)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;
  /** What the compile wrote at `file`, its build id written `b_BUILD`. */
  const read = (file: string): string =>
    output(compiled, app, file).replaceAll(compiled.buildId, 'b_BUILD');

  beforeAll(async () => {
    api = openTypeScript();
    const file = `${WORKSPACE}.reactive.tsx`;
    app = await application({ [file]: await variantSource('v2', file) });
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('writes ProjectWorkspace’s program: the states its sites read, its children a slot, its sites', () => {
    const program = read(`${WORKSPACE}.authority.mts`);

    // Each state starts from a prop or a literal: a local state, whose setter is React's, which the
    // compile registers nothing of.
    expect(compiled.refusals).toStrictEqual([]);
    expect(program)
      .toBe(`// Generated by @arkorlab/reactive-state from components/project-workspace.reactive.tsx. Do not edit: change the component and compile it again.
import { componentRef, type RenderScope, type StatesOf } from '@arkorlab/reactive-state/program';
import type { ReactNode } from 'react';
import { requireUser } from '@/auth';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';

export const protocolVersion = ${String(PROTOCOL_VERSION)};
export const buildId = "b_BUILD";
export const component = "components/project-workspace";
const TodoResults = componentRef("components/todo-results");
const TodoDetails = componentRef("components/todo-details");

export async function evaluate({ projectId, initialFilter, initialSelectedId, choices, children }: {
  projectId: string;
  initialFilter: TodoFilter;
  initialSelectedId: string;
  choices: readonly { readonly id: string; readonly title: string }[];
  children: ReactNode;
}, $: RenderScope) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  return $.client({
    props: { choices },
    states: { filter: initialFilter, selectedId: initialSelectedId, showDetails: true },
    slots: { s0: children },
    sites: {
      d0: { inputs: ["filter"], render: ({ filter }) => $.h(TodoResults, { projectId: projectId, filter: filter }) },
      d1: { inputs: ["selectedId", "showDetails"], guard: ({ showDetails, selectedId }) => showDetails && selectedId !== '', render: ({ selectedId }) => $.h(TodoDetails, { key: $.counted(\`\${projectId}:\${selectedId}\`), projectId: projectId, id: selectedId }) },
    },
  });
}

export type States = StatesOf<typeof evaluate>;
export const writable = Object.freeze([]);
export const updaters = Object.freeze({});
`);
  });

  it('writes ProjectWorkspace’s Client Component: its sites where it renders them, its memo its own', () => {
    const client = read(`${WORKSPACE}.client.tsx`);
    const lines = [
      "import { type ClientPartProps, localOf, slotOf, useReactiveState, useSites } from '@arkorlab/reactive-state/react';",
      "import { Suspense } from 'react';\nimport Disclosure from '@/controls/disclosure';",
      '  const { choices } = part.props as { readonly choices: readonly { readonly id: string; readonly title: string }[] };',
      '  const [filter, setFilter] = useReactiveState(localOf<States["filter"]>(part, "filter"));',
      '  const [showDetails, setShowDetails] = useReactiveState(localOf<States["showDetails"]>(part, "showDetails"));',
      "  const [memo, setMemo] = useReactiveState('');",
      '  const sites = useSites(part);',
      '      <Disclosure title="プロジェクト全体の確定集計">\n        {slotOf(part, "s0")}\n      </Disclosure>',
      '        onClick={() => setShowDetails(open => !open)}',
      [
        '        {sites.of("d0", { filter })}',
        '        <section aria-label="選択した Todo の詳細">',
        "          {showDetails && selectedId !== '' ? (",
        '            sites.of("d1", { selectedId }, { showDetails })',
        '          ) : (',
      ].join('\n'),
    ];

    for (const line of lines) {
      expect(client).toContain(line);
    }

    expect(client).not.toContain('TodoResults');
    expect(client).not.toContain('children');
  });
});

/** The specification's two other writings of the workspace, and what each site is sent. */
const WRITINGS: readonly (readonly [string, readonly [string, string]])[] = [
  ['inline', ['filter', 'panels']],
  ['aliases', ['useTodoFilter#0.filter', 'useTodoPanels#0.panels']],
];

describe('the compiler, of the workspace the specification writes two other ways', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(WRITINGS)(
    'compiles `variants/%s` as it is written: the list of the filter, a list site of the panels',
    async (name, [filter, panels]) => {
      const file = `${WORKSPACE}.reactive.tsx`;
      const app = await application({ [file]: await variantSource(name, file) });
      onTestFinished(async () => {
        await removed(app);
      });
      const compiled = compiledApp(app, api);
      writeOutputs(compiled.outputs, app.out);
      const checked = typeCheck(app);
      const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
        readonly components: Readonly<Record<string, { readonly sites: unknown }>>;
      };

      expect(compiled.refusals).toStrictEqual([]);
      expect(manifest.components[WORKSPACE]?.sites).toStrictEqual({
        d0: { guard: [], inputs: [filter] },
        d1: { guard: [], inputs: [panels], list: true },
      });
      expect(checked.stdout + checked.stderr).toBe('');
      // A check that was killed prints nothing either: it must have ended, and found nothing.
      expect(checked.status).toBe(0);
    },
  );
});

describe('the TodoEditor’s hook inlined (T17), and its update given by name (T18)', () => {
  const { apps, compile } = compilerApplications();

  /** The TodoEditor with its `useEstimate` call written another way, or as it is. */
  async function editorWith(estimate?: string): Promise<Application> {
    if (estimate === undefined) {
      const app = await application();
      apps.push(app);
      return app;
    }
    const imported = variant(
      await source('components/todo-editor.reactive.tsx'),
      "import { useEstimate } from '@/hooks/use-estimate';",
      "import { addEstimate } from '@/domain/estimate';",
    );
    const editor = variant(
      imported,
      '  const [estimate, increase] = useEstimate(ref.estimate, step);',
      estimate,
    );
    const app = await application({ 'components/todo-editor.reactive.tsx': editor });
    apps.push(app);
    return app;
  }

  /** What a compile of `app` registers and writes for its TodoEditor's estimate. */
  function compiledEditor(app: Application): {
    readonly app: Application;
    readonly client: string;
    readonly id: string;
    readonly program: string;
  } {
    const compiled = compile(app);
    if (compiled.refusals.length > 0) {
      throw new Error(compiled.refusals.map((refusal) => refusal.message).join('\n'));
    }
    writeOutputs(compiled.outputs, app.out);
    const program = output(compiled, app, 'components/todo-editor.authority.mts');
    const client = output(compiled, app, 'components/todo-editor.client.tsx');
    return { app, client, id: applyIdIn(program), program };
  }

  it('registers one update, of one meaning and one capture, however it is written', async () => {
    const hook = compiledEditor(await editorWith());
    const inline = compiledEditor(
      await editorWith(
        '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const increase = () => setEstimate(current => addEstimate(current, step));',
      ),
    );
    const named = compiledEditor(
      await editorWith(
        '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const adjust = (current: number) => addEstimate(current, step);\n  const increase = () => setEstimate(adjust);',
      ),
    );
    // And the authority runs each alike, the step its call captured, clamped as `addEstimate` says.
    const runs = [hook, inline, named].map(({ app, id }) => {
      const updater = `registry.programs.find((each) => each.component === 'components/todo-editor').updaters[${JSON.stringify(id)}]`;
      return inAuthority(
        app,
        `[${updater}.apply(5, { step: 3 }), ${updater}.apply(999_999, { step: 5 }), ${updater}.apply(2, { step: -5 })]`,
      );
    });

    // Written inline or given by name, the component's update is one: one id, one registration.
    expect(named.id).toBe(inline.id);
    expect(entryOf(named.program, named.id)).toBe(entryOf(inline.program, inline.id));
    expect(entryOf(inline.program, inline.id)).toBe(
      `  "${inline.id}": { keys: ["estimate"], kind: "apply", apply: (current: States["estimate"], { step }: { step: number }): States["estimate"] => addEstimate(current, step) },`,
    );
    // The hook's is its own — one id for every caller — of the same body and the same capture.
    expect(entryOf(hook.program, hook.id)).toBe(
      `  "${hook.id}": { keys: ["useEstimate#0.estimate"], kind: "apply", apply: (current: number, { step }: { step: number }): number => addEstimate(current, step) },`,
    );
    expect(inline.client).toContain(
      `  const increase = () => setEstimate.compiled("${inline.id}", { step }, current => addEstimate(current, step));`,
    );
    expect(named.client).toContain(
      `  const increase = () => setEstimate.compiled("${named.id}", { step }, adjust);`,
    );
    expect(
      [hook, inline, named].map(({ program }) =>
        program.split('\n').find((line) => line.startsWith('export const writable')),
      ),
    ).toStrictEqual([
      'export const writable = Object.freeze(["title", "completed", "useEstimate#0.estimate"]);',
      'export const writable = Object.freeze(["title", "completed", "estimate"]);',
      'export const writable = Object.freeze(["title", "completed", "estimate"]);',
    ]);
    expect(runs).toStrictEqual([
      [8, 1_000_000, 0],
      [8, 1_000_000, 0],
      [8, 1_000_000, 0],
    ]);
  });
});

describe('its command line', () => {
  const apps: Application[] = [];

  afterAll(async () => {
    for (const app of apps) {
      await removed(app);
    }
  });

  it.each([
    [['src'], 'usage:'],
    [['src', '--out', 'out'], 'usage:'],
    [['--out', 'out', '--app', 'app'], 'usage:'],
    [['src', '--out', 'out', '--app', 'app', '--nope'], "Unknown option '--nope'"],
  ])('refuses %j as no run it can make', (args, said) => {
    const ran = cli(...args);

    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(said);
  });

  it(
    'writes the build, says it is current, then which of it is stale and what is left over',
    async () => {
      const app = await application();
      apps.push(app);
      const run = (...more: readonly string[]): ReturnType<typeof cli> =>
        cli(app.src, '--out', app.out, '--app', app.appDir, ...more);
      const wrote = run();
      const current = run('--check');
      const editor = path.join(app.src, 'components/todo-editor.reactive.tsx');
      await writeFile(
        editor,
        variant(await readFile(editor, 'utf8'), '<p>{status}</p>', '<p>{status}!</p>'),
      );
      const leftover = path.join(app.out, 'components/gone.client.tsx');
      await writeFile(
        leftover,
        '// Generated by @arkorlab/reactive-state from components/gone.reactive.tsx.\n',
      );
      const stale = run('--check');
      const again = run();

      expect([wrote.status, current.status, stale.status, again.status]).toStrictEqual([
        0, 0, 1, 0,
      ]);
      expect(wrote.stderr).toContain('wrote ');
      expect(namedIn(stale.stderr, 'stale: ')).toStrictEqual(
        expect.arrayContaining(['gone.client.tsx', 'todo-editor.client.tsx']),
      );
      expect(stale.stderr).toContain('compile the components again');
      expect(namedIn(again.stderr, 'removed ')).toStrictEqual(['gone.client.tsx']);
      expect(existsSync(leftover)).toBe(false);
      expect(run('--check').status).toBe(0);
    },
    CLI_TIMEOUT_MS,
  );

  it('reports every refusal, and writes nothing', async () => {
    const editor = await source('components/todo-editor.reactive.tsx');
    const row = await source('components/todo-row.reactive.tsx');
    const app = await application({
      'components/todo-editor.reactive.tsx': variant(editor, '<p>{status}</p>', '<p>{user.id}</p>'),
      'components/todo-row.reactive.tsx': variant(
        row,
        "import Link from 'next/link';",
        "import Link from './link';",
      ),
    });
    apps.push(app);
    const ran = cli(app.src, '--out', app.out, '--app', app.appDir, '--database', '@/db#db');

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('components/todo-editor.reactive.tsx:');
    expect(ran.stderr).toContain('`user` is computed in the server part');
    expect(ran.stderr).toContain('components/todo-row.reactive.tsx:');
    expect(ran.stderr).toContain('`./link` is a relative path');
    expect(existsSync(app.out)).toBe(false);
  });

  it('refuses a database it cannot name', async () => {
    const app = await application();
    apps.push(app);
    const ran = cli(app.src, '--out', app.out, '--app', app.appDir, '--database', '@/db');

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('names no database');
  });
});
