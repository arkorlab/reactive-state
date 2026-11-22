import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { application, positionOf, refusalOf, source, variant } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What the compiler refuses — whatever it cannot carry over whole — each where it stands, said in
 * words that say why: an update that reads what the authority and the browser do not both run, a
 * reactive child the authority cannot render again of the states it reads, a node the browser
 * would hold, a server value the browser would read, a write made as a page renders, and the second
 * protocol's rules it keeps.
 */

const EDITOR = 'components/todo-editor.reactive.tsx';
const LAYOUT = 'components/project-layout.reactive.tsx';
const CONTENT = 'components/project-content.reactive.tsx';
const HOOK = 'hooks/use-estimate.ts';
const PANEL = 'components/panel.reactive.tsx';

/** One change to one source of the application, and what a compile of it refuses, where. */
interface Refused {
  readonly what: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** Where in the changed source the refusal stands. */
  readonly marker: string;
  readonly reason: string;
  /** Other files of the application, by their path in `src`. */
  readonly beside?: Readonly<Record<string, string>>;
  /** A second change to the source: what it replaces, and with what. */
  readonly also?: readonly [string, string];
  /** The source changed, where the fixture holds none of the file. */
  readonly original?: string;
}

/** A component of a number a site reads, which a change starts of what is not finite. */
const RATIO_SOURCE = [
  "import { useReactiveState } from 'framework/react';",
  "import TodoCommands from '@/components/todo-commands.reactive';",
  '',
  'export default function Ratio({ projectId }: { projectId: string }) {',
  '  const [ratio, setRatio] = useReactiveState(0);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setRatio(1)}>1</button>',
  '      <TodoCommands projectId={projectId} id={String(ratio)} />',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/** A module of the application's that types a selection of two kinds of JSON. */
const SELECTION_SOURCE = 'export type Selection = string | { id: string };\n';

/** A component of a state started from a prop, which a site reads. */
const KINDS_SOURCE = [
  "import { useReactiveState } from 'framework/react';",
  "import TodoCommands from '@/components/todo-commands.reactive';",
  '',
  'export default function Kinds({ projectId, first }: { projectId: string; first: string }) {',
  '  const [selected, setSelected] = useReactiveState(first);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setSelected(\'t2\')}>t2</button>',
  "      <TodoCommands projectId={projectId} id={typeof selected === 'string' ? selected : ''} />",
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/**
 * A shared module whose `frames` reads the stack of what `read` selects of `values`, a tuple of
 * the type `tuple` that holds an Error after a text, below the declarations `prelude` writes.
 */
function tupleRestFrames(prelude: string, tuple: string, read: string): string {
  return [
    "import type {TodoFilter} from '@/navigation';",
    `${prelude}function frames(values:${tuple},i:number){return ${read}.stack;}`,
    "export function normalizeFilter(value:string):TodoFilter{return String(frames(['x',new Error(value)] as never,1)).length>40?'all':value==='active'||value==='done'?value:'all';}",
  ].join('\n');
}

/** A component of state given children, which the fixture has none of. */
const PANEL_SOURCE = [
  "import type { ReactNode } from 'react';",
  "import { useReactiveState } from 'framework/react';",
  "import TodoCommands from '@/components/todo-commands.reactive';",
  '',
  'export default function Panel({ projectId, children }: { projectId: string; children: ReactNode }) {',
  '  const [open, setOpen] = useReactiveState(true);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setOpen(value => !value)}>toggle</button>',
  '      {children}',
  '      <TodoCommands projectId={projectId} id="t1" />',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/** A card whose parameter names the type of its props, which the compile does not read. */
const CARD: Readonly<Record<string, string>> = {
  'card-props.ts':
    "import type { ReactNode } from 'react';\n\nexport type CardProps = { header: ReactNode };\n",
  'components/card.reactive.tsx':
    "import type { CardProps } from '@/card-props';\n\nexport default function Card({ header }: CardProps) {\n  return <section>{header}</section>;\n}\n",
};

/** A wrapper the fixture has none of, which hands the card a title, and a change hands it nodes. */
const WRAPPER = 'components/wrapper.reactive.tsx';
const WRAPPER_SOURCE = [
  "import type { ReactNode } from 'react';",
  "import Card from '@/components/card.reactive';",
  '',
  'export default function Wrapper({ title, children }: { title: string; children: ReactNode }) {',
  '  const heading = <h3>{title}</h3>;',
  '  return (',
  '    <section>',
  '      <Card header={title} />',
  '      {heading}',
  '      {children}',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/** A hook of a local state of its parameter, typed as the value itself. */
const USE_FILTER = [
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  '',
  'export function useFilter(initialFilter: TodoFilter) {',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  '  return { filter, setFilter };',
  '}',
  '',
].join('\n');

/** A component that starts `useFilter`'s state from a prop, which a change gives a field instead. */
const SHEET = 'components/sheet.reactive.tsx';
const SHEET_SOURCE = [
  "import { db } from '@/db';",
  "import type { TodoFilter } from '@/navigation';",
  "import { useFilter } from '@/hooks/use-filter';",
  '',
  'export default function Sheet({ id, initialFilter }: { id: string; initialFilter: TodoFilter }) {',
  '  const ref = db.todos.ref(id);',
  '  const { filter } = useFilter(initialFilter);',
  '  return <p>{filter}</p>;',
  '}',
  '',
].join('\n');

/** A hook that gives its parameter on to a hook of a local state, typed as a change types it. */
const OUTER = 'hooks/use-outer.ts';
const OUTER_SOURCE = [
  "import { useReactiveState } from 'framework/react';",
  "import type { FieldRef } from '@arkorlab/reactive-state/program';",
  "import { useInner } from '@/hooks/use-inner';",
  '',
  'export function useOuter(title: string) {',
  '  const { value } = useInner(title);',
  '  return { value };',
  '}',
  '',
].join('\n');

/** A hook of a filter the page holds, and the filter it lists by, computed of it. */
const LISTED_HOOK = 'hooks/use-listed.ts';
const LISTED_HOOK_SOURCE = [
  "import { useReactiveState } from 'framework/react';",
  "import type { TodoFilter } from '@/navigation';",
  "import { projectHref } from '@/navigation';",
  '',
  'export function useListed(initialFilter: TodoFilter) {',
  '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
  "  const listed = filter === 'done' ? 'done' : 'all';",
  '  return { filter, setFilter, listed };',
  '}',
  '',
].join('\n');

/** A component that lists by what the hook computes, which changes make it compute otherwise. */
const LISTING = 'components/listing.reactive.tsx';
const LISTING_SOURCE = [
  "import type { TodoFilter } from '@/navigation';",
  "import TodoResults from '@/components/todo-results.reactive';",
  "import { useListed } from '@/hooks/use-listed';",
  '',
  'export default function Listing({ projectId, initialFilter }: { projectId: string; initialFilter: TodoFilter }) {',
  '  const { filter, setFilter, listed } = useListed(initialFilter);',
  '  const shown = listed;',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
  '      <TodoResults projectId={projectId} filter={shown} />',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/** A component that shows the detail of each panel open: a list site, which changes make otherwise. */
const PANELS_LIST = 'components/panels-list.reactive.tsx';
const PANELS_LIST_SOURCE = [
  "import { PanelCard } from '@/controls/todo-panels';",
  "import TodoDetails from '@/components/todo-details.reactive';",
  "import { initialPanelsFor } from '@/domain/todo-panels';",
  "import { useTodoPanels } from '@/hooks/use-todo-panels';",
  '',
  'export default function PanelsList({ projectId, initialSelectedId }: { projectId: string; initialSelectedId: string }) {',
  '  const initialPanels = initialPanelsFor(initialSelectedId);',
  '  const { panels, closeAll } = useTodoPanels(initialPanels);',
  '  return (',
  '    <section>',
  '      <button type="button" onClick={closeAll}>close</button>',
  '      {panels.map((panel) => (',
  '        <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
  '          <TodoDetails projectId={projectId} id={panel.todoId} />',
  '        </PanelCard>',
  '      ))}',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

/** The list's callback, which a change writes another way. */
const PANEL_MAP = '      {panels.map((panel) => (';
/** The list's keyed card, which a change keys another way. */
const PANEL_CARD =
  '        <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>';
/** The list's item element, which a change renders of something else. */
const PANEL_DETAIL = '          <TodoDetails projectId={projectId} id={panel.todoId} />';

/** A list refused for `what`: the panels' list, `from` changed `to`, refused at `marker` for `reason`. */
function panelsRefused(
  what: string,
  change: { readonly from: string; readonly to: string; readonly marker: string },
  reason: string,
): Refused {
  return {
    ...change,
    file: PANELS_LIST,
    original: PANELS_LIST_SOURCE,
    reason,
    what,
  };
}

/** The TodoEditor's reactive child, which a change renders another way. */
const COMMANDS = '      <TodoCommands projectId={projectId} id={id} />';
/** The TodoEditor's states between its reference and its memo. */
const STATES = [
  '  const [title, setTitle] = useReactiveState(ref.title);',
  '  const [completed, setCompleted] = useReactiveState(ref.completed);',
  '  const [step, setStep] = useReactiveState(1);',
  '  const [expanded, setExpanded] = useReactiveState(false);',
].join('\n');
/** The TodoEditor's state of its own memo, which a change starts another way. */
const DRAFT = "  const [draft, setDraft] = useReactiveState('');";
/** The TodoEditor's reactive child, rendered of its memo. */
const OF_DRAFT = [COMMANDS, '      <TodoCommands projectId={projectId} id={draft} />'] as const;

/** The TodoEditor's call of `useEstimate`, which a change writes inline. */
const INLINE = '  const [estimate, increase] = useEstimate(ref.estimate, step);';
const HOOK_IMPORT = "import { useEstimate } from '@/hooks/use-estimate';";
const ADD_ESTIMATE = [HOOK_IMPORT, "import { addEstimate } from '@/domain/estimate';"] as const;

const REFUSED: readonly Refused[] = [
  {
    what: 'parallel slot default guarded root',
    file: 'app/boards/@panel/default.tsx',
    original: 'SLOT_DEFAULT_SOURCE',
    from: 'SLOT_DEFAULT_SOURCE',
    to: 'import SlotStatus from \'@/components/slot-status.reactive\';export default function Default(){return <SlotStatus projectId="p1"/>;}\n',
    marker: 'import SlotStatus',
    reason:
      "`components/slot-status` is rendered by `boards/@panel/default.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of \u{2014} one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants \u{2014} so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path \u{2014} under no `&&`, in both branches of a `?:`, past no early `return` \u{2014} in the page or in a function of the page's file it renders.",
    beside: {
      'app/boards/[projectId]/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/page.tsx': 'export default function Page(){return <p>plain</p>;}\n',
      'app/boards/layout.tsx':
        "import type {ReactNode} from 'react';export default function Layout({children,panel}:{children:ReactNode;panel:ReactNode}){return <section>{children}{panel}</section>;}\n",
      'components/slot-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';export default function SlotStatus({projectId}:{projectId:string}){const [value,setValue]=useReactiveState<string>(projectId);return <section><button onClick={()=>setValue('next')}>{value}</button></section>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    what: 'value reexport main reported-default-page-reexport',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'VALUE_REEXPORT_PAGE',
    to: "export {default} from '@/controls/board-page';",
    original: 'VALUE_REEXPORT_PAGE',
    marker: 'export',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of \u{2014} one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants \u{2014} so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path \u{2014} under no `&&`, in both branches of a `?:`, past no early `return` \u{2014} in the page or in a function of the page's file it renders.",
    beside: {
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    what: 'value reexport main named-default-page-reexport',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'VALUE_REEXPORT_PAGE',
    to: "export {BoardPage as default} from '@/controls/board-page';",
    original: 'VALUE_REEXPORT_PAGE',
    marker: 'export',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of \u{2014} one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants \u{2014} so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path \u{2014} under no `&&`, in both branches of a `?:`, past no early `return` \u{2014} in the page or in a function of the page's file it renders.",
    beside: {
      'controls/board-page.tsx':
        "import Board from '@/components/public-board.reactive';export async function BoardPage({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },

  {
    what: 'commonjs wrapper main reported-imported-commonjs-wrapper',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'COMMONJS_WRAPPER_PAGE',
    to: "import Wrapper from '@/controls/wrapper';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
    original: 'COMMONJS_WRAPPER_PAGE',
    marker: 'import',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of — one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants — so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path — under no `&&`, in both branches of a `?:`, past no early `return` — in the page or in a function of the page's file it renders.",
    beside: {
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },
  {
    what: 'commonjs wrapper main named-barrel-commonjs-wrapper',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'COMMONJS_WRAPPER_PAGE',
    to: "import{Wrapper}from'@/controls/wrapper-export';\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Wrapper projectId={projectId}/>;}\n",
    original: 'COMMONJS_WRAPPER_PAGE',
    marker: 'import',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of — one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants — so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path — under no `&&`, in both branches of a `?:`, past no early `return` — in the page or in a function of the page's file it renders.",
    beside: {
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
      'controls/wrapper-export.ts': "export{default as Wrapper}from'./wrapper';",
      'controls/wrapper.tsx':
        "const{default:Board}=require('@/components/public-board.reactive');export default function Wrapper({projectId}:{projectId:string}){return <Board projectId={projectId}/>;}\n",
    },
  },

  {
    what: 'commonjs root main reported-require-default-root',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'COMMONJS_ROOT_PAGE',
    to: "const {default:Board}=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <Board projectId={projectId}/>;}\n",
    original: 'COMMONJS_ROOT_PAGE',
    marker: 'require(',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of \u{2014} one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants \u{2014} so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path \u{2014} under no `&&`, in both branches of a `?:`, past no early `return` \u{2014} in the page or in a function of the page's file it renders.",
    beside: {
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    what: 'commonjs root main require-namespace-root',
    file: 'app/boards/[projectId]/page.tsx',
    from: 'COMMONJS_ROOT_PAGE',
    to: "const board=require('@/components/public-board.reactive');\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const{projectId}=await params;return <board.default projectId={projectId}/>;}\n",
    original: 'COMMONJS_ROOT_PAGE',
    marker: 'require(',
    reason:
      "`components/public-board` is rendered by `boards/[projectId]/page.tsx` under the guard of `app/boards/middleware.ts`, but the page is written in no shape the compile registers a route of \u{2014} one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants \u{2014} so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path \u{2014} under no `&&`, in both branches of a `?:`, past no early `return` \u{2014} in the page or in a function of the page's file it renders.",
    beside: {
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';\nexport default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },

  {
    what: 'native entry iterator shared reported-entries-payload',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_ITERATOR_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision.entries().next().value![1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_ITERATOR_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },
  {
    what: 'native entry iterator shared advanced-entry-cursor',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_ITERATOR_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];const iterator=decision.entries();\nawait requirePublishedProject(params.projectId);\niterator.next();iterator.next().value![1].allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_ITERATOR_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native copied shared reported-native-concat',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_COPIED_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.concat()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_COPIED_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native copied shared map-retained-original-payload',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_COPIED_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nconst fresh={allowed:false};\nawait requirePublishedProject(params.projectId);\ndecision.map(item=>item)[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_COPIED_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native toSpliced shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_SPLICED_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toSpliced()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_SPLICED_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'literal container shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'LITERAL_CONTAINER_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};\nawait requirePublishedProject(params.projectId);\nbox.decision.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'LITERAL_CONTAINER_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'literal container replacement shared mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'LITERAL_CONTAINER_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision={allowed:false};\nconst box={decision};const fresh={allowed:false};box.decision=fresh;const selected=box.decision;\nawait requirePublishedProject(params.projectId);\nselected.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(fresh.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'LITERAL_CONTAINER_MIDDLEWARE',
    marker: 'const fresh',
    reason: 'A collection (`fresh`) read by both the guard and the host is mutated',
  },

  {
    what: 'native reordering shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_REORDERING_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.toReversed()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_REORDERING_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native sorted default conversion mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_REORDERING_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false,toString(){this.allowed=true;return \"a\";}},{allowed:false,toString(){this.allowed=true;return \"b\";}}];\n\nawait requirePublishedProject(params.projectId);\nvoid decision.toSorted();\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_REORDERING_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native slice shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_SLICE_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.slice()[0]!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_SLICE_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native utility boolean exclude frames',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Exclude<boolean,true|false>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'native utility boolean extract frames',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Extract<boolean,true>;type Failure=Selected extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'native search shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_SEARCH_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.find(()=>true)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_SEARCH_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'native utility unknown extract frames',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Extract<unknown|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'native utility unknown any frames',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\ntype Selected=Extract<unknown|any|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'nullish proxy saved result keeps frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){const proxy=new Proxy({x:error},{get:undefined} as never);return proxy.x.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'nullish proxy forwards frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return new Proxy({x:error},{get:undefined} as never).x.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'absent finally keeps frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nasync function frames(){return(await Promise.resolve(new Error('ours')).finally()).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames()).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'generic Error fields retain supplied words',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return Error.prototype.toString.call({name:'ours',message:error});}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'reducer const result retains frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return [0].reduce((acc)=>{const result=acc;return result;},error).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'typepair empty frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Failure=({kind:'a'}&{kind:'b'}) extends {missing:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'typepair awaited frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Failure=Awaited<{then:number;error:Error}>;function frames(value:Failure){return value.error.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames({then:1,error:new Error('ours')})).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'callable metadata keeps frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Failure={():string} extends {length:number}?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'noninfer union keeps frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype V=number|number;type A={a:V;b:V;c:V;d:V};type Failure=A extends A?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'unknown conditional retains the Error branch',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'type Select<T>=T extends string?{stack:string}:Error;type Failure=Select<unknown|string>;function frames(value:Failure){return value.stack??"";}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'numeric Omit key identity retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'type Failure=Omit<{0:Error},"0">;function frames(value:Failure){return value[0].stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames({0:new Error(value)})).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'filter defaults retain compacted frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return [,error].filter((value:Error|undefined=undefined)=>true)[0]!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'filter defaults retain skipped call frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return [,error].filter((value:Error|undefined=(()=>undefined)())=>true)[0]!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'named native callback shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NAMED_CALLBACK_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nfunction mutate(item:{allowed:boolean}){item.allowed=true;}\nawait requirePublishedProject(params.projectId);\ndecision.forEach(mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NAMED_CALLBACK_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'Object ignored tail retains uncertain Error',
    beside: {
      'domain/todo-filter.ts':
        "import type {TodoFilter} from '@/navigation';\nfunction frames(error:Error){return (Object as (value:Error,...tail:unknown[])=>Error)(error,Object.assign(error,{stack:'fixed'})).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'closed tuple at retains Error',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){const values=[error,{stack:\"fixed\"}];return values.at(...([-2] as const))!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'constructor comparison retains Error value',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'class Failure extends Error{constructor(error:Error){super((error!==undefined?error:"missing")as never);}}function frames(error:Error){return new Failure(error).message;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'typed native Error initializer frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function words(){const {stack}:Error=new Error("ours");return stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(words()).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'typed Error parameter default retains input',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function take({message}:Error=new Error("ours")){return message;}function words(error:Error){return take(error);}',
        "export function normalizeFilter(value:string):TodoFilter{return words(new Error(value)).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'omitted Map set preserves unknown keys',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\nfunction frames(error:Error,key:string){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)(key);return map.get("key")?.stack??"fixed";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"),"other")).length>40?\'all\':value===\'active\'||value===\'done\'?value:\'all\';}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'sparse Array.from retained mapper error',
    beside: {
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        'function frames(error:Error){return Array.from([,],()=>error)[0]!.stack;}',
        'export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'native at shared collection mutation',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_AT_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\n\nawait requirePublishedProject(params.projectId);\ndecision.at(0)!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_AT_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },

  {
    what: 'authorization boundary forbidden root',
    file: 'app/boards/[projectId]/forbidden.tsx',
    original: 'export default function Boundary(){return null;}\n',
    from: 'export default function Boundary(){return null;}\n',
    to: 'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
    marker: 'import BoundaryStatus',
    reason: 'the guard would be left out where the root renders',
    beside: {
      '../next.config.mjs': 'export default {experimental:{authInterrupts:true}};\n',
      'components/boundary-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';\nexport default function BoundaryStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n",
      'app/boards/[projectId]/page.tsx':
        "import {forbidden} from 'next/navigation';export default function Page(){forbidden();}\n",
      'app/boards/[projectId]/forbidden.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },
  {
    what: 'authorization boundary unauthorized root',
    file: 'app/boards/[projectId]/unauthorized.tsx',
    original: 'export default function Boundary(){return null;}\n',
    from: 'export default function Boundary(){return null;}\n',
    to: 'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
    marker: 'import BoundaryStatus',
    reason: 'the guard would be left out where the root renders',
    beside: {
      '../next.config.mjs': 'export default {experimental:{authInterrupts:true}};\n',
      'components/boundary-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';\nexport default function BoundaryStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n",
      'app/boards/[projectId]/page.tsx':
        "import {unauthorized} from 'next/navigation';export default function Page(){unauthorized();}\n",
      'app/boards/[projectId]/unauthorized.tsx':
        'import BoundaryStatus from \'@/components/boundary-status.reactive\';export default function Boundary(){return <BoundaryStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },

  {
    what: 'guarded not-found boundary root',
    file: 'app/boards/[projectId]/not-found.tsx',
    original: 'export default function NotFound(){return null;}\n',
    from: 'export default function NotFound(){return null;}\n',
    to: 'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
    marker: 'import NotFoundStatus',
    reason: 'the guard would be left out where the root renders',
    beside: {
      'components/not-found-status.reactive.tsx':
        "import {useReactiveState} from 'framework/react';\nexport default function NotFoundStatus({projectId}:{projectId:string}){\n const [value,setValue]=useReactiveState<string>(projectId);\n return <section><button onClick={()=>setValue('next')}>{value}</button></section>;\n}\n",
      'app/boards/[projectId]/page.tsx':
        "import {notFound} from 'next/navigation';export default function Page(){notFound();}\n",
      'app/boards/[projectId]/not-found.tsx':
        'import NotFoundStatus from \'@/components/not-found-status.reactive\';export default function NotFound(){return <NotFoundStatus projectId="p1"/>;}\n',
      'app/boards/middleware.ts':
        "import {requireUser,type RouteMiddleware} from '@arkorlab/reactive-state/server';export default(async(_context,next)=>{await requireUser();return await next();})satisfies RouteMiddleware;\n",
    },
  },

  {
    what: 'native array text argument',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        "function frames(error:Error){return 'x'.concat([error] as never);}",
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'native Map NaN selects Error frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return new Map([[NaN,error]]).get(NaN)!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'native with preserves an unreplaced Error slot',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return ([error,error].with as (index:number,value?:Error)=>Array<Error|undefined>)(1)[0]?.stack ?? \"fixed\";}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'interface any index retains Error',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'interface Bag{x:string}type Failure=Bag extends {[key:string]:any}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },

  {
    what: 'Nested any property union retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = {value:any|string} extends {value:number} ? Error:{stack:string}; function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype A0=number;type A1={x:A0,y:A0};type A2={x:A1,y:A1};type A3={x:A2,y:A2};type A4={x:A3,y:A3};type Failure=A4 extends A4?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'repeated resolved structural Error comparison',
  },

  {
    what: 'clone actual Error retains frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return structuredClone(error).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'named replacer across split middleware',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NAMED_REPLACER_MIDDLEWARE',
    to: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{\nconst decision={allowed:false};\nfunction mutate(_key:string,value:unknown){if(typeof value===\"object\"&&value!==null)(value as {allowed:boolean}).allowed=true;return value;}\nawait requirePublishedProject(params.projectId);\nJSON.stringify(decision,mutate);\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NAMED_REPLACER_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },
  {
    what: 'InstanceType own unknown keys retain frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure=InstanceType<new<T>()=>keyof T extends never?Error:{stack:string}>; function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'inherited Object method conditional origin',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Failure={} extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'Callable any parameter union retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = ((value:number)=>void) extends ((value:any|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'Map missing unrelated entry retains first Error frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error:Error){return new Map([['first',error],['other'] as never]).values().next().value!.stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'a shared module that answers otherwise',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'mixed Set parameter primitive collision',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(value:Error|number,error:Error){return new AggregateError(new Set([value,0,error]),\"ours\").errors[1].stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(0,new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'inherited JSON property list retains Error frames',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error: Error) { return JSON.stringify({__proto__: error}, ['stack']); }\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      'serializes engine-specific frames or words selected from an error by a JSON property list',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'HTML attribute retains Error words',
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error: Error) { return 'x'.link(error as never); }\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code writes an error it did not make as text',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'pr479 whole-any non-never frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = (any | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'raw own arraylike retains Error words',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return String.raw({raw:{0:error as never,length:1}});}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code writes an error it did not make as text',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'RegExp-like source retains Error words',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:error,flags:""} as never).source;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    to: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code writes an error it did not make as text',
  },
  {
    what: 'cause parameter retains possible Error frames',
    beside: {
      'domain/todo-filter.ts':
        'import type { TodoFilter } from \'@/navigation\';\nfunction frames(error:Error){return (new Error({toString(){Object.assign(error,{stack:\'fixed\'});return \'ours\';}} as never,{cause:error}).cause as {stack:string}).stack;}\nexport function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?"all":value==="active"||value==="done"?value:"all";}',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'async find parameter retains Error frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(errors:Error[]){return errors.find(async()=>false)!.stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames([new Error(\"ours\")])).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'PR479 callback rest input preserves frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
        "export function normalizeFilter(value: string): TodoFilter { return String(frames(new Error('ours'))).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'PR479 mapper rest packed input retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'function frames(error:Error){return ([error].map((...values:unknown[])=>values[0])[0] as {stack?:string}).stack;}',
        "export function normalizeFilter(value: string): TodoFilter { return String(frames(new Error('ours'))).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'parameter utility unknown keys retain frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = Parameters<<T>(value: keyof T extends never ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    to: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
  },
  {
    what: 'quiet Promise resolve root retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,undefined,null,0,true,false,"x").then()).stack;}',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    to: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
  },
  {
    what: 'written whole-any union retains error frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = (any | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error(\"ours\"))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  {
    what: 'PR479 intersection-never fallback retains frames',
    beside: {
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        'type Failure = (string & number) extends never ? Error : { stack: string };',
        "function frames(error: Failure): string { return error.stack ?? ''; }",
        "export function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
      ].join('\n'),
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
  },
  ...[
    {
      what: 'PR479R8 required undefined argument keeps error branch',
      declaration: 'type Select<T> = T extends () => unknown ? { stack: string } : Error;',
      type: 'Select<(value: string | undefined) => void>',
    },
    {
      what: 'PR479R8 nested union argument inferred error',
      declaration: 'type Value<T> = T extends (value: { nested: infer V }) => unknown ? V : never;',
      type: 'Value<(value: { nested: Error } | { nested: TypeError }) => void>',
    },
    {
      what: 'PR479R7 standalone interface error heritage',
      declaration: 'interface Failure extends Error {}',
      type: 'Failure',
    },
    {
      what: 'PR479R7 function return inferred error',
      declaration: 'type Result<T> = T extends () => infer R ? R : never;',
      type: 'Result<() => Error>',
    },
    {
      what: 'PR479R7 variadic function return inferred error',
      declaration: 'type Result<T> = T extends (...args: never[]) => infer R ? R : never;',
      type: 'Result<() => Error>',
    },
    {
      what: 'PR479R7 string index inferred error',
      declaration: 'type Value<T> = T extends { [key: string]: infer V } ? V : never;',
      type: 'Value<{ [key: string]: Error }>',
    },
    {
      what: 'PR479R7 numeric index inferred error',
      declaration: 'type Value<T> = T extends { [key: number]: infer V } ? V : never;',
      type: 'Value<{ [key: number]: Error }>',
    },
    {
      what: 'PR479R7 composed conditional inferred error',
      declaration: 'type Value<T> = T extends { [key: string]: infer V } ? V : never;',
      type: 'Value<{ [key: string]: Promise<Error> }> extends Promise<infer V> ? V : never',
    },
    {
      what: 'PR479R7 optional argument inferred error',
      declaration:
        'type Result<T> = T extends (value?: string) => infer R ? R : { stack: string };',
      type: 'Result<(value: string | undefined) => Error>',
    },
    {
      what: 'PR479R7 nested argument inferred error',
      declaration: 'type Value<T> = T extends (value: { nested: infer V }) => unknown ? V : never;',
      type: 'Value<(value: { nested: Error }) => void>',
    },
  ].map(({ declaration, type, what }): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': [
          "import type { TodoFilter } from '@/navigation';",
          declaration,
          `function frames(error: ${type}): string { return error.stack ?? ''; }`,
          "export function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }",
        ].join('\n'),
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason: 'its code reads `stack` of an error',
      to: 'const renderedFilter = effectiveFilter;',
      what,
    };
  }),
  ...[
    'Object.freeze(new Uint8Array(1))',
    'Object.seal(new Int16Array([1]))',
    'globalThis.Object.freeze(new Float64Array(new ArrayBuffer(8)))',
    'Object.freeze(new BigInt64Array([1n]))',
    'Object.freeze(new Uint8Array(new ArrayBuffer(4), 1, 1))',
    'Object.freeze(Uint8Array.of(1))',
    'Object.seal(Uint8Array.from([1]))',
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `an initializer locking a nonempty typed array: ${expression}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'lock(view)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      '  const lock = Object.freeze;',
      '  const Made = globalThis.Uint8Array;',
      '  const view = new Made(1);',
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (lock(view), 'ok') : first);",
    ].join('\n'),
    what: 'an initializer locking a nonempty typed array through aliases',
  },
  ...[
    'delete (Object.freeze({ value: 1 }) as any).value',
    "delete (Object.freeze(Object.defineProperty({}, 'value', { value: 1, configurable: true })) as any).value",
    'delete (Object.freeze(Object.create(null, { value: { value: 1, configurable: true } })) as any).value',
    "delete (globalThis.Object.seal({ value: 1 }) as any)['value']",
    'delete (Object.freeze([1]) as any)[0]',
    'delete ([1] as any).length',
    "delete ('x' as any)[0]",
    "delete ('x' as any).length",
    "delete (Object.defineProperty({}, 'value', { value: 1 }) as any).value",
    "delete (Object.defineProperty({ value: 1 }, 'value', { configurable: false }) as any).value",
    'delete (Object.create(null, { value: { value: 1 } }) as any).value',
    'delete (Object.defineProperties({}, { value: { value: 1 } }) as any).value',
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `an initializer deleting a statically locked property: ${expression}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'delete locked[key]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      '  const lock = Object.freeze;',
      '  const locked = lock({ value: 1 });',
      "  const key = 'value';",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (delete locked[key], 'ok') : first);",
    ].join('\n'),
    what: 'an initializer deleting a statically locked property through aliases',
  },
  ...[
    'AggregateError',
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
  ].flatMap((name) => {
    return ['', 'new '].map((prefix): Refused => {
      const made = `${prefix}${name}(${name === 'AggregateError' ? "[], 'x'" : "'x'"}, { get cause() { throw new Error('bad'); } })`;
      return {
        file: 'components/kinds.reactive.tsx',
        from: 'useReactiveState(first)',
        marker: made,
        original: KINDS_SOURCE,
        reason: 'A state the authority starts is of',
        to: `useReactiveState<string>(first === '' ? (${made}, 'ok') : first)`,
        what: `an Error options cause getter that throws: ${made}`,
      };
    });
  }),
  ...[
    "new Error('x', { get ['cause']() { throw new Error('bad'); }, set cause(_value) {} })",
    "Error('x', { get cause() { return decodeURIComponent('%'); } })",
    "(() => new TypeError('x', { get cause() { throw new Error('bad'); } }))()",
  ].map((made): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: made.startsWith('(') ? 'new TypeError(' : made,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${made}, 'ok') : first)`,
      what: `an Error options cause getter that throws: ${made}`,
    };
  }),
  ...["new Made('x', options)", "Made('x', options)"].map((made): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: '  const [selected, setSelected] = useReactiveState(first);',
      marker: made,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: [
        '  const Made = globalThis.TypeError;',
        "  const options = { get cause() { throw new Error('bad'); } };",
        `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${made}, 'ok') : first);`,
      ].join('\n'),
      what: `an Error options cause getter that throws through aliases: ${made}`,
    };
  }),
  ...[
    "new Response(null, { get status() { throw new Error('bad'); } })",
    "new Response(null, { get headers() { throw new Error('bad'); } })",
    "new Request('https://example.com/', { get method() { throw new Error('bad'); } })",
    "new Event('x', { get bubbles() { throw new Error('bad'); } })",
    "new Blob([], { get type() { throw new Error('bad'); } })",
    "new Blob([], { get endings() { throw new Error('bad'); } })",
    "new File([], 'x', { get lastModified() { throw new Error('bad'); } })",
    "new Response(null, { get status() { return decodeURIComponent('%'); } })",
    "(() => new Response(null, { get status() { throw new Error('bad'); } }))()",
    "(function () { return new Response(null, { get status() { throw new Error('bad'); } }); })()",
    "new Response(null, { get status() { throw new Error('bad'); }, set status(_value) {} })",
  ].map((made): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: made.startsWith('(') ? 'new Response(null,' : made,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${made}, 'ok') : first)`,
      what: `a platform options getter that throws: ${made}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'new Made(null, options)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      '  const Made = globalThis.Response;',
      "  const options = { get status() { throw new Error('bad'); } };",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (new Made(null, options), 'ok') : first);",
    ].join('\n'),
    what: 'a platform options getter that throws through constructor and options aliases',
  },
  ...[
    '(null as any).value',
    "(undefined as any)['value']",
    '(void 0 as any).value',
    '(globalThis.undefined as any).value',
    '((0, null) as any).value',
    '((null as any)?.value).other',
    "((undefined as any)?.['value'])['other']",
    '((null as any)?.value!) .other',
    '(null as any).method()',
    '(null as any)()',
    '(undefined as any)()',
    'new (null as any)()',
    'new (undefined as any)()',
    '((null as any)?.method)()',
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `an initializer using a statically nullish receiver: ${expression}`,
    };
  }),
  ...[
    { declarations: '', expression: 'word[Symbol.match](value)' },
    { declarations: '', expression: "word[Symbol.replace](value, '-')" },
    { declarations: '', expression: 'word[globalThis.Symbol.match](value)' },
    { declarations: 'const key = Symbol.match;', expression: 'word[key](value)' },
    { declarations: '', expression: 'RegExp.prototype[Symbol.match].call(word, value)' },
    { declarations: '', expression: "RegExp.prototype[Symbol.replace].apply(word, [value, '-'])" },
    {
      declarations: '',
      expression: 'Reflect.apply(RegExp.prototype[Symbol.match], word, [value])',
    },
    { declarations: 'const match = word[Symbol.match].bind(word);', expression: 'match(value)' },
    {
      declarations: 'const replace = RegExp.prototype[Symbol.replace].bind(word);',
      expression: "replace(value, '-')",
    },
  ].map(({ declarations, expression }): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst word = /a/y;\n${declarations}\nexport function normalizeFilter(value: string): TodoFilter {\n  return String(${expression}).length > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `word`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a sticky RegExp symbol method changing a kept pattern: ${expression}`,
    };
  }),
  ...[
    '(function () { return ++this.n; })',
    '(function () { return ++this.n; } as () => number)',
    '(function () { return ++this.n; })!',
    '(function () { return ++this.n; } satisfies () => number)',
    '(function () { const bump = () => ++this.n; return bump(); })',
  ].map((method): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst counter = { n: 0, bump: ${method} };\nexport function normalizeFilter(value: string): TodoFilter {\n  return counter.bump() > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `counter`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a wrapped method changing its kept receiver: ${method}`,
    };
  }),
  ...[
    "(1).toLocaleString('bad_locale')",
    "Number(first).toLocaleString('bad_locale')",
    "(1n).toLocaleString('bad_locale')",
    "new Date(0).toLocaleString('bad_locale')",
    "[1].toLocaleString('bad_locale')",
    "new Uint8Array([1]).toLocaleString('bad_locale')",
    "'x'.toLocaleString(Number(Symbol('x')) as never)",
  ].map((call): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call.startsWith("'x'") ? "Number(Symbol('x'))" : call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a locale call that still throws: ${call}`,
    };
  }),
  ...[
    {
      code: "export function checked(value: string): string { return value + new Response(value ? new FormData() : '').headers.get('content-type'); }",
      reason: 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random',
      what: 'a multipart body selected by a conditional expression',
    },
    {
      code: "export function checked(value: string): string { const body = value && new FormData(); const options = { method: 'POST', body }; return value + new Request('https://example.com', options).headers.get('content-type'); }",
      reason: 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random',
      what: 'a multipart body selected through aliases and a logical expression',
    },
    {
      code: "export function checked(value: string): string { return value + new Request('https://example.com', { method: 'POST', ['bo' + 'dy']: new FormData() }).headers.get('content-type'); }",
      reason: 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random',
      what: 'a multipart body behind a computed options key',
    },
    {
      code: "class Date { valueOf() { return '2020-01-01T00:00:00'; } }\nfunction stamp(value: Date): number { return new globalThis.Date(value as never).getTime(); }\nexport function checked(value: string): string { return value + String(stamp(new Date())); }",
      reason: 'makes a one-argument `Date` whose text may use the time zone where it runs',
      what: 'a local class named Date masquerading as a global Date parameter type',
    },
  ].map(({ code, reason, what }): Refused => {
    return {
      also: [
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import TodoCommands from '@/components/todo-commands.reactive';\nimport { checked } from '@/domain/checked';",
      ],
      beside: { 'domain/checked.ts': `${code}\n` },
      file: 'components/kinds.reactive.tsx',
      from: "id={typeof selected === 'string' ? selected : ''}",
      marker: 'checked(selected)',
      original: KINDS_SOURCE,
      reason,
      to: 'id={checked(selected)}',
      what: `an audited shared helper with ${what}`,
    };
  }),
  ...[
    "structuredClone('x', { transfer: [buffer] });",
    "const options = { transfer: [buffer] }; globalThis.structuredClone('x', options);",
    "const list = [buffer]; const options = { transfer: list }; structuredClone('x', options);",
    "const alias = buffer; structuredClone('x', { transfer: [new ArrayBuffer(1), alias] });",
  ].map((transfer): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst buffer = new ArrayBuffer(1);\nexport function normalizeFilter(value: string): TodoFilter {\n  ${transfer}\n  return buffer.byteLength === 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `buffer`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared helper detaching a kept buffer: ${transfer}`,
    };
  }),
  ...[
    "Object.assign({}, { get value() { throw new Error('bad'); } })",
    "globalThis.Object.assign({}, {}, { get value() { return decodeURIComponent('%'); } })",
    "Object.assign({}, { get [Symbol.iterator]() { throw new Error('bad'); } })",
  ].map((call): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `an Object.assign source getter that throws: ${call}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'Object.assign({}, source)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      "  const source = { get value() { throw new Error('bad'); } };",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (Object.assign({}, source), 'ok') : first);",
    ].join('\n'),
    what: 'an Object.assign source getter that throws through a constant',
  },
  ...[
    "new Date('2020-01-01T00:00:00')",
    "new Date('January 1, 2020 00:00:00')",
    'new Date(STAMP)',
    'new Date(value)',
    "Date.parse('2020-01-01T00:00:00')",
    'Date.parse(value)',
    'Date.parse(0)',
    "new Date('-000000-01-01')",
    "Date.parse('-000000-01-01')",
  ].map((expression): Refused => {
    const result = expression.startsWith('Date.parse') ? expression : `${expression}.getTime()`;
    return {
      also: [
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import TodoCommands from '@/components/todo-commands.reactive';\nimport { dated } from '@/domain/helpers';",
      ],
      beside: {
        'domain/helpers.ts': `const STAMP = '2020-01-01T00:00:00';\nexport function dated(value: string): string {\n  return value + String(${result});\n}\n`,
      },
      file: 'components/kinds.reactive.tsx',
      from: "id={typeof selected === 'string' ? selected : ''}",
      marker: 'dated(selected)',
      original: KINDS_SOURCE,
      reason: 'may use the time zone where it runs',
      to: 'id={dated(selected)}',
      what: `a shared date whose input may use local time: ${expression}`,
    };
  }),
  ...[
    "new Request('https://example.com', { method: 'POST', body: new FormData() })",
    'new Response(new FormData())',
    "new Request('https://example.com', options)",
    'new Response(body)',
    "new Request('https://example.com', { ...options })",
  ].map((expression): Refused => {
    return {
      also: [
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import TodoCommands from '@/components/todo-commands.reactive';\nimport { multipart } from '@/domain/helpers';",
      ],
      beside: {
        'domain/helpers.ts': `export function multipart(value: string): string {\n  const body = new FormData();\n  const options = { method: 'POST', body };\n  return value + ${expression}.headers.get('content-type');\n}\n`,
      },
      file: 'components/kinds.reactive.tsx',
      from: "id={typeof selected === 'string' ? selected : ''}",
      marker: 'multipart(selected)',
      original: KINDS_SOURCE,
      reason: 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random',
      to: 'id={multipart(selected)}',
      what: `a shared multipart body whose boundary is random: ${expression}`,
    };
  }),
  ...[
    { declarations: '', options: '{ lastModified }' },
    { declarations: '', options: '{ lastModified: lastModified }' },
    { declarations: 'const absent = undefined;', options: '{ lastModified: absent }' },
    { declarations: 'const alias = lastModified;', options: '{ lastModified: alias }' },
    { declarations: '', options: '{ lastModified: 0, lastModified: undefined }' },
    { declarations: 'const options = { lastModified };', options: 'options' },
  ].map(({ declarations, options }): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string, lastModified?: number): TodoFilter {\n  ${declarations}\n  return new File([], 'x', ${options}).lastModified > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes a `File` of no `lastModified`, which it takes of the time",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared File timestamp that may default to now: ${declarations} ${options}`,
    };
  }),
  ...[
    "new Number(Symbol('x'))",
    "new String(Symbol('x'))",
    "new Date(Symbol('x'))",
    "Number.parseFloat(Symbol('x'))",
    "Number.parseInt(Symbol('x'))",
    "Number.parseInt('1', Symbol('radix'))",
    'new globalThis.Number(Symbol.iterator)',
    'new globalThis.String(Symbol.iterator)',
    'new globalThis.Date(Symbol.iterator)',
    'globalThis.Number.parseFloat(Symbol.iterator)',
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `an initializer coercing a symbol through a constructor or parser: ${expression}`,
    };
  }),
  ...[
    'new AggregateError(null)',
    'new AggregateError(undefined)',
    'new AggregateError()',
    'AggregateError(1)',
    'new AggregateError(true)',
    'new AggregateError({ length: 0 })',
    "new globalThis.AggregateError(Symbol('errors'))",
    'Object.groupBy([], null)',
    'Object.groupBy([], undefined)',
    'Object.groupBy([])',
    'Map.groupBy([], null)',
    'Map.groupBy([], {})',
    'Map.groupBy([], [])',
    "Object.groupBy([], Symbol('callback'))",
    "new FinalizationRegistry(() => undefined).register(1, 'held')",
    "new FinalizationRegistry(() => undefined).register(null, 'held')",
    "new FinalizationRegistry(() => undefined).register(undefined, 'held')",
    "new FinalizationRegistry(() => undefined).register(Symbol.for('registered'), 'held')",
    "new FinalizationRegistry(() => undefined).register({}, 'held', null)",
    "new FinalizationRegistry(() => undefined).register({}, 'held', 1)",
    "new FinalizationRegistry(() => undefined).register({}, 'held', Symbol.for('token'))",
    'new FinalizationRegistry(() => undefined).register(Symbol.iterator, Symbol.iterator)',
    'new FinalizationRegistry(() => undefined).unregister(1)',
    'new FinalizationRegistry(() => undefined).unregister(undefined)',
    'new FinalizationRegistry(() => undefined).unregister()',
    "new FinalizationRegistry(() => undefined).unregister(Symbol.for('token'))",
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `an initializer evaluating an invalid collection or registry argument: ${expression}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'registry.register(target, target)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `registry.register(target, target)` here, which no JSON holds',
    to: "  const registry = new FinalizationRegistry(() => undefined);\n  const target = {};\n  const [selected, setSelected] = useReactiveState<string>(first === '' ? (registry.register(target, target), 'ok') : first);",
    what: 'an initializer registering a target as its own held value',
  },
  ...[
    'event.preventDefault();',
    'event.stopPropagation();',
    'event.stopImmediatePropagation();',
    "event.initEvent('updated', false, true);",
    'Event.prototype.preventDefault.call(event);',
    'const cancel = event.preventDefault.bind(event);\n  cancel();',
  ].map((mutation): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst event = new Event('x', { cancelable: true });\nexport function normalizeFilter(value: string): TodoFilter {\n  const changed = event.defaultPrevented || event.cancelBubble || event.type !== 'x';\n  ${mutation}\n  return changed ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `event`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared helper changing a kept Event: ${mutation}`,
    };
  }),
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst target = new EventTarget();\ntarget.addEventListener('x', (event) => event.preventDefault(), { once: true });\nexport function normalizeFilter(value: string): TodoFilter {\n  const accepted = target.dispatchEvent(new Event('x', { cancelable: true }));\n  return accepted ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `target`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a shared helper dispatching on a kept EventTarget with a once listener',
  },
  ...[
    'target.dispatchEvent(event);',
    'EventTarget.prototype.dispatchEvent.call(target, event);',
    'EventTarget.prototype.dispatchEvent.apply(target, [event]);',
    'Reflect.apply(EventTarget.prototype.dispatchEvent, target, [event]);',
    'const dispatch = target.dispatchEvent.bind(target);\n  dispatch(event);',
    'const dispatch = target.dispatchEvent.bind(target, event);\n  dispatch();',
  ].map((dispatch): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst event = new Event('x', { cancelable: true });\nexport function normalizeFilter(value: string): TodoFilter {\n  const changed = event.defaultPrevented;\n  const target = new EventTarget();\n  target.addEventListener('x', (each) => each.preventDefault());\n  ${dispatch}\n  return changed ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `event`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared helper dispatching a kept Event on a fresh EventTarget: ${dispatch}`,
    };
  }),
  ...[
    'const word = new RegExp(/a/g);',
    'const word = RegExp(/a/y);',
    "const flags = 'g';\nconst word = new RegExp('a', flags);",
    'const original = /a/y;\nconst word = new RegExp(original);',
    "const word = new RegExp('a', 'g' + '');",
    "const word = new RegExp('a', ['g'].join(''));",
    'const word = new RegExp(/a/g, undefined);',
  ].map((declaration): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\n${declaration}\nexport function normalizeFilter(value: string): TodoFilter {\n  return word.test(value) ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `word`",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared helper testing a copied or computed stateful pattern: ${declaration}`,
    };
  }),
  ...[
    "new Blob([value], { endings: 'native' }).size",
    "new File([value], 'x', { lastModified: 0, endings: 'native' }).size",
    'new Blob([value], { endings: value as EndingType }).size',
    'new Blob([value], { ...JSON.parse(value) }).size',
    'new Blob([value], JSON.parse(value)).size',
    "new Blob([value], { ['endings']: 'native' }).size",
  ].map((construction): Refused => {
    return {
      beside: {
        'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return ${construction} > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
      },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason:
        "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes a `Blob` or `File` of line endings the code shows no `transparent` one, which may follow the host platform",
      to: 'const renderedFilter = effectiveFilter;',
      what: `a shared helper making a body with platform line endings: ${construction}`,
    };
  }),
  panelsRefused(
    'a list whose callback takes an index',
    { from: PANEL_MAP, marker: '(panel, index) =>', to: '      {panels.map((panel, index) => (' },
    'takes the item alone, by name',
  ),
  panelsRefused(
    'a list whose callback destructures the item',
    {
      from: [PANEL_MAP, PANEL_CARD, PANEL_DETAIL].join('\n'),
      marker: '({ panelId, todoId }) =>',
      to: [
        '      {panels.map(({ panelId, todoId }) => (',
        '        <PanelCard key={panelId} panelId={panelId} todoId={todoId}>',
        '          <TodoDetails projectId={projectId} id={todoId} />',
      ].join('\n'),
    },
    'takes the item alone, by name',
  ),
  panelsRefused(
    'a list whose callback keys no element',
    {
      from: PANEL_CARD,
      marker: '(\n        <PanelCard panelId',
      to: '        <PanelCard panelId={panel.panelId} todoId={panel.todoId}>',
    },
    'returns the element it keys, as its expression',
  ),
  panelsRefused(
    'a list whose item stands under a condition of its own',
    {
      from: PANEL_DETAIL,
      marker: "panel.todoId !== '' && <TodoDetails",
      to: "          {panel.todoId !== '' && <TodoDetails projectId={projectId} id={panel.todoId} />}",
    },
    'stands under a condition within the callback of the `.map()` it is listed by',
  ),
  panelsRefused(
    'a list whose item is rendered of a state beside the item',
    {
      from: PANEL_DETAIL,
      marker: 'panels.length}',
      to: '          <TodoDetails projectId={projectId} id={panel.todoId + panels.length} />',
    },
    "`panels` is the browser's, and the element of a list's item is computed of the item",
  ),
  panelsRefused(
    'a list keyed by a state beside the item',
    {
      from: PANEL_CARD,
      marker: 'panels.length + panel.panelId}',
      to: '        <PanelCard key={panels.length + panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "`panels` is the browser's, and the key of a list's item is computed of the item",
  ),
  panelsRefused(
    'a list keyed by what the server part computes',
    {
      from: PANEL_CARD,
      marker: 'initialPanels.length + panel.panelId}',
      to: '        <PanelCard key={initialPanels.length + panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "the key of a list's item is computed by the browser as well as by the authority",
  ),
  panelsRefused(
    'a list within a list',
    {
      from: PANEL_DETAIL,
      marker: '<TodoDetails key={inner.panelId}',
      to: '          {[panel].map((inner) => <TodoDetails key={inner.panelId} projectId={projectId} id={inner.todoId} />)}',
    },
    'and in no other function of the browser',
  ),
  panelsRefused(
    'a list of an optional chain',
    { from: PANEL_MAP, marker: 'panels?.map(', to: '      {panels?.map((panel) => (' },
    'is mapped in an optional chain',
  ),
  panelsRefused(
    'a list of an array an optional chain answers',
    {
      from: PANEL_MAP,
      marker: 'panels?.slice(0).map(',
      to: '      {panels?.slice(0).map((panel) => (',
    },
    'is mapped in an optional chain',
  ),
  panelsRefused(
    'a list whose item takes a name the outputs read',
    {
      from: [PANEL_MAP, PANEL_CARD, PANEL_DETAIL].join('\n'),
      marker: 'sites) => (',
      to: [
        '      {panels.map((sites) => (',
        '        <PanelCard key={sites.panelId} panelId={sites.panelId} todoId={sites.todoId}>',
        '          <TodoDetails projectId={projectId} id={sites.todoId} />',
      ].join('\n'),
    },
    "a name the compile's outputs read where the item shows",
  ),
  panelsRefused(
    'a list of an array sorted in place',
    {
      from: PANEL_MAP,
      marker: 'panels.sort(',
      to: '      {panels.sort((a, b) => (a.todoId < b.todoId ? -1 : 1)).map((panel) => (',
    },
    'changes the array it is called on',
  ),
  panelsRefused(
    'a list of an array sorted in place by the method’s name in brackets',
    {
      from: PANEL_MAP,
      marker: "panels['sort'](",
      to: "      {panels['sort']((a, b) => (a.todoId < b.todoId ? -1 : 1)).map((panel) => (",
    },
    'changes the array it is called on',
  ),
  panelsRefused(
    'a list keyed by chance, by the method’s name in brackets',
    {
      from: PANEL_CARD,
      marker: "panel.panelId + String(Math['random']())}",
      to: "        <PanelCard key={panel.panelId + String(Math['random']())} panelId={panel.panelId} todoId={panel.todoId}>",
    },
    '`Math.random()` answers of chance',
  ),
  panelsRefused(
    'a list of an array filtered by chance, `Math.random` handed on uncalled',
    {
      from: PANEL_MAP,
      marker: 'panels.filter(Math.random).map(',
      to: '      {panels.filter(Math.random).map((panel) => (',
    },
    '`Math.random` answers of chance wherever it is called',
  ),
  panelsRefused(
    'a list of an array mapped by `Math.max` handed on, which reads the whole array for each item',
    {
      from: PANEL_MAP,
      marker: 'panels.map(Math.max).map(',
      to: '      {panels.map(Math.max).map((panel) => (',
    },
    '`Math.max` reads each value it is given, as many as there are',
  ),
  panelsRefused(
    'a list of an array mapped by `String.fromCharCode` handed on',
    {
      from: PANEL_MAP,
      marker: 'panels.map(String.fromCharCode).map(',
      to: '      {panels.map(String.fromCharCode).map((panel) => (',
    },
    '`String.fromCharCode` reads each value it is given, as many as there are',
  ),
  panelsRefused(
    'a list of an array sorted in place by `call`',
    {
      from: PANEL_MAP,
      marker: 'panels.sort.call(panels).map(',
      to: '      {panels.sort.call(panels).map((panel) => (',
    },
    '`.sort` is called by `.call(…)`',
  ),
  panelsRefused(
    'a list of an array as long as a number says',
    {
      from: PANEL_MAP,
      marker: 'Array.from(',
      to: '      {Array.from({ length: panels.length }, () => panels[0]!).map((panel) => (',
    },
    '`Array.from()` makes an array as long as what it is given says it is',
  ),
  panelsRefused(
    'a list of `Array(…)` of a number',
    {
      from: PANEL_MAP,
      marker: 'Array(panels.length)',
      to: '      {Array(panels.length).map((panel) => (',
    },
    '`Array(…)` makes an array as long as the number it is given says',
  ),
  panelsRefused(
    'a list whose item’s element is given a prop of chance',
    {
      from: PANEL_DETAIL,
      marker: 'Math.random() > 0.5',
      to: "          <TodoDetails projectId={projectId} id={Math.random() > 0.5 ? panel.todoId : 't1'} />",
    },
    '`Math.random()` answers of chance',
  ),
  panelsRefused(
    'a list keyed by `Infinity`, of which each item is refused',
    {
      from: PANEL_CARD,
      marker: 'Infinity}',
      to: '        <PanelCard key={Infinity} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "The key of a list's item answers `Infinity` here, which is neither text nor a finite number",
  ),
  panelsRefused(
    'a list keyed by what the code divides by zero',
    {
      from: PANEL_CARD,
      marker: '1 / 0}',
      to: '        <PanelCard key={1 / 0} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "The key of a list's item answers `1 / 0` here, which is neither text nor a finite number",
  ),
  panelsRefused(
    'a list keyed by what a function of `Math` answers of numbers, which is not finite',
    {
      from: PANEL_CARD,
      marker: 'Math.sqrt(-1)}',
      to: '        <PanelCard key={Math.sqrt(-1)} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "The key of a list's item answers `Math.sqrt(-1)` here, which is neither text nor a finite number",
  ),
  panelsRefused(
    'a list keyed by what may be `null`',
    {
      from: PANEL_CARD,
      marker: 'null : panel.panelId}',
      to: "        <PanelCard key={panel.todoId === '' ? null : panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>",
    },
    "The key of a list's item answers `null` here",
  ),
  panelsRefused(
    'a list of the panels each copied by `Object.assign`, which sets what an own `__proto__` holds as the prototype',
    {
      from: PANEL_MAP,
      marker: 'panels.map((panel) => Object.assign',
      to: '      {panels.map((panel) => Object.assign({}, panel)).map((panel) => (',
    },
    '`Object.assign()` sets each entry it copies on what it is given first',
  ),
  panelsRefused(
    'a list of an array frozen in place',
    {
      from: PANEL_MAP,
      marker: 'Object.freeze(panels)',
      to: '      {Object.freeze(panels).map((panel) => (',
    },
    '`Object.freeze()` changes the object it is given first',
  ),
  panelsRefused(
    'a list of an array sorted in place by a method asserted',
    { from: PANEL_MAP, marker: 'panels.sort!(', to: '      {panels.sort!().map((panel) => (' },
    '`.sort()` changes the array it is called on',
  ),
  panelsRefused(
    'a list keyed by a member the callback’s parameter’s type says may be left out',
    {
      from: PANEL_MAP,
      marker: 'panel.panelId} panelId',
      to: '      {panels.map((panel: { readonly panelId?: string; readonly todoId: string }) => (',
    },
    "The key of a list's item reads `panel.panelId` here, which its type says may be left out",
  ),
  panelsRefused(
    'a list keyed by its item, an object, as its type says',
    {
      from: PANEL_CARD,
      marker: 'panel} panelId',
      to: '        <PanelCard key={panel} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    "The key of a list's item reads `panel` here, which its type says may be left out",
  ),
  {
    also: [
      "import { useTodoPanels } from '@/hooks/use-todo-panels';",
      "import { useLoosePanels } from '@/hooks/use-loose-panels';",
    ],
    beside: {
      'domain/loose-panels.ts':
        'export interface LoosePanel {\n  readonly panelId?: string;\n  readonly todoId: string;\n}\n',
      'hooks/use-loose-panels.ts': [
        "import { useReactiveState } from 'framework/react';",
        "import type { LoosePanel } from '@/domain/loose-panels';",
        '',
        'export function useLoosePanels(initialPanels: readonly LoosePanel[]) {',
        '  const [panels, setPanels] = useReactiveState<readonly LoosePanel[]>(initialPanels);',
        "  const visible = panels.filter((panel) => panel.todoId !== '');",
        '  const closeAll = (): void => {',
        '    setPanels([]);',
        '  };',
        '  return { panels: visible, all: panels, closeAll };',
        '}',
        '',
      ].join('\n'),
    },
    file: PANELS_LIST,
    from: '  const { panels, closeAll } = useTodoPanels(initialPanels);',
    marker: 'panel.panelId} panelId',
    original: PANELS_LIST_SOURCE,
    reason:
      "The key of a list's item reads `panel.panelId` here, which its type says may be left out",
    to: '  const { panels, closeAll } = useLoosePanels(initialPanels);',
    what: 'a list keyed by a member its items’ type, of a hook’s state filtered, says may be left out',
  },
  {
    also: [
      "import { useTodoPanels } from '@/hooks/use-todo-panels';",
      "import { useReactiveState } from 'framework/react';",
    ],
    file: PANELS_LIST,
    from: '  const { panels, closeAll } = useTodoPanels(initialPanels);',
    marker: 'panel.panelId} panelId',
    original: PANELS_LIST_SOURCE,
    reason:
      "The key of a list's item reads `panel.panelId` here, which its type says may be left out",
    to: [
      '  const [panels, setPanels] = useReactiveState<readonly { readonly panelId: string | null; readonly todoId: string }[]>(initialPanels);',
      '  const closeAll = (): void => {',
      '    setPanels([]);',
      '  };',
    ].join('\n'),
    what: 'a list keyed by a member its items’ type, of a state’s type argument, says may be `null`',
  },
  panelsRefused(
    'a list of a copy sorted by a comparator, of whose order the engine may choose',
    {
      from: PANEL_MAP,
      marker: '[...panels].sort(',
      to: '      {[...panels].sort(() => 1).map((panel) => (',
    },
    '`.sort(…)` given a comparator orders as each engine',
  ),
  panelsRefused(
    'a list of an array sorted by `toSorted` and a comparator',
    {
      from: PANEL_MAP,
      marker: 'panels.toSorted(',
      to: '      {panels.toSorted((a, b) => (a.todoId < b.todoId ? -1 : 1)).map((panel) => (',
    },
    '`.toSorted(…)` given a comparator orders as each engine',
  ),
  panelsRefused(
    'a list whose callback is async',
    { from: PANEL_MAP, marker: 'async (panel) => (', to: '      {panels.map(async (panel) => (' },
    'is async: it answers a promise for each item',
  ),
  panelsRefused(
    'a list keyed by the time',
    {
      from: PANEL_CARD,
      marker: 'Date.now()',
      to: '        <PanelCard key={panel.panelId + String(Date.now())} panelId={panel.panelId} todoId={panel.todoId}>',
    },
    '`Date` is a global the browser and the authority may each answer otherwise',
  ),
  panelsRefused(
    'a list under a condition of where it runs',
    {
      from: PANEL_MAP,
      marker: "window !== 'undefined'",
      to: "      {typeof window !== 'undefined' && panels.map((panel) => (",
    },
    '`window` is a global the browser and the authority may each answer otherwise',
  ),
  {
    also: [
      '  const { panels, closeAll } = useTodoPanels(initialPanels);',
      '  const { panels, closeAll } = useTodoPanels(initialPanels);\n  const ordered = panels.reverse();',
    ],
    file: PANELS_LIST,
    from: PANEL_MAP,
    marker: 'ordered.map(',
    original: PANELS_LIST_SOURCE,
    reason: 'changes the array it is called on',
    to: '      {ordered.map((panel) => (',
    what: 'a list of an array a constant reverses in place',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        "  const listed = filter === 'done' && Date.now() > 0 ? 'done' : 'all';",
      ),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Date` is a global the browser and the authority may each answer otherwise',
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes of the time',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.padStart()` makes text as long as the number it is given says',
    to: "const shown = listed.padStart(projectId.length, ' ');",
    what: 'a dynamic site of text as long as a number says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.match()` makes a regular expression of what it is given',
    to: "const shown = listed.match(filter) === null ? 'all' : listed;",
    what: 'a dynamic site of a regular expression of a value',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.map` is called by `.call(…)`',
    to: "const shown = [].map.call(listed, (character: string) => character).length > 2 ? listed : 'all';",
    what: 'a dynamic site of an array’s method called through `call`',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      '`Array.from` makes an array as long as what it is given says it is, and it is handed on here',
    to: "const shown = [listed].map(Array.from).length > 0 ? listed : 'all';",
    what: 'a dynamic site of `Array.from` handed on',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Object.isFrozen()` answers of what an object holds beyond its value',
    to: "const shown = Object.isFrozen(listed) ? listed : 'all';",
    what: 'a dynamic site of whether a state is frozen',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      '`Object.isSealed` answers of what an object holds beyond its value, and it is handed on here',
    to: "const shown = [listed].some(Object.isSealed) ? listed : 'all';",
    what: 'a dynamic site of whether a state is sealed, `Object.isSealed` handed on',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: '<TodoResults projectId={projectId} filter={shown} />',
    marker: 'shown.repeat(',
    original: LISTING_SOURCE,
    reason: '`.repeat()` makes text as long as the number it is given says',
    to: '<TodoResults projectId={projectId} filter={shown.repeat(projectId.length)} />',
    what: 'a site’s prop of text as long as a number says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: '<TodoResults projectId={projectId} filter={shown} />',
    marker: 'Date.now()',
    original: LISTING_SOURCE,
    reason: '`Date` is a global the browser and the authority may each answer otherwise',
    to: "<TodoResults projectId={projectId} filter={Date.now() > 0 ? shown : 'all'} />",
    what: 'a site’s prop of the time',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.join()` repeats what it is given for each entry',
    to: "const shown = [listed, listed].join(filter) === '' ? 'all' : listed;",
    what: 'a dynamic site of an array joined by a value',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.replaceAll()` repeats what it is given for each entry',
    to: "const shown = listed.replaceAll('', filter) === '' ? 'all' : listed;",
    what: 'a dynamic site of text each match of which is replaced by a value',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.fill()` repeats what it is given for each entry',
    to: "const shown = [listed, listed].fill(filter)[0] ?? 'all';",
    what: 'a dynamic site of an array filled with a value',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Object.seal` changes the object it is given first wherever it is called',
    to: "const shown = [listed].map(Object.seal)[0] ?? 'all';",
    what: 'a dynamic site of `Object.seal` handed on',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Array` is read here as a value of its own',
    to: "const Arrays = Array;\n  const shown = Arrays.isArray(listed) ? listed : 'all';",
    what: 'a dynamic site of `Array` under another name',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Math` is read here as a value of its own',
    to: "const M = Math;\n  const shown = M.random() > 0.5 ? listed : 'all';",
    what: 'a dynamic site of `Math` under another name',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Object` is read here as a value of its own',
    to: "const shown = ({ Object }).Object.keys(listed).length > 0 ? listed : 'all';",
    what: 'a dynamic site of `Object` written in an object as it is',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`BigInt` makes an integer of a number',
    to: "const shown = BigInt(listed.length) << BigInt(listed.length) > 0 ? listed : 'all';",
    what: 'a dynamic site of an integer as large as a number says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.repeat(3)` repeats text the code does not write',
    to: "const shown = listed.repeat(3) === '' ? 'all' : listed;",
    what: 'a dynamic site of text a view sends repeated, as long as it is so many times',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.repeat(1000000)` makes text of 1000000 characters',
    to: "const shown = 'x'.repeat(1000000) === listed ? listed : 'all';",
    what: 'a dynamic site of text the code writes repeated past the steps a site may spend',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.padStart(1000000)` makes text of 1000000 characters',
    to: "const shown = listed.padStart(1000000) === '' ? 'all' : listed;",
    what: 'a dynamic site of text padded past the steps a site may spend',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.join()` writes text of 17 characters again',
    to: "const shown = [listed].join('-----------------') === '' ? 'all' : listed;",
    what: 'a dynamic site of a separator the code writes longer than a call may repeat',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.replaceAll()` writes text of 17 characters again',
    to: "const shown = listed.replaceAll('-', '-----------------') === '' ? 'all' : listed;",
    what: 'a dynamic site of a replacement the code writes longer than a call may repeat',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`2n` is an integer of `BigInt`, which no JSON holds',
    to: 'const shown = listed.length > 0 ? listed : 2n;',
    what: 'a dynamic site whose element is given an integer of `BigInt`',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `listed.length / 0` here, which no JSON holds",
    to: 'const shown = listed.length / 0;',
    what: 'a dynamic site whose element is given what a division by zero makes, never finite',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `Infinity` here, which no JSON holds",
    to: "const shown = listed === 'all' ? listed : Infinity;",
    what: 'a dynamic site whose element is given `Infinity` in an answer of a condition',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `'x'.trim` here, which no JSON holds",
    to: "const shown = listed === 'all' ? listed : 'x'.trim;",
    what: 'a dynamic site whose element is given a method of text the code writes, a function',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `undefined` here, which no JSON holds",
    to: 'const none = undefined;\n  const shown = { first: none, rest: [none] };',
    what: 'a dynamic site whose element is given a constant of `undefined` an array holds, past an entry that may hold it',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`String` is read here as a value of its own',
    to: "const shown = (listed === 'all' ? String : String).raw({ raw: [listed] }) === '' ? 'all' : listed;",
    what: 'a dynamic site of `String` an operator answers, whose `.raw` escapes its rule',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`String` is read here as a value of its own',
    to: "const shown = ({ text: String }).text.raw({ raw: [listed] }) === '' ? 'all' : listed;",
    what: 'a dynamic site of `String` an object holds, whose `.raw` escapes its rule',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.match()` makes a regular expression of what it is given',
    to: "const shown = listed.match('^(a+)+$') === null ? 'all' : listed;",
    what: 'a dynamic site of a pattern the code writes',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.constructor` reaches what made a value',
    to: "const shown = (0).constructor.constructor('return 1')() === 1 ? listed : 'all';",
    what: 'a dynamic site of what made a value, `Function` of it',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.constructor` reaches what made a value',
    to: "const shown = listed['constructor'] === String ? listed : 'all';",
    what: 'a dynamic site of what made a value, read by its name in brackets',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      '`Object.defineProperty()` makes what an object holds out of its own enumerated entries',
    to: "const shown = [listed].map((value) => Object.defineProperty({}, 'held', { value })).length > 0 ? listed : 'all';",
    what: 'a dynamic site of a property defined not enumerable',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Object.create()` makes what an object holds out of its own enumerated entries',
    to: "const shown = Object.create(null) === null ? 'all' : listed;",
    what: 'a dynamic site of an object made of another',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`__proto__:` makes the object of another',
    to: "const shown = ({ __proto__: { listed } }).listed ?? 'all';",
    what: 'a dynamic site of an object written of another by `__proto__`',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`parseInt(…)` of a radix but 2, 4, 8, 10, 16 or 32',
    to: "const shown = parseInt(listed, 36) > 0 ? listed : 'all';",
    what: 'a dynamic site of text read as a number of a radix each engine may approximate',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`parseInt(…)` of a radix but 2, 4, 8, 10, 16 or 32',
    to: "const shown = Number.parseInt(listed, listed.length) > 0 ? listed : 'all';",
    what: 'a dynamic site of text read as a number of a radix the code does not write',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`parseInt` is handed on here',
    to: "const shown = [listed].map(parseInt).includes(1) ? listed : 'all';",
    what: 'a dynamic site of `parseInt` handed on, which `.map()` gives each index for a radix',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.parseInt` is handed on here',
    to: "const shown = [listed].map(Number.parseInt).includes(1) ? listed : 'all';",
    what: 'a dynamic site of `Number.parseInt` handed on',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.toString(…)` of a radix but 10',
    to: "const shown = listed.length.toString(3) === '1' ? listed : 'all';",
    what: 'a dynamic site of a number written in a radix but 10',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.map(…)` is given what the function it is given first is called on',
    to: "const shown = [listed].map([].push, [listed]).length > 0 ? listed : 'all';",
    what: 'a dynamic site of a method handed on, called on what `.map()` is given next',
  },
  {
    also: [
      'export function useListed',
      'export function helper(custom: number): number {\n  const Array = custom;\n  return Array;\n}\n\nexport function useListed',
    ],
    beside: { [LISTING]: LISTING_SOURCE },
    file: LISTED_HOOK,
    from: "  const listed = filter === 'done' ? 'done' : 'all';",
    marker: 'Array.from({ length: filter',
    original: LISTED_HOOK_SOURCE,
    reason: "`Array` is not in the hook's scope here",
    to: "  const listed = Array.from({ length: filter.length }).length > 3 ? 'done' : 'all';",
    what: 'a hook’s value of the global `Array`, whose name another function of its module declares',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Math.sin()` answers as each engine approximates it',
    to: "const shown = Math.sin(listed.length) > 0 ? listed : 'all';",
    what: 'a dynamic site of what an engine approximates',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`**` answers as each engine approximates it',
    to: "const shown = listed.length ** 2 > 0 ? listed : 'all';",
    what: 'a dynamic site of a power',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`String.raw()` makes text of as many segments as what it is given says it holds',
    to: "const shown = String.raw({ raw: { length: listed.length } } as unknown as TemplateStringsArray) === '' ? 'all' : listed;",
    what: 'a dynamic site of text of as many segments as a value says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: '<TodoResults projectId={projectId} filter={shown} />',
    marker: 'pattern.test(',
    original: LISTING_SOURCE.replace(
      '  const { filter, setFilter, listed } = useListed(initialFilter);',
      '  const pattern = /^(a+)+$/;\n  const { filter, setFilter, listed } = useListed(initialFilter);',
    ),
    reason: "`.test()` is a regular expression's method",
    to: "<TodoResults projectId={projectId} filter={pattern.test(shown) ? shown : 'all'} />",
    what: 'a site’s prop of a regular expression the server part made',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.replace()` is given what may be a regular expression',
    to: "const shown = listed.replace(filter, '') === '' ? 'all' : listed;",
    what: 'a dynamic site of text replaced by what may be a regular expression',
  },
  {
    file: 'components/ratio.reactive.tsx',
    from: 'useReactiveState(0)',
    marker: '0 / 0)',
    original: RATIO_SOURCE,
    reason: 'A state the authority starts is of `0 / 0` here, which no JSON holds',
    to: 'useReactiveState(0 / 0)',
    what: 'a state a site reads, started of what the code computes of numbers, which is not finite',
  },
  {
    file: 'components/ratio.reactive.tsx',
    from: 'useReactiveState(0)',
    marker: "Number('bad'))",
    original: RATIO_SOURCE,
    reason: "A state the authority starts is of `Number('bad')` here, which no JSON holds",
    to: "useReactiveState(Number('bad'))",
    what: 'a state a site reads, started of what `Number` answers of text that is no number',
  },
  {
    file: 'components/ratio.reactive.tsx',
    from: 'useReactiveState(0)',
    marker: "parseInt('x', 10))",
    original: RATIO_SOURCE,
    reason: "A state the authority starts is of `parseInt('x', 10)` here, which no JSON holds",
    to: "useReactiveState(parseInt('x', 10))",
    what: 'a state a site reads, started of what `parseInt` answers of text that is no number',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`length:` makes an object stand for an array as long as it says',
    to: "const shown = [listed].concat({ length: listed.length } as never).length > 1 ? listed : 'all';",
    what: 'a dynamic site of an object of a `length`, which stands for an array as long',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.replaceAll()` is given `$`',
    to: "const shown = listed.replaceAll('', '$`').length > 2 ? listed : 'all';",
    what: 'a dynamic site of text that puts what stands before each match in its place',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Object.getOwnPropertySymbols` answers the symbols an object holds',
    to: "const shown = Object.getOwnPropertySymbols([listed]).length > 0 ? listed : 'all';",
    what: 'a dynamic site of the symbols an object holds',
  },
  {
    file: 'components/maybe.reactive.tsx',
    from: '(null)',
    marker: 'undefined as unknown',
    original: [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      '',
      'export default function Maybe({ projectId }: { projectId: string }) {',
      '  const [selectedId, setSelectedId] = useReactiveState<string | null>(null);',
      '  return (',
      '    <section>',
      '      <button type="button" onClick={() => setSelectedId(\'t1\')}>t1</button>',
      "      <TodoCommands projectId={projectId} id={selectedId ?? ''} />",
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
    reason: 'A state the authority starts is of `undefined` here, which no JSON holds',
    to: '(undefined as unknown as null)',
    what: 'a state a site reads, started of what no JSON holds',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: 'useFilter(initialFilter)',
    marker: 'NaN as unknown as TodoFilter)',
    original: SHEET_SOURCE,
    reason: 'A state the authority starts is of `NaN` here, which no JSON holds',
    to: 'useFilter(NaN as unknown as TodoFilter)',
    what: 'a hook’s local state given what no JSON holds',
  },
  {
    file: PANELS_LIST,
    from: '      ))}',
    marker: 'panels.map((panel) => (',
    original: PANELS_LIST_SOURCE,
    reason: 'is used otherwise than as it is',
    to: '      )).slice(0, 1)}',
    what: 'a list of what its `.map()` answers, sliced after it',
  },
  {
    beside: { [SHEET]: SHEET_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'useReactiveState<TodoFilter>(initialFilter)',
    marker: 'TodoFilter | undefined>',
    original: USE_FILTER,
    reason: '`filter` declares a state a site reads that may hold `undefined`',
    to: 'useReactiveState<TodoFilter | undefined>(initialFilter)',
    what: 'a hook’s local state typed by its own type argument of `undefined` too',
  },
  {
    beside: { [SHEET]: SHEET_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'useFilter(initialFilter: TodoFilter)',
    marker: 'string | { id: string })',
    original: USE_FILTER,
    reason: '`initialFilter` declares a state of values of more than one kind of JSON',
    to: 'useFilter(initialFilter: string | { id: string })',
    what: 'a hook’s local state of values of more than one kind of JSON',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: "useReactiveState<string>('t1')",
    marker: 'string | { id: string }>',
    original: [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      '',
      'export default function Kinds({ projectId }: { projectId: string }) {',
      "  const [selected, setSelected] = useReactiveState<string>('t1');",
      '  return (',
      '    <section>',
      '      <button type="button" onClick={() => setSelected(\'t2\')}>t2</button>',
      "      <TodoCommands projectId={projectId} id={typeof selected === 'string' ? selected : ''} />",
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: "useReactiveState<string | { id: string }>('t1')",
    what: 'a state a site reads of values of more than one kind of JSON',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Promise.resolve(first) as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Promise.resolve(first)` here, which no JSON holds',
    to: 'useReactiveState(Promise.resolve(first) as unknown as string)',
    what: 'a state a site reads, started of the promise a global’s function answers',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].map(async',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[first].map(async (each) => each)` here, which no JSON holds',
    to: 'useReactiveState([first].map(async (each) => each) as unknown as string)',
    what: 'a state a site reads, started of an array of what an async function answers, promises',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object(first) as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object(first)` here, which no JSON holds',
    to: 'useReactiveState(Object(first) as unknown as string)',
    what: 'a state a site reads, started of an object `Object` makes of text, a `String`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.rawJSON(first) as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `JSON.rawJSON(first)` here, which no JSON holds',
    to: 'useReactiveState(JSON.rawJSON(first) as unknown as string)',
    what: 'a state a site reads, started of raw JSON text, which JSON writes otherwise than its entries',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify(undefined)!',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify(undefined)` here, which no JSON holds',
    to: 'useReactiveState<string>(JSON.stringify(undefined)!)',
    what: 'a state a site reads, started of what `JSON.stringify` answers of `undefined`, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Object.defineProperty({}, 'x', { value: first }) as",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Object.defineProperty({}, 'x', { value: first })` here, which no JSON holds",
    to: "useReactiveState(Object.defineProperty({}, 'x', { value: first }) as unknown as string)",
    what: 'a state a site reads, started of an object of a property defined not enumerable, which JSON leaves out',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { marker } from '@/domain/helpers';",
    ],
    beside: { 'domain/helpers.ts': "export const marker = Symbol('marker');\n" },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.ownKeys(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Reflect.ownKeys({ [marker]: first })` here, which no JSON holds',
    to: 'useReactiveState(Reflect.ownKeys({ [marker]: first }) as unknown as string)',
    what: 'a state a site reads, started of the keys of an object, a symbol a shared module exports among them',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { marker } from '@/domain/helpers';",
    ],
    beside: { 'domain/helpers.ts': "export const marker = Symbol('marker');\n" },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.getOwnPropertySymbols(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.getOwnPropertySymbols({ [marker]: first })` here, which no JSON holds',
    to: 'useReactiveState(Object.getOwnPropertySymbols({ [marker]: first }) as unknown as string)',
    what: 'a state a site reads, started of the symbols an object holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.getOwnPropertyDescriptor(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.getOwnPropertyDescriptor({}, first)` here, which no JSON holds',
    to: 'useReactiveState<{ value?: string }>(Object.getOwnPropertyDescriptor({}, first)!)',
    what: 'a state a site reads, started of a property’s descriptor, none of one the object does not hold',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.getOwnPropertyDescriptor(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Reflect.getOwnPropertyDescriptor({ first }, 'first')` here, which no JSON holds",
    to: "useReactiveState<{ value?: string }>(Reflect.getOwnPropertyDescriptor({ first }, 'first')!)",
    what: 'a state a site reads, started of a property’s descriptor, of `Reflect`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array.from<string>(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array.from<string>({ length: 1 })` here, which no JSON holds',
    to: 'useReactiveState<string[]>(Array.from<string>({ length: 1 }))',
    what: 'a state a site reads, started of what `Array.from` makes of an object of a `length`, `undefined` of each element it lacks',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array.from(box,',
    original: KINDS_SOURCE.replace(
      '  const [selected, setSelected]',
      () => "  const box = { length: 1, ['0']: first };\n  const [selected, setSelected]",
    ),
    reason:
      'A state the authority starts is of `Array.from(box, (each: string) => each)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(Array.from(box, (each: string) => each))',
    what: 'a state a site reads, started of what `Array.from`’s function answers of an element an array-like of a constant’s lacks',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array(1)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Array(1)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(Array(1))',
    what: 'a state a site reads, started of an array of holes `Array` makes as long as a number says',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array(() => first, first)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array(() => first, first)` here, which no JSON holds',
    to: 'useReactiveState(Array(() => first, first) as unknown as string)',
    what: 'a state a site reads, started of an array `Array` makes of a function it is given',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.match(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `first.match(/x/)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(first.match(/x/)!)',
    what: 'a state a site reads, started of an array of a match, of names of its own beside its elements',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '/x/.exec(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `/x/.exec(first)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(/x/.exec(first)!)',
    what: 'a state a site reads, started of an array of a match a pattern’s `exec` answers',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.assign([],',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.assign([], { length: 1 })` here, which no JSON holds',
    to: 'useReactiveState<string[]>(Object.assign([], { length: 1 }))',
    what: 'a state a site reads, started of an array `Object.assign` writes a `length` on, of holes',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.setPrototypeOf(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.setPrototypeOf({ first }, { inherited: true })` here, which no JSON holds',
    to: 'useReactiveState<{ first: string }>(Object.setPrototypeOf({ first }, { inherited: true }))',
    what: 'a state a site reads, started of an object `Object.setPrototypeOf` gives a prototype of its own',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.create(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.create({ first })` here, which no JSON holds',
    to: 'useReactiveState<{ first: string }>(Object.create({ first }))',
    what: 'a state a site reads, started of an object `Object.create` makes of a prototype of its own',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '__proto__:',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `__proto__: { inherited: true }` here, which no JSON holds',
    to: 'useReactiveState<{ first: string }>({ __proto__: { inherited: true }, first })',
    what: 'a state a site reads, started of an object written of a prototype of its own, `__proto__:`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.get(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Reflect.get({ value: new Date(first) }, 'value')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? first : (Reflect.get({ value: new Date(first) }, 'value') as string))",
    what: 'a state a site reads, started of what `Reflect.get` reads of an object the code writes',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.get(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Reflect.get({ first }, first)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? first : (Reflect.get({ first }, first) as string))",
    what: 'a state a site reads, started of what `Reflect.get` reads by a key the compile cannot read',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'box.run',
    original: KINDS_SOURCE.replace(
      '  const [selected, setSelected]',
      () => '  const box = { run: () => first };\n  const [selected, setSelected]',
    ),
    reason: 'A state the authority starts is of `box.run` here, which no JSON holds',
    to: 'useReactiveState(box.run as unknown as string)',
    what: 'a state a site reads, started of a member of a constant’s object, a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first][1]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `[first][1]` here, which no JSON holds',
    to: 'useReactiveState([first][1])',
    what: 'a state a site reads, started of an element past the end of an array written there, `undefined`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.toString',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `first.toString` here, which no JSON holds',
    to: 'useReactiveState(first.toString as unknown as string)',
    what: 'a state a site reads, started of what every object inherits, a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'globalThis.JSON.stringify as',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `globalThis.JSON.stringify` here, which no JSON holds',
    to: "useReactiveState(first === '' ? first : (globalThis.JSON.stringify as unknown as string))",
    what: 'a state a site reads, started of a function of the language’s globals, read of the global object',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.assign({ first },',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Object.assign({ first }, { ['__proto__']: {} })` here, which no JSON holds",
    to: "useReactiveState<{ first: string }>(Object.assign({ first }, { ['__proto__']: {} }))",
    what: 'a state a site reads, started of what `Object.assign` copies of an entry named `__proto__`, which sets the prototype',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function make(text: string): Date {\n  return new Date(text);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'make.call(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `make.call(null, first)` here, which no JSON holds',
    to: 'useReactiveState(make.call(null, first) as unknown as string)',
    what: 'a state a site reads, started of what a shared function called through `call` answers',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function make(text: string): Date {\n  return new Date(text);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'make.apply(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `make.apply(null, [first])` here, which no JSON holds',
    to: 'useReactiveState(make.apply(null, [first]) as unknown as string)',
    what: 'a state a site reads, started of what a shared function called through `apply` answers',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function make(text: string): Date {\n  return new Date(text);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'make.bind(null, first)()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `make.bind(null, first)()` here, which no JSON holds',
    to: 'useReactiveState(make.bind(null, first)() as unknown as string)',
    what: 'a state a site reads, started of what a shared function bound by `bind` answers called',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function make(text: string): Date {\n  return new Date(text);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'make.bind(null, first) as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `make.bind(null, first)` here, which no JSON holds',
    to: 'useReactiveState(make.bind(null, first) as unknown as string)',
    what: 'a state a site reads, started of what `bind` answers, a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => new Date(first))()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `(() => new Date(first))()` here, which no JSON holds',
    to: 'useReactiveState((() => new Date(first))() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes there answers called',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'made() as',
    original: KINDS_SOURCE.replace(
      '  const [selected, setSelected]',
      () =>
        '  const day = new Date(first);\n  function made() {\n    return day;\n  }\n  const [selected, setSelected]',
    ),
    reason: 'A state the authority starts is of `made()` here, which no JSON holds',
    to: 'useReactiveState(made() as unknown as string)',
    what: 'a state a site reads, started of what the server part’s function answers, of a constant of the server part’s',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[].slice.call(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `[].slice.call(first)` here, which no JSON holds',
    to: 'useReactiveState<string[]>([].slice.call(first))',
    what: 'a state a site reads, started of what a method called through `call` answers, which the compile does not read',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.split(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `first.split(/a|(b)/)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(first.split(/a|(b)/))',
    what: 'a state a site reads, started of text split by a pattern of a group that may capture nothing, `undefined`',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { made } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': [
        'function build(text: string) {',
        '  return new Date(text);',
        '}',
        '',
        'export function made(text: string) {',
        '  return build(text);',
        '}',
        '',
      ].join('\n'),
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'made(first)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `made(first)` here, which no JSON holds',
    to: 'useReactiveState(made(first) as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of what another of its module’s answers',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { listed } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': [
        'export function listed(items: readonly string[]) {',
        '  return items.values();',
        '}',
        '',
      ].join('\n'),
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'listed([first])',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `listed([first])` here, which no JSON holds',
    to: 'useReactiveState(listed([first]) as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of a method of its parameter’s, an iterator',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Date.parse('not-a-date')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Date.parse('not-a-date')` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? Date.parse('not-a-date') : 0)",
    what: 'a state a site reads, started of what `Date.parse` reads of text of no time, `NaN`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Promise.resolve(first).then(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Promise.resolve(first).then((value) => value)` here, which no JSON holds',
    to: 'useReactiveState(Promise.resolve(first).then((value) => value) as unknown as string)',
    what: 'a state a site reads, started of what a promise’s `then` answers, a promise',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.apply(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Reflect.apply(() => new Date(first), null, [])` here, which no JSON holds',
    to: 'useReactiveState(Reflect.apply(() => new Date(first), null, []) as unknown as string)',
    what: 'a state a site reads, started of what a function `Reflect.apply` calls answers',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "'x'.charCodeAt(2)",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `'x'.charCodeAt(2)` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? 'x'.charCodeAt(2) : 0)",
    what: 'a state a site reads, started of the code of a character past the end of text the code writes, `NaN`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date('bad').getTime()",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date('bad').getTime()` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? new Date('bad').getTime() : 0)",
    what: 'a state a site reads, started of the time of a date of text of no time, `NaN`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Math.exp(1000)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Math.exp(1000)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? Math.exp(1000) : 0)",
    what: 'a state a site reads, started of what an approximated function of `Math` makes of what the code writes, `Infinity`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Math.log(0)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Math.log(0)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? Math.log(0) : 0)",
    what: 'a state a site reads, started of the logarithm of zero, `-Infinity`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '+[first, first]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `+[first, first]` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? +[first, first] : 0)",
    what: 'a state a site reads, started of the number an array of two elements makes, `NaN`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "JSON.parse('1e400')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `JSON.parse('1e400')` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? JSON.parse('1e400') : 0)",
    what: 'a state a site reads, started of what `JSON.parse` makes of text the code writes of a number past those JSON holds, `Infinity`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "JSON.parse('[1e400]')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `JSON.parse('[1e400]')` here, which no JSON holds",
    to: "useReactiveState(JSON.parse('[1e400]') as unknown as string)",
    what: 'a state a site reads, started of what `JSON.parse` makes of text the code writes of an array of a number past those JSON holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "JSON.parse('1e400') - 1",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `JSON.parse('1e400') - 1` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? JSON.parse('1e400') - 1 : 0)",
    what: 'a state a site reads, started of what the code computes of what `JSON.parse` makes of text it writes, `Infinity`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const result',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const result',
    to: "useReactiveState((() => { const result = { id: first }; Object.defineProperty(result, 'hidden', { value: true }); return result; })() as unknown as string)",
    what: 'a state a site reads, started of what a function the code writes returns of a constant it defines a property of before',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const items',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const items',
    to: 'useReactiveState((() => { const items: unknown[] = [first]; items.push(() => first); return items; })() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes returns of a constant it pushes a function into before',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const box',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const box',
    to: 'useReactiveState((() => { const box = { inner: { id: first } }; const inner: Record<string, unknown> = box.inner; inner.run = () => first; return box; })() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes returns of a constant whose member another constant holds and is written a function into',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const rows',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const rows',
    to: 'useReactiveState((() => { const rows: Record<string, unknown>[] = [{ id: first }]; for (const row of rows) { row.run = () => first; } return rows; })() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes returns of a constant whose elements a loop writes a function into',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const taken',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const taken',
    to: 'useReactiveState((() => { const taken: Record<string, unknown> = { id: first }; [taken.run] = [() => first]; return taken; })() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes returns of a constant a pattern assigns a member of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const tagged',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const tagged',
    to: `useReactiveState((() => { const tagged: Record<string, unknown> = { id: first }; const put = (strings: TemplateStringsArray, target: Record<string, unknown>) => { target.run = () => strings.length; }; put\`\${tagged}\`; return tagged; })() as unknown as string)`,
    what: 'a state a site reads, started of what a function the code writes returns of a constant it hands a tag that writes a function into it',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { mark } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': [
        'export function mark(target: Record<string, unknown>) {',
        '  target.run = () => 1;',
        '}',
        '',
      ].join('\n'),
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => { const marked',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(() => { const marked',
    to: 'useReactiveState((() => { const marked: Record<string, unknown> = { id: first }; mark(marked); return marked; })() as unknown as string)',
    what: 'a state a site reads, started of what a function the code writes returns of a constant it hands a shared function that writes a function into it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'initial as unknown',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `initial` here, which the code changes after it declares it',
    to: [
      '  const initial = { id: first };',
      "  Object.defineProperty(initial, 'hidden', { value: true });",
      '  const [selected, setSelected] = useReactiveState(initial as unknown as string);',
    ].join('\n'),
    what: 'a state a site reads, started of a constant of the server part’s it defines a property of after',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: '({ ...box }).run',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `({ ...box }).run` here, which no JSON holds',
    to: [
      '  const box: Record<string, unknown> = { id: first };',
      '  box.run = () => first;',
      '  const [selected, setSelected] = useReactiveState(({ ...box }).run as unknown as string);',
    ].join('\n'),
    what: 'a state a site reads, started of a member of an object that spreads a constant of the server part’s the code puts a function into after',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'Array.from(box',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Array.from(box as ArrayLike<unknown>)` here',
    to: [
      '  const box: Record<string, unknown> = { id: first };',
      '  box.length = 2;',
      '  const [selected, setSelected] = useReactiveState(Array.from(box as ArrayLike<unknown>) as unknown as string);',
    ].join('\n'),
    what: 'a state a site reads, started of what `Array.from` makes of a constant of the server part’s the code writes a `length` of after, of elements it lacks',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'JSON.stringify({ inner',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `JSON.stringify({ inner: box })` here',
    to: [
      '  const box: Record<string, unknown> = { id: first };',
      '  box.n = BigInt(1);',
      '  const [selected, setSelected] = useReactiveState<string>(JSON.stringify({ inner: box }));',
    ].join('\n'),
    what: 'a state a site reads, started of what `JSON.stringify` throws of, an object of a constant of the server part’s the code puts an integer of `BigInt` into after',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { defaults } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': [
        "export const defaults = { id: 'x' };",
        "Object.defineProperty(defaults, 'hidden', { value: true });",
        '',
      ].join('\n'),
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'defaults as unknown',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `defaults` here',
    to: 'useReactiveState(defaults as unknown as string)',
    what: 'a state a site reads, started of a constant a shared module exports and defines a property of after',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({ first }, () =>',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `JSON.stringify({ first }, () => { throw new Error('bad'); })` here, which no JSON holds",
    to: "useReactiveState<string>(JSON.stringify({ first }, () => { throw new Error('bad'); }))",
    what: 'a JSON replacer that always throws instead of returning a value',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({}, function',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `JSON.stringify({}, function () { throw new Error('bad'); })` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (JSON.stringify({}, function () { throw new Error('bad'); }), 'ok') : first)",
    what: 'a JSON replacer that always throws within an enclosing comma expression',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'JSON.stringify({}, replacer)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({}, replacer)` here, which no JSON holds',
    to: [
      "  const replacer = () => { throw new Error('bad'); };",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (JSON.stringify({}, replacer), 'ok') : first);",
    ].join('\n'),
    what: 'a JSON replacer that always throws through a constant holding its function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({}, declared)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({}, declared)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (JSON.stringify({}, declared), 'ok') : first)",
    beside: {
      'domain/replacers.ts': "export function declared() { throw new Error('bad'); }\n",
    },
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { declared } from '@/domain/replacers';",
    ],
    what: 'a JSON replacer that always throws through an imported function declaration',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'JSON.stringify({}, declared)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({}, declared)` here, which no JSON holds',
    to: [
      "  function declared() { throw new Error('bad'); }",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (JSON.stringify({}, declared), 'ok') : first);",
    ].join('\n'),
    what: 'a JSON replacer that always throws through a local function declaration',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "JSON.stringify({}, () => { return decodeURIComponent('%'); })",
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({}, () => { return decodeURIComponent',
    to: "useReactiveState<string>(first === '' ? (JSON.stringify({}, () => { return decodeURIComponent('%'); }), 'ok') : first)",
    what: 'a JSON replacer that always throws while computing its block return expression',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "globalThis.JSON.stringify({}, () => decodeURIComponent('%'))",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `globalThis.JSON.stringify({}, () => decodeURIComponent('%'))` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (globalThis.JSON.stringify({}, () => decodeURIComponent('%')), 'ok') : first)",
    what: 'a JSON replacer that always throws of what its expression body computes',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.values({ get value()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.values(',
    to: "useReactiveState<string>(first === '' ? (Object.values({ get value() { throw new Error('bad'); } }), 'ok') : first)",
    what: 'an Object enumeration getter: values that always throw',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.entries({ get value()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.entries(',
    to: "useReactiveState<string>(first === '' ? (Object.entries({ get value() { return decodeURIComponent('%'); } }), 'ok') : first)",
    what: 'an Object enumeration getter: entries that compute a throwing value',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'globalThis.Object.entries(box)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `globalThis.Object.entries(box)',
    to: [
      "  const box = { get value() { throw new Error('bad'); } };",
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (globalThis.Object.entries(box), 'ok') : first);",
    ].join('\n'),
    what: 'an Object enumeration getter: a constant and globalThis',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.values({ value: 1, get value()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.values(',
    to: "useReactiveState<string>(first === '' ? (Object.values({ value: 1, get value() { throw new Error('bad'); } }), 'ok') : first)",
    what: 'an Object enumeration getter: a getter replaces a data property',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.values({ get value()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.values(',
    to: "useReactiveState<string>(first === '' ? (Object.values({ get value() { throw new Error('bad'); }, set value(_value) {} }), 'ok') : first)",
    what: 'an Object enumeration getter: a setter keeps the getter',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Object.entries({ get ['value']()",
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.entries(',
    to: "useReactiveState<string>(first === '' ? (Object.entries({ get ['value']() { throw new Error('bad'); } }), 'ok') : first)",
    what: 'an Object enumeration getter: a computed text key',
  },
  ...(
    [
      ['union of null', 'new Set().union(null as never)'],
      ['intersection of undefined', 'new Set().intersection(undefined as never)'],
      ['difference of a number', 'new Set().difference(1 as never)'],
      ['symmetricDifference of text', "new Set().symmetricDifference('x' as never)"],
      ['isSubsetOf of a boolean', 'new Set().isSubsetOf(true as never)'],
      ['isSupersetOf of a bigint', 'new Set().isSupersetOf(1n as never)'],
      ['isDisjointFrom of a symbol', "new Set().isDisjointFrom(Symbol('x') as never)"],
      ['union of no argument', 'new Set().union()'],
      ['union of no set-like fields', 'new Set().union({} as never)'],
      ['union of an array', 'new Set().union([] as never)'],
      ['union of a negative size', 'new Set().union({ size: -1, has() {}, keys() {} })'],
      ['union of a NaN size', 'new Set().union({ size: NaN, has() {}, keys() {} })'],
      ['union of a bigint size', 'new Set().union({ size: 1n, has() {}, keys() {} } as never)'],
      [
        'union of a negative bigint size',
        'new Set().union({ size: -1n, has() {}, keys() {} } as never)',
      ],
      [
        'union of a constructed bigint size',
        'new Set().union({ size: BigInt(1), has() {}, keys() {} } as never)',
      ],
      ['union of a constructed bigint', 'new Set().union(BigInt(1) as never)'],
      ['union of a noncallable has', 'new Set().union({ size: 0, has: 1, keys() {} } as never)'],
      [
        'union of a noncallable keys',
        'new Set().union({ size: 0, has() {}, keys: null } as never)',
      ],
      ['union of missing has', 'new Set().union({ size: 0, keys() {} } as never)'],
      ['union of missing keys', 'new Set().union({ size: 0, has() {} } as never)'],
    ] as const
  ).map(([what, call]) => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of `new Set()',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a Set method argument that is malformed: ${what}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(null',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(null as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(null as never), 'ok') : first)",
    what: 'an Iterator.from input of null in an enclosing comma expression',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(undefined',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(undefined as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(undefined as never), 'ok') : first)",
    what: 'an Iterator.from input of undefined in an enclosing comma expression',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Iterator.from()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(), 'ok') : first)",
    what: 'an Iterator.from input omitted entirely',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(1',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(1 as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(1 as never), 'ok') : first)",
    what: 'an Iterator.from input of a number that iterates nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(true',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(true as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(true as never), 'ok') : first)",
    what: 'an Iterator.from input of a boolean that iterates nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(1n',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(1n as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(1n as never), 'ok') : first)",
    what: 'an Iterator.from input of a bigint that iterates nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Iterator.from(Symbol('x')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Iterator.from(Symbol('x') as never)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (Iterator.from(Symbol('x') as never), 'ok') : first)",
    what: 'an Iterator.from input of a symbol that iterates nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Iterator.from(Symbol.iterator',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Iterator.from(Symbol.iterator as never)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Iterator.from(Symbol.iterator as never), 'ok') : first)",
    what: 'an Iterator.from input of a well-known symbol that iterates nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'globalThis.Iterator.from(missing',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `globalThis.Iterator.from(missing as never)` here, which no JSON holds',
    to: [
      '  const missing = null;',
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (globalThis.Iterator.from(missing as never), 'ok') : first);",
    ].join('\n'),
    what: 'an Iterator.from input of a null constant through globalThis',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({ toJSON',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({ toJSON() { return undefined; } })` here, which no JSON holds',
    to: 'useReactiveState<string>(JSON.stringify({ toJSON() { return undefined; } })!)',
    what: 'a state a site reads, started of what `JSON.stringify` answers of an object whose `toJSON` answers `undefined`, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({ ...{',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({ ...{ toJSON: () => undefined } })` here, which no JSON holds',
    to: 'useReactiveState<string>(JSON.stringify({ ...{ toJSON: () => undefined } })!)',
    what: 'a state a site reads, started of what `JSON.stringify` answers of an object that spreads a `toJSON` answering `undefined`, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'JSON.stringify({ n:',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `JSON.stringify({ n: BigInt(1) })` here, which no JSON holds',
    to: 'useReactiveState<string>(JSON.stringify({ n: BigInt(1) }))',
    what: 'a state a site reads, started of what `JSON.stringify` throws of, an object of an integer of `BigInt`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "['x'].at(1)!",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `['x'].at(1)` here, which no JSON holds",
    to: "useReactiveState<string>(['x'].at(1)!)",
    what: 'a state a site reads, started of the element `at` answers past the end of an array, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].find(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `[first].find((each) => each === 'y')` here, which no JSON holds",
    to: "useReactiveState<string>([first].find((each) => each === 'y')!)",
    what: 'a state a site reads, started of the element `find` answers, which may find none, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '([] as string[]).shift()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `([] as string[]).shift()` here, which no JSON holds',
    to: 'useReactiveState<string>(([] as string[]).shift()!)',
    what: 'a state a site reads, started of what `shift` answers of an empty array, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.codePointAt(5)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `first.codePointAt(5)` here, which no JSON holds',
    to: 'useReactiveState<number>(first.codePointAt(5)!)',
    what: 'a state a site reads, started of the code point `codePointAt` answers of text that may end before it, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].forEach(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[first].forEach(() => first)` here, which no JSON holds',
    to: 'useReactiveState<string>([first].forEach(() => first) as unknown as string)',
    what: 'a state a site reads, started of what `forEach` answers, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'console.log(first)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `console.log(first)` here, which no JSON holds',
    to: 'useReactiveState<string>(console.log(first) as unknown as string)',
    what: 'a state a site reads, started of what `console.log` answers, nothing',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { bytes } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function bytes() {\n  return new URL('https://example.com/x');\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'bytes()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `bytes()` here, which no JSON holds',
    to: 'useReactiveState<number[]>(bytes() as unknown as number[])',
    what: 'a state a site reads, started of what a shared function answers of `new URL(…)`, a `URL`',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "class Payload {\n  id = 'x';\n}\n\nexport function make(value: { id: string } = new Payload()) {\n  return value;\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'make()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `make()` here, which no JSON holds',
    to: 'useReactiveState<{ id: string }>(make())',
    what: 'a state a site reads, started of what a shared function answers of its parameter’s default, given nothing, an object of a class',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { pick } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function pick({ value = new Date(0) }: { value?: unknown } = {}) {\n  return value;\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'pick()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `pick()` here, which no JSON holds',
    to: 'useReactiveState<string>(pick() as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of the default of an element of its parameter’s pattern, a date',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { runOf } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': 'export function runOf(box: { run: unknown }) {\n  return box.run;\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'runOf(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `runOf({ run: () => first })` here, which no JSON holds',
    to: 'useReactiveState<string>(runOf({ run: () => first }) as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of a member of what it is given, a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.keys({})[0]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.keys({})[0]` here, which no JSON holds',
    to: 'useReactiveState<string>(Object.keys({})[0]!)',
    what: 'a state a site reads, started of an element of an array a global’s function computes, which it may lack',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "(first === '' ? [] : ['x'])[0]",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `(first === '' ? [] : ['x'])[0]` here, which no JSON holds",
    to: "useReactiveState<string>((first === '' ? [] : ['x'])[0]!)",
    what: 'a state a site reads, started of an element of either array a condition answers, one of which lacks it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].map(() => () => first)[0]',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[first].map(() => () => first)[0]` here, which no JSON holds',
    to: 'useReactiveState<string>([first].map(() => () => first)[0] as unknown as string)',
    what: 'a state a site reads, started of an element of an array `map` computes of functions',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { listOf } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': 'export function listOf(): string[] {\n  return [];\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'listOf()[0]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `listOf()[0]` here, which no JSON holds',
    to: 'useReactiveState<string>(listOf()[0]!)',
    what: 'a state a site reads, started of an element of an array a shared function answers, which it may lack',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'setSelected);',
    original: KINDS_SOURCE,
    reason: '`setSelected` writes a state, and given to a call as the JSX is built',
    to: "  const [selected, setSelected] = useReactiveState(first);\n  const shown = ['t3'].map(setSelected);",
    what: 'a local state’s setter given to a call as the JSX is built, which may call it then',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'pick);',
    original: KINDS_SOURCE,
    reason: '`pick` writes a state, and given to a call as the JSX is built',
    to: "  const [selected, setSelected] = useReactiveState(first);\n  const pick = (value: string) => setSelected(value);\n  const picked = ['t3'].map(pick);",
    what: 'a function that writes a local state given to a call as the JSX is built, which may call it then',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { lookup } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function lookup() {\n  return new Map<string, string>().get('missing');\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'lookup()!',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `lookup()` here, which no JSON holds',
    to: 'useReactiveState<string>(lookup()!)',
    what: 'a state a site reads, started of what a shared function answers of `get` of a `Map` it makes of no entry of the key, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Map([['a', () => first]])",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Map([['a', () => first]]).get('a')` here, which no JSON holds",
    to: "useReactiveState<string>(new Map([['a', () => first]]).get('a') as unknown as string)",
    what: 'a state a site reads, started of what `get` answers of a `Map` the code makes of entries of a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: "table.get('a') ??",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `table.get('a')` here, which no JSON holds",
    to: "  const table = new Map<string, unknown>();\n  table.set('a', () => first);\n  const [selected, setSelected] = useReactiveState<string>((table.get('a') ?? 'x') as string);",
    what: 'a state a site reads, started of what `get` answers of a constant `Map` of the server part’s the code sets a function in',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { keyOf } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': "export function keyOf() {\n  return Symbol.keyFor(Symbol('x'));\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'keyOf()!',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `keyOf()` here, which no JSON holds',
    to: 'useReactiveState<string>(keyOf()!)',
    what: 'a state a site reads, started of what a shared function answers of `Symbol.keyFor` of a symbol of no key, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "({ id: first }).__lookupGetter__('id')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `({ id: first }).__lookupGetter__('id')` here, which no JSON holds",
    to: "useReactiveState<string>(({ id: first }).__lookupGetter__('id') as unknown as string)",
    what: 'a state a site reads, started of the accessor `__lookupGetter__` answers, nothing of an entry of a value',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.create(null).missing',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.create(null).missing` here, which no JSON holds',
    to: 'useReactiveState<string>(Object.create(null).missing)',
    what: 'a state a site reads, started of an entry of what a global’s function makes that holds none of it, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '([] as number[]).reduce(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `([] as number[]).reduce((a, b) => a + b)` here, which no JSON holds',
    to: 'useReactiveState<number>(([] as number[]).reduce((a, b) => a + b))',
    what: 'a state a site reads, started of what `reduce` of no first value answers of an array of no element, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[1].with(2, 3)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `[1].with(2, 3)` here, which no JSON holds',
    to: 'useReactiveState<number[]>([1].with(2, 3))',
    what: 'a state a site reads, started of what `with` answers of an index past the bounds of the array, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "[,].map(() => 'x')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `[,].map(() => 'x')` here, which no JSON holds",
    to: "useReactiveState<string[]>([,].map(() => 'x'))",
    what: 'a state a site reads, started of what `map` answers of an array of a hole, which it keeps',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array(2).map(() => first)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array(2).map(() => first)` here, which no JSON holds',
    to: 'useReactiveState<string[]>(Array(2).map(() => first))',
    what: 'a state a site reads, started of what `map` answers of an array of holes `Array` makes, which it keeps',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'String.fromCodePoint(0x110000)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `String.fromCodePoint(0x110000)` here, which no JSON holds',
    to: 'useReactiveState<string>(String.fromCodePoint(0x110000))',
    what: 'a state a site reads, started of `String.fromCodePoint` of no code point, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "decodeURIComponent('%')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `decodeURIComponent('%')` here, which no JSON holds",
    to: "useReactiveState<string>(decodeURIComponent('%'))",
    what: 'a state a site reads, started of `decodeURIComponent` of text of no escape, which it throws of',
  },
  ...(
    [
      ['const decode = decodeURIComponent;', "decode('%')"],
      [
        "const decode = globalThis['decodeURIComponent']; const again = decode;",
        "(again as typeof decodeURIComponent)('%')",
      ],
      ['const globals = globalThis; const decode = globals.decodeURIComponent;', "decode('%')"],
      ['const text = String; const make = text.fromCodePoint;', 'make(0x110000)'],
      ['const text = globalThis.String;', "text['fromCodePoint'](0x110000)"],
      ['const supported = Intl.supportedValuesOf;', "supported('bad')"],
      ['const Made = globalThis.RegExp;', "new Made('[')"],
      ['const Made = Uint8Array;', 'new Made(-1)'],
      ['const Make = Map;', 'Make()'],
      ['const methods = Math; const Made = methods.max;', 'new Made()'],
    ] as const
  ).map(([declaration, called]): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: '  const [selected, setSelected] = useReactiveState(first);',
      marker: called,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `  ${declaration}\n  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${called}, 'ok') : first);`,
      what: `an initializer calling a throwing global through a constant alias: ${declaration} ${called}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "'x'.repeat(-1)",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `'x'.repeat(-1)` here, which no JSON holds",
    to: "useReactiveState<string>('x'.repeat(-1))",
    what: 'a state a site reads, started of `repeat` of a count below zero, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(1).toFixed(101)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(1).toFixed(101)` here, which no JSON holds',
    to: 'useReactiveState<string>((1).toFixed(101))',
    what: 'a state a site reads, started of `toFixed` of digits past 100, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(1).toString(1)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `(1).toString(1)` here, which no JSON holds',
    to: 'useReactiveState<string>((1).toString(1))',
    what: 'a state a site reads, started of a number’s `toString` of a radix below 2, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "first.normalize('bad')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `first.normalize('bad')` here, which no JSON holds",
    to: "useReactiveState<string>(first.normalize('bad'))",
    what: 'a state a site reads, started of `normalize` of no form, which it throws of',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { added } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': 'export function added() {\n  return new Set<number>().add(1);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'added() as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `added()` here, which no JSON holds',
    to: 'useReactiveState<number[]>(added() as unknown as number[])',
    what: 'a state a site reads, started of what a shared function answers of `add` of a `Set`, the `Set`',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { joined } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function joined() {\n  return new Set([1]).union(new Set([2]));\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'joined() as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `joined()` here, which no JSON holds',
    to: 'useReactiveState<number[]>(joined() as unknown as number[])',
    what: 'a state a site reads, started of what a shared function answers of `union` of a `Set`, another `Set`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].keys()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `[first].keys().take(1)` here, which no JSON holds',
    to: 'useReactiveState<number[]>([first].keys().take(1) as unknown as number[])',
    what: 'a state a site reads, started of `take` of an iterator, another iterator',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Date(0).setTime',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Date(0).setTime(Infinity)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Date(0).setTime(Infinity) : 0)",
    what: 'a state a site reads, started of what a date’s `setTime` answers of no finite time, `NaN`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date('bad')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date('bad').getFullYear()` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? new Date('bad').getFullYear() : 0)",
    what: 'a state a site reads, started of a part of a date of no time, `NaN`, read in a time zone',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { iter } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function iter() {\n  return Iterator.from([1]).map(() => 1);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'iter()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `iter()` here, which no JSON holds',
    to: 'useReactiveState<number[]>(iter() as unknown as number[])',
    what: 'a state a site reads, started of what a shared function answers of `map` of an iterator, another iterator',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { generated } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'function* gen() {\n  yield 1;\n}\nexport function generated() {\n  return gen().map(() => 1);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'generated()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `generated()` here, which no JSON holds',
    to: 'useReactiveState<number[]>(generated() as unknown as number[])',
    what: 'a state a site reads, started of what a shared function answers of `map` of what a generator answers, an iterator',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { cleared } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': 'export function cleared() {\n  return new Map().clear();\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'cleared()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `cleared()` here, which no JSON holds',
    to: 'useReactiveState<string>(cleared() as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of `clear` of a `Map`, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new RegExp('[')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `new RegExp('[')` here, which no JSON holds",
    to: "useReactiveState<boolean>(first === '' ? new RegExp('[').test('x') : false)",
    what: 'a state a site reads, started of a method of a pattern made of text of none, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array.from',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array.from({ length: Number.MAX_SAFE_INTEGER }, () => 0)` here, which no JSON holds',
    to: "useReactiveState<number[]>(first === '' ? Array.from({ length: Number.MAX_SAFE_INTEGER }, () => 0) : [])",
    what: 'a state a site reads, started of `Array.from` of an array-like of a `length` past what an array holds, which it throws of',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { made } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function made() {\n  const entries: any[] = [null];\n  return Object.fromEntries(entries);\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'made()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `made()` here, which no JSON holds',
    to: 'useReactiveState<Record<string, string>>(made())',
    what: 'a state a site reads, started of what a shared function answers of `Object.fromEntries` of a constant’s entry of no object',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.match',
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `first.match('[')` here, which no JSON holds",
    to: "useReactiveState<boolean>(first.match('[') !== null)",
    what: 'a state a site reads, started of `match` of text of no pattern, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.replaceAll',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `first.replaceAll(/a/, 'b')` here, which no JSON holds",
    to: "useReactiveState<string>(first.replaceAll(/a/, 'b'))",
    what: 'a state a site reads, started of `replaceAll` of a pattern of no `g`, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new URL',
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `new URL('x')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new URL('x').href : first)",
    what: 'a state a site reads, started of a member of a URL made of text of none, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Map',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `new Map([1])` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Map([1]).size : 0)",
    what: 'a state a site reads, started of a member of a `Map` made of an entry of no object, which throws as it is made',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { evaluated } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'const globals = globalThis;\nconst run = globals.eval;\nexport function evaluated(source: string): string {\n  return String(run(source));\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'evaluated(selected)',
    original: KINDS_SOURCE,
    reason: "`evaluated` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={evaluated(selected)}',
    what: 'a site computed of a module that holds the global object under a name of its own, of which it reads `eval` as it loads',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { made } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'const make = (() => 0).constructor;\nexport function made(source: string): string {\n  return String(make(source)());\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'made(selected)',
    original: KINDS_SOURCE,
    reason: "`made` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={made(selected)}',
    what: 'a site computed of a module that reads what made a function, `Function`, as it loads',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { loaded } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function loaded(source: string): string {\n  return String(process.getBuiltinModule(source));\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'loaded(selected)',
    original: KINDS_SOURCE,
    reason: "`loaded` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={loaded(selected)}',
    what: 'a site computed of a module that loads Node’s modules through `process`',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { taken } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'const { process: running } = globalThis;\nexport function taken(source: string): string {\n  return String(running.getBuiltinModule(source));\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'taken(selected)',
    original: KINDS_SOURCE,
    reason: "`taken` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={taken(selected)}',
    what: 'a site computed of a module that takes `process` apart of the global object',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { reflected } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function reflected(source: string): string {\n  return String(Reflect.get(() => 0, 'constructor')) + source;\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'reflected(selected)',
    original: KINDS_SOURCE,
    reason: "`reflected` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={reflected(selected)}',
    what: 'a site computed of a module that reads what made a function by `Reflect.get`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Math.random() > 2 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Math.random()`, of chance or of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module answers of chance',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nlet calls = 0;\nexport function normalizeFilter(value: string): TodoFilter {\n  calls += 1;\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `calls`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a count between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst seen = new Map<string, TodoFilter>();\nexport function normalizeFilter(value: string): TodoFilter {\n  seen.set(value, 'all');\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `seen`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a `Map` it sets between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst clock = new Date(0);\nexport function normalizeFilter(value: string): TodoFilter {\n  clock.setUTCSeconds(clock.getUTCSeconds() + 1);\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `clock`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a date it sets in UTC between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst view = new DataView(new ArrayBuffer(1));\nexport function normalizeFilter(value: string): TodoFilter {\n  view['setUint8'](0, view.getUint8(0) + 1);\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `view`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a `DataView` it writes between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst word = /a/g;\nexport function normalizeFilter(value: string): TodoFilter {\n  return word.test(value) ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `word`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a pattern of `g` it tests with between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst ids = [1, 2].values();\nexport function normalizeFilter(value: string): TodoFilter {\n  ids.next();\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `ids`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps an iterator it advances between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst counts = new Int32Array(1);\nexport function normalizeFilter(value: string): TodoFilter {\n  Atomics.add(counts, 0, 1);\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `counts`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module keeps a typed array `Atomics` adds to between calls',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst counter = { n: 0, bump(): number { return ++this.n; } };\nexport function normalizeFilter(value: string): TodoFilter {\n  return counter.bump() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `counter`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a method of an object it keeps, which writes through `this`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Counter {\n  n = 0;\n  bump(): number {\n    this.n += 1;\n    return this.n;\n  }\n}\nconst counter = new Counter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return counter.bump() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `counter`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a method of what a class makes as it loads, which writes through `this`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Counter {\n  static n = 0;\n  static bump(): number {\n    this.n += 1;\n    return this.n;\n  }\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  return Counter.bump() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `Counter`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a class’s own method, which writes through `this`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst log = {\n  items: [] as string[],\n  note(): void {\n    this.add('x');\n  },\n  add(item: string): void {\n    this.items.push(item);\n  },\n};\nexport function normalizeFilter(value: string): TodoFilter {\n  log.note();\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `log`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a method of an object it keeps, which calls another that changes what `this` holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return typeof document === 'undefined' ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code tests whether `document` is there, which tells where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests whether the page’s `document` is there',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return typeof structuredClone !== 'function' ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code tests whether `structuredClone` is there, which tells where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests whether a global the language does not define is there',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return 'process' in globalThis ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code tests whether the global object holds `process`, which tells where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests whether the global object holds `process`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return globalThis.hasOwnProperty('window') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code tests whether the global object holds `window`, which tells where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests by `hasOwnProperty` what the global object holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return self === globalThis ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `self`, a global of chance, of the time or of where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the global object by a name one side gives it',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return screen.width > 600 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `screen`, a global the browser and the authority may not each hold, or hold alike",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the page’s `screen`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return devicePixelRatio > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `devicePixelRatio`, a global the browser and the authority may not each hold, or hold alike",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads a global of the page the list names not',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Buffer.byteLength(value) > 8 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `Buffer`, a global the browser and the authority may not each hold, or hold alike",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads Node’s `Buffer`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst ref = new WeakRef({});\nexport function normalizeFilter(value: string): TodoFilter {\n  return ref.deref() === undefined ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `WeakRef`, a global of chance, of the time or of where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads a weak reference, which answers as its engine collects',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  Atomics.wait(new Int32Array(4), 0, 0);\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Atomics.wait()`, of chance or of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that waits, which blocks where it runs',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Atomics.isLockFree(8) ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Atomics.isLockFree()`, which each engine answers of its own",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that asks of `Atomics` what each engine answers of its own',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Date(0).toString().includes('GMT+') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a date as text of the time zone where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that writes a date it makes as text',
  },
  {
    beside: {
      'domain/todo-filter.ts': `import type { TodoFilter } from '@/navigation';\nconst EPOCH = new Date(0);\nexport function normalizeFilter(value: string): TodoFilter {\n  return \`\${EPOCH}\`.length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n`,
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a date as text of the time zone where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that writes a date a constant holds in a template',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return String(new Date(value)).startsWith('Thu') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a date as text of the time zone where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes text of a date by `String`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst box = { value: 'all' };\nexport function normalizeFilter(value: string): TodoFilter {\n  const frozen = Object.isFrozen(box);\n  Object.freeze(box);\n  return frozen ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `box`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that freezes an object the module keeps, which it asks of',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst box = { value: 'all' };\nexport function normalizeFilter(value: string): TodoFilter {\n  Reflect.preventExtensions(box);\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `box`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that locks an object the module keeps through `Reflect`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst pick = (value: string): string => value;\nexport function normalizeFilter(value: string): TodoFilter {\n  return pick.toString().includes('=>') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `toString` of a function, which each side's bundle writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the source of a function a constant holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction pick(value: string): string {\n  return value;\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  return String(pick).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a function as text, which each side's bundle writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes text of a function the module declares',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Picker {}\nexport function normalizeFilter(value: string): TodoFilter {\n  return Picker.name === 'Picker' ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `name` of a function, which each side's bundle writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the name of a class the module declares',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction sourceOf(fn: () => string): string {\n  return fn.toString();\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  return sourceOf(() => value).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `toString` of a function, which each side's bundle writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the source of a parameter said to be a function',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction makeCounter() {\n  let n = 0;\n  return () => ++n;\n}\nconst next = makeCounter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return next() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a function the module keeps of a call as it loads, which counts up what the call declared',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction makeCounter() {\n  let n = 0;\n  return { next() { return ++n; } };\n}\nconst counter = makeCounter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return counter.next() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a method of an object the module keeps of a call as it loads, which counts up what the call declared',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction makeCounter() {\n  let n = 0;\n  const bump = () => ++n;\n  return () => bump();\n}\nconst next = makeCounter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return next() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a function the module keeps of a call as it loads, which calls another of the call’s that counts up what it declared',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction makeCounter() {\n  let n = 0;\n  const store: { next?: () => number } = {};\n  store.next = () => ++n;\n  return store;\n}\nconst counter = makeCounter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return (counter.next?.() ?? 0) > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a function a call the module keeps as it loads wrote into the object it answered, which counts up what the call declared',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction makeCounter() {\n  return { n: 0, bump() { this.n += 1; return this.n; } };\n}\nconst counter = makeCounter();\nexport function normalizeFilter(value: string): TodoFilter {\n  return counter.bump() > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `counter`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls a method of an object a function answered as the module loaded, which writes through `this`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst params = new URLSearchParams();\nexport function normalizeFilter(value: string): TodoFilter {\n  params.append('v', value);\n  return params.getAll('v').length > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `params`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that appends to a `URLSearchParams` the module keeps',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst controller = new AbortController();\nexport function normalizeFilter(value: string): TodoFilter {\n  const aborted = controller.signal.aborted;\n  controller.abort();\n  return aborted ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `controller`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that aborts an `AbortController` the module keeps, which it asks of',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst stream = new ReadableStream();\nexport function normalizeFilter(value: string): TodoFilter {\n  const locked = stream.locked;\n  stream.getReader();\n  return locked ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `stream`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that locks a stream the module keeps, which it asks of',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Reflect.construct(Date, []).getTime() > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code holds or hands on `Date`, of which `Date.apply`, `Date.bind`, `Date.call`, `Date.now` the compile reads by their names alone",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes a date of now through `Reflect.construct`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return (Reflect.get(Math, 'random') as () => number)() > 0.5 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code holds or hands on `Math`, of which `Math.random` the compile reads by their names alone",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads `Math.random` through `Reflect.get`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst { random } = Math;\nexport function normalizeFilter(value: string): TodoFilter {\n  return random() > 0.5 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code holds or hands on `Math`, of which `Math.random` the compile reads by their names alone",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls `Math.random` the module takes apart of `Math`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst box = { value: 'all' };\nconst freeze = Object.freeze;\nexport function normalizeFilter(value: string): TodoFilter {\n  const frozen = Object.isFrozen(box);\n  freeze(box);\n  return frozen ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code hands on `Object.freeze`, which the compile reads where it is called alone",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that freezes an object the module keeps by another name of `Object.freeze`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Date.call(null).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Date.call()`, of chance or of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that calls `Date` through `call`, of the time',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Stamp extends Date {}\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Stamp().getTime() > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code holds or hands on `Date`, of which `Date.apply`, `Date.bind`, `Date.call`, `Date.now` the compile reads by their names alone",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes of nothing a class that extends `Date`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new File([], 'x').lastModified > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes a `File` of no `lastModified`, which it takes of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes a `File` of no `lastModified`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Event('x').timeStamp > 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads an event's `timeStamp`, of the time it was made",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the `timeStamp` of an event it makes',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return import.meta.url.length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `import.meta`, of the bundle it runs in",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads `import.meta`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return URL.createObjectURL(new Blob()).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `URL.createObjectURL()`, of chance or of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes a URL of an object',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return (new DOMException('x').stack ?? '').length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the frames a `DOMException` was made in',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst ids = ['active', 'done'].values();\nexport function normalizeFilter(value: string): TodoFilter {\n  const [next] = ids;\n  return next === value ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps an iterator, `ids`, which a function of its advances between calls",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that takes apart an iterator the module keeps',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction* count(): Generator<number> {\n  let n = 0;\n  while (true) {\n    n += 1;\n    yield n;\n  }\n}\nconst counts = count();\nexport function normalizeFilter(value: string): TodoFilter {\n  return [...counts.take(1)][0] === 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps an iterator, `counts`, which a function of its advances between calls",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that takes of a generator the module keeps of a call as it loads',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst word = /a/g;\nexport function normalizeFilter(value: string): TodoFilter {\n  return RegExp.prototype.test.call(word, value) ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `word`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests a pattern of `g` the module keeps through `test` borrowed of `RegExp.prototype`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst seen: string[] = [];\nexport function normalizeFilter(value: string): TodoFilter {\n  Array.prototype.push.call(seen, value);\n  return seen.length > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `seen`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that pushes into an array the module keeps through `push` borrowed of `Array.prototype`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst seen = new Map<string, number>();\nexport function normalizeFilter(value: string): TodoFilter {\n  Reflect.apply(Map.prototype.set, seen, [value, seen.size]);\n  return seen.size > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `seen`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that sets a `Map` the module keeps through `Reflect.apply`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    JSON.parse(value);\n  } catch (error) {\n    return (error as Error).message.includes('JSON') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n  }\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `message` of an error it did not make, whose words each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the message of an error it catches',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    JSON.parse(value);\n  } catch (error) {\n    return String(error).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n  }\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes an error it did not make as text, whose words each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes text of an error it catches',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    JSON.parse(value);\n  } catch ({ message }) {\n    return String(message).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n  }\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `message` of an error it did not make, whose words each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that takes apart the message of an error it catches',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ndeclare namespace Types { type Failure = Error; }\nfunction frames(error: Types.Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `Types`, a global the browser and the authority may not each hold',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 already-refused ambient namespace declaration',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T extends infer Inferred ? Inferred : never;\nfunction frames(error: Wrapped<Error>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 inferred identity error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T extends { value: infer U } ? U : never;\nfunction frames(error: Wrapped<{ value: Error }>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R4 nested inferred error pattern',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst Base = class extends globalThis.Error {}; class Error extends Base {}\nfunction frames(error: Error): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R5 const class error base',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Element<T> = T extends Array<infer U> ? U : never;\nfunction frames(error: Element<Error[]>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R5 named array inferred error',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Unwrap<T> = T extends Promise<infer U> ? U : never; function frames(error: Unwrap<Promise<Error>>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R6 promise inferred error',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Head<T> = T extends [infer H, ...unknown[]] ? H : never; function frames(error: Head<[Error]>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R6 variadic tuple inferred error',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst { Error: Base } = globalThis; class Failure extends Base {} function frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Failure('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: "no shared module of the application's",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R6 existing refusal destructured constructor error',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Bag = { [key: string]: Error }; type Failure = Bag['failure']; function frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R6 index signature selected error',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ndeclare global { type Failure = Error } function frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: "no shared module of the application's",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R6 existing refusal global augmentation error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Take<T> = T extends { error: infer U } ? U : never;\nfunction frames(error: Take<{ error: Error } | { error: { stack: string } }>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter { return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R4 distributive inferred error union',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = globalThis.Error;\nfunction frames(error: Wrapped): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R4 qualified global error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\n\nfunction frames<T extends Error>(error: T): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R4 unbound generic error constraint',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T extends Error ? { stack: string } : Error;\nfunction frames(error: Wrapped<Partial<Error>>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 already-refused partial utility conditional stays guarded',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = Readonly<Error>;\nfunction frames(error: Wrapped): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 property-preserving utility error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T extends string ? Wrapped<Error> : T;\nfunction frames(error: Wrapped<string>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 finite recursive conditional error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = { error: Error; data: { stack: string } }['error'];\nfunction frames(error: Wrapped): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 indexed member error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ninterface Failure {} class Failure extends Error {}\nfunction frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R3 interface merged before error subclass',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction other(Error: unknown) { return Error; } class Failure extends Error {}\nfunction frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Failure('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 unrelated Error parameter does not hide inherited frames',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction other(globalThis: unknown) { return globalThis; } class Failure extends globalThis.Error {}\nfunction frames(error: Failure): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Failure('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason: 'its code reads `stack` of an error',
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 unrelated globalThis parameter does not hide inherited frames',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T extends unknown ? T : never; function frames(error: Wrapped<Error>): string { return error.stack ?? \"\"; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new globalThis.Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 conditional identity error alias',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Error extends globalThis.Error {} function frames(error: Error): string { return error.stack ?? \"\"; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new globalThis.Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 local class inheriting built-in error frames',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction dec(_value: unknown) { return (..._args: unknown[]) => {}; } class Holder { method<Error>(@dec(((error: Error) => error.stack)(new globalThis.Error())) arg: unknown) {} } function frames(error: Error): string { return \"fixed\"; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new globalThis.Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479R2 parameter decorator outside method type parameters',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = Error;\nfunction frames(error: Wrapped): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs \u{2014} its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a shared error type alias on a helper parameter',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Original = TypeError;\ntype Wrapped = (Original | undefined);\nfunction frames(error: Wrapped): string { return error?.['stack'] ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs \u{2014} its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a shared error type alias through a chain and a union',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = Error;\nfunction frames(value: unknown): string { const error: Wrapped = value as Wrapped; return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs \u{2014} its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a shared error type alias on a helper variable',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped = Error;\nfunction frames(error: Wrapped): string { const { stack } = error; return stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs \u{2014} its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a shared error type alias whose frames a helper takes apart',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Maybe<T> = T | undefined; function frames(error: Maybe<Error>): string { return error?.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 generic error alias argument',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Identity<T> = T; type Maybe<T> = Identity<T> | undefined; function frames(error: Maybe<Identity<TypeError>>): string { return error?.['stack'] ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 nested generic error alias arguments',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T = Error> = T; function frames(error: Wrapped): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 default generic error alias argument',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T, U = T> = U; function frames(error: Wrapped<Error>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 dependent default generic error alias argument',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\ntype Wrapped<T> = T & { readonly tag?: string }; function frames(error: Wrapped<Error>): string { return error.stack ?? ''; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 transparent error alias intersection',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nclass Holder { [((error: Error) => error.stack ?? 'frame')(new Error())]<Error>() {} } function frames(error: Error): string { return 'fixed'; }\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'PR479 computed method key outside its generic scope',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction frames(error: Error): string {\n  return error.stack ?? '';\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  return frames(new Error('x')).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the frames of an error it is given, said to be one',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction stamp(date: Date): string {\n  return String(date);\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  return stamp(new Date(0)).startsWith('Thu') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a date as text of the time zone where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes text of a date it is given, said to be one',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nfunction made(): Date {\n  return new Date(0);\n}\nexport function normalizeFilter(value: string): TodoFilter {\n  const date: Date = made();\n  return date.toString().startsWith('Thu') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code writes a date as text of the time zone where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that writes as text a date a variable is said to hold',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Object.hasOwn(globalThis, 'window') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, no shared module of the application's",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that asks `Object.hasOwn` whether the global object holds `window`, handing it on',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Reflect.has(globalThis, 'window') ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, no shared module of the application's",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that asks `Reflect.has` whether the global object holds `window`, handing it on',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst pattern = /a/y;\nexport function normalizeFilter(value: string): TodoFilter {\n  return value.match(pattern) === null ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `pattern`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that matches text by a pattern of `y` and no `g` the module keeps, which moves where it matches from',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst pattern = /a/y;\nexport function normalizeFilter(value: string): TodoFilter {\n  return value.replace(pattern, '') === value ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `pattern`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that replaces in text by a pattern of `y` and no `g` the module keeps',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return WebAssembly.validate(new Uint8Array([0, 97, 115, 109])) ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `WebAssembly`, a global of chance, of the time or of where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that validates `WebAssembly` of the features each engine holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nlet n = 0;\nexport function normalizeFilter(value: string): TodoFilter {\n  [n] = [n + 1];\n  return n > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that counts up a name the module keeps through an array it takes apart',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nlet n = 0;\nexport function normalizeFilter(value: string): TodoFilter {\n  ({ n } = { n: n + 1 });\n  return n > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `n`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that counts up a name the module keeps through an object it takes apart',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nlet current = '';\nexport function normalizeFilter(value: string): TodoFilter {\n  for (current of [value]) {\n    break;\n  }\n  return current === 'x' ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `current`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that loops through a name the module keeps',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst { ['getHours']: hours } = Date.prototype;\nexport function normalizeFilter(value: string): TodoFilter {\n  return hours.call(new Date(0)) > 12 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `getHours`, of the time zone or the locale where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that takes a method of local time apart of `Date.prototype` by a key in brackets',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nlet hours: () => number = () => 0;\n({ getHours: hours } = Date.prototype);\nexport function normalizeFilter(value: string): TodoFilter {\n  return hours() > 12 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `getHours`, of the time zone or the locale where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that assigns a method of local time it takes apart of `Date.prototype`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst writer = new WritableStream().getWriter();\nexport function normalizeFilter(value: string): TodoFilter {\n  const size = writer.desiredSize;\n  if (size !== null && size > 0) {\n    void writer.close();\n  }\n  return size === 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `writer`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that closes a stream’s writer the module keeps, which it asks of',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst { readable } = new TransformStream();\nconst reader = readable.getReader();\nexport function normalizeFilter(value: string): TodoFilter {\n  void reader.cancel();\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `reader`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that cancels a reader of a stream the module takes apart and keeps',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    return new Request(value).url.endsWith('/active') ? 'active' : 'all';\n  } catch {\n    return 'all';\n  }\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes `Request` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes a `Request` of a URL it is given, which a page reads against its document',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    return Response.redirect(value).status === 302 ? 'all' : 'done';\n  } catch {\n    return 'all';\n  }\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes `Response.redirect` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that redirects to a URL it is given, which a page reads against its document',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    new CompressionStream('brotli' as CompressionFormat);\n    return 'done';\n  } catch {\n  return value === 'active' || value === 'done' ? value : 'all';\n  }\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes a `CompressionStream` of a format but `gzip`, `deflate` and `deflate-raw`, which an authority may hold not",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that makes a compression stream of `brotli`, which workerd holds not',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst items: string[] = [];\nconst push = items.push.bind(items);\nexport function normalizeFilter(value: string): TodoFilter {\n  push(value);\n  return items.length > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `items`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that pushes into an array the module keeps through its `push` bound to it',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst items: string[] = [];\nconst push = Array.prototype.push.bind(items);\nexport function normalizeFilter(value: string): TodoFilter {\n  push(value);\n  return items.length > 1 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code keeps what a function of its writes between calls, `items`",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that pushes into an array the module keeps through `Array.prototype.push` bound to it',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return Date.prototype.getHours.call(new Date(value)) > 12 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `getHours`, of the time zone or the locale where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that borrows a date’s getter of local time through `call`',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst { getHours } = Date.prototype;\nexport function normalizeFilter(value: string): TodoFilter {\n  return getHours.call(new Date(0)) > 12 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `getHours`, of the time zone or the locale where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that takes a date’s getter of local time apart of its prototype',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Error().stack === undefined ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the frames of an error it makes',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nconst made = new TypeError('x');\nexport function normalizeFilter(value: string): TodoFilter {\n  return made.stack === undefined ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the frames of an error a constant holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    JSON.parse(value);\n  } catch (error) {\n    return (error as Error).stack === undefined ? 'all' : 'done';\n  }\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads the frames of an error it catches',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Error()['stack'] === undefined ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads in brackets the frames of an error it makes',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  try {\n    JSON.parse(value);\n  } catch (error) {\n    return (error as Error)['stack'] === undefined ? 'all' : 'done';\n  }\n  return value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `stack` of an error, of the frames it was made in, which each engine writes otherwise",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that reads in brackets the frames of an error it catches',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return typeof Error.captureStackTrace === 'function' ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `Error.captureStackTrace`, which one engine alone holds",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function that tests what of `Error` one engine alone holds',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nimport { now } from '@/domain/clock';\nexport function normalizeFilter(value: string): TodoFilter {\n  return now() < 0 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
      'domain/clock.ts': 'export const now = (): number => Date.now();\n',
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — `domain/clock.ts`, which it imports, calls `Date.now()`, of chance or of the time",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module imports one that reads the time',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { stamped } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function stamped(value: string): string {\n  return value + String(Date.now());\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'stamped(selected)',
    original: KINDS_SOURCE,
    reason:
      "`stamped` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Date.now()`, of chance or of the time",
    to: 'id={stamped(selected)}',
    what: 'a site’s element given what a shared function answers of the time',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { lucky } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function lucky(value: string): boolean {\n  return value !== '' && crypto.getRandomValues(new Uint8Array(1))[0] !== 0;\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: "      <TodoCommands projectId={projectId} id={typeof selected === 'string' ? selected : ''} />",
    marker: 'lucky(selected)',
    original: KINDS_SOURCE,
    reason:
      "`lucky` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `crypto`, a global of chance, of the time or of where it runs",
    to: '      {lucky(selected) && <TodoCommands projectId={projectId} id={selected} />}',
    what: 'a condition a site stands under, of what a shared function answers of chance',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { seed } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': 'export function seed(): string {\n  return String(Math.random());\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "selected === 'string'",
    original: KINDS_SOURCE,
    reason:
      "`selected` starts from `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `Math.random()`",
    to: 'useReactiveState(seed())',
    what: 'a state a site reads that the browser starts of what a shared function answers of chance',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new URLSearchParams()',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new URLSearchParams().append('a', 'b')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new URLSearchParams().append('a', 'b') as unknown as string) : first)",
    what: 'a state a site reads, started of `append` of a `URLSearchParams`, which answers nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new AbortController()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new AbortController().abort()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new AbortController().abort() as unknown as string) : first)",
    what: 'a state a site reads, started of `abort` of an `AbortController`, which answers nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new DataView',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new DataView(new ArrayBuffer(1)).setInt8(0, 1)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new DataView(new ArrayBuffer(1)).setInt8(0, 1) as unknown as string) : first)",
    what: 'a state a site reads, started of a setter of a `DataView`, which answers nothing',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { removed } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function removed() {\n  const params = new URLSearchParams('a=1');\n  return params.delete('a');\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'removed()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `removed()` here, which no JSON holds',
    to: 'useReactiveState<string>(removed() as unknown as string)',
    what: 'a state a site reads, started of what a shared function answers of `delete` of a constant’s `URLSearchParams`, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'setTimeout(',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `setTimeout(() => 0, 0)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? (setTimeout(() => 0, 0) as unknown as number) : 0)",
    what: 'a state a site reads, started of what `setTimeout` answers, a timer',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'queueMicrotask(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `queueMicrotask(() => 0)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (queueMicrotask(() => 0) as unknown as string) : first)",
    what: 'a state a site reads, started of what `queueMicrotask` answers, nothing',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { made } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': "export function made(): string {\n  throw new Error('bad');\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'made()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `made()` here, which no JSON holds',
    to: 'useReactiveState<string>(made())',
    what: 'a state a site reads, started of what a shared function answers that throws each time it is called',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { decoded } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function decoded(): string {\n  decodeURIComponent('%');\n  return 'decoded';\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'decoded()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `decoded()` here, which no JSON holds',
    to: 'useReactiveState<string>(decoded())',
    what: 'a state a site reads, started of what a shared function answers whose code throws of what it writes before it returns another value',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { chosen } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function chosen(value: number): string {\n  if (value > 0) {\n    throw new Error('positive');\n  } else {\n    throw new Error('not positive');\n  }\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'chosen()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `chosen()` here, which no JSON holds',
    to: 'useReactiveState<string>(chosen())',
    what: 'a state a site reads, started of what a shared function answers each branch of whose code throws',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].map',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `[first].map(() => { throw new Error('bad'); })` here, which no JSON holds",
    to: "useReactiveState<string[]>(first === '' ? [first].map(() => { throw new Error('bad'); }) : [])",
    what: 'a state a site reads, started of `map` of a function that throws each time it is called',
  },
  {
    beside: {
      'domain/todo-filter.ts':
        "import type { TodoFilter } from '@/navigation';\nexport function normalizeFilter(value: string): TodoFilter {\n  return new Date(value).getHours() > 24 ? 'all' : value === 'active' || value === 'done' ? value : 'all';\n}\n",
    },
    file: 'components/project-workspace.reactive.tsx',
    from: 'const renderedFilter = effectiveFilter;',
    marker: 'renderedFilter} />',
    reason:
      "In `useTodoFilter` (hooks/use-todo-filter.ts): `normalizeFilter` is `@/domain/todo-filter`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `getHours()`, of the time zone or the locale where it runs",
    to: 'const renderedFilter = effectiveFilter;',
    what: 'a hook’s value a site is computed of, of a shared function whose module reads a date’s hour in the time zone where it runs',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { compared } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function compared(value: string): string {\n  return value.localeCompare('m') > 0 ? value : '';\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'compared(selected)',
    original: KINDS_SOURCE,
    reason:
      "`compared` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code calls `localeCompare()`, of the time zone or the locale where it runs",
    to: 'id={compared(selected)}',
    what: 'a site’s element given what a shared function answers of the locale where it runs',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { formatted } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        "export function formatted(value: string): string {\n  return new Intl.NumberFormat('en-US').format(value.length);\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'formatted(selected)',
    original: KINDS_SOURCE,
    reason:
      "`formatted` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code reads `Intl`, a global of chance, of the time or of where it runs",
    to: 'id={formatted(selected)}',
    what: 'a site’s element given what a shared function answers of `Intl`',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { dated } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function dated(value: string): string {\n  return value + new Date(2020, 0, 1).toISOString();\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'dated(selected)',
    original: KINDS_SOURCE,
    reason:
      "`dated` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes `new Date(year, month, …)`, of the time zone where it runs",
    to: 'id={dated(selected)}',
    what: 'a site’s element given what a shared function answers of a date made of its parts in local time',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { dated } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function dated(value: string, ...args: [number, number]): string {\n  return value + new Date(...args).toISOString();\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'dated(selected, 2020, 0)',
    original: KINDS_SOURCE,
    reason:
      "`dated` is `@/domain/helpers`'s, a shared module that answers otherwise each time, or on each side, it runs — its code makes `new Date(...parts)`, which may be of the time, or of the time zone where it runs",
    to: 'id={dated(selected, 2020, 0)}',
    what: 'a site’s element given what a shared function answers of a date made of what a spread hands',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[1][Symbol.iterator]',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `[1][Symbol.iterator]()` here, which no JSON holds',
    to: "useReactiveState<number[]>(first === '' ? ([1][Symbol.iterator]() as unknown as number[]) : [])",
    what: 'a state a site reads, started of a method keyed by `Symbol.iterator`, an iterator',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.keys(null',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Object.keys(null as unknown as object)` here, which no JSON holds',
    to: "useReactiveState<string[]>(first === '' ? Object.keys(null as unknown as object) : [])",
    what: 'a state a site reads, started of `Object.keys` of `null`, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Reflect.ownKeys('x')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `Reflect.ownKeys('x')` here, which no JSON holds",
    to: "useReactiveState<string[]>(first === '' ? (Reflect.ownKeys('x') as string[]) : [])",
    what: 'a state a site reads, started of `Reflect.ownKeys` of text, no object, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '/a/.compile',
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `/a/.compile('b')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (/a/.compile('b') as unknown as string) : first)",
    what: 'a state a site reads, started of `compile` of a pattern, the pattern',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '/a/.compile',
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `/a/.compile('[')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? String(/a/.compile('[')) : first)",
    what: 'a state a site reads, started of what is made of `compile` of text of no pattern, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '/-(a)?/',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `/-(a)?/[Symbol.split]('x-y')` here, which no JSON holds",
    to: "useReactiveState<string[]>(first === '' ? /-(a)?/[Symbol.split]('x-y') : [])",
    what: 'a state a site reads, started of a pattern’s own split of a group that may capture nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new DataView(new ArrayBuffer(1)).getInt32(0)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new DataView(new ArrayBuffer(1)).getInt32(0)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new DataView(new ArrayBuffer(1)).getInt32(0) : 0)",
    what: 'a state a site reads, started of a `DataView`’s read past the bytes it holds, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new DataView(new ArrayBuffer(4), 8)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new DataView(new ArrayBuffer(4), 8)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new DataView(new ArrayBuffer(4), 8).byteLength : 0)",
    what: 'a state a site reads, started of a member of a `DataView` made from past the bytes its buffer holds, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Uint8Array([1]).subarray',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Uint8Array([1]).subarray(0)` here, which no JSON holds',
    to: "useReactiveState<number[]>(first === '' ? (new Uint8Array([1]).subarray(0) as unknown as number[]) : [])",
    what: 'a state a site reads, started of `subarray` of a typed array, another typed array',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Uint8Array([1]).map',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Uint8Array([1]).map(() => 2)` here, which no JSON holds',
    to: "useReactiveState<number[]>(first === '' ? (new Uint8Array([1]).map(() => 2) as unknown as number[]) : [])",
    what: 'a state a site reads, started of `map` of a typed array, another typed array',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Atomics.load',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 1)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 1) : 0)",
    what: 'a state a site reads, started of `Atomics.load` of an index past the elements of a typed array, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Atomics.load',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Atomics.load(new Float64Array(2), 0)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? Atomics.load(new Float64Array(2), 0) : 0)",
    what: 'a state a site reads, started of `Atomics.load` of a typed array of no integers, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Reflect.apply',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Reflect.apply(() => first, null, null as unknown as [])` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? Reflect.apply(() => first, null, null as unknown as []) : first)",
    what: 'a state a site reads, started of `Reflect.apply` of no list of arguments, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Response',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Response(first).text()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Response(first).text() as unknown as string) : first)",
    what: 'a state a site reads, started of the text of a `Response` the code makes, a promise',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Response.json',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Response.json(first).clone().json()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Response.json(first).clone().json() as unknown as string) : first)",
    what: 'a state a site reads, started of the JSON of a copy of a `Response` the code makes, a promise',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Blob',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Blob([first]).arrayBuffer()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Blob([first]).arrayBuffer() as unknown as string) : first)",
    what: 'a state a site reads, started of the bytes of a `Blob` the code makes, a promise',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Response(first).clone()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Response(first).clone()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Response(first).clone() as unknown as string) : first)",
    what: 'a state a site reads, started of `clone` of a `Response` the code makes, another',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Request('https://example.com').clone()",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Request('https://example.com').clone()` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new Request('https://example.com').clone() as unknown as string) : first)",
    what: 'a state a site reads, started of `clone` of a `Request` the code makes, another',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(1).transfer()',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(1).transfer()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new ArrayBuffer(1).transfer() as unknown as string) : first)",
    what: 'a state a site reads, started of `transfer` of a buffer the code makes, another',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(1, {',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(1, { maxByteLength: 2 }).resize(2)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new ArrayBuffer(1, { maxByteLength: 2 }).resize(2) as unknown as string) : first)",
    what: 'a state a site reads, started of `resize` of a buffer the code makes, nothing',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(1).toLocaleString',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `(1).toLocaleString('bad_locale')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (1).toLocaleString('bad_locale') : first)",
    what: 'a state a site reads, started of `toLocaleString` of no language tag, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.localeCompare',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `first.localeCompare('a', 'bad_locale')` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? first.localeCompare('a', 'bad_locale') : 0)",
    what: 'a state a site reads, started of `localeCompare` of no language tag, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Intl.NumberFormat('bad_locale')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Intl.NumberFormat('bad_locale')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Intl.NumberFormat('bad_locale').format(1) : first)",
    what: 'a state a site reads, started of a format of `Intl` of no language tag, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Intl.Locale('bad_locale')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Intl.Locale('bad_locale')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Intl.Locale('bad_locale').baseName : first)",
    what: 'a state a site reads, started of `Intl.Locale` of no language tag, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Intl.getCanonicalLocales(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Intl.getCanonicalLocales(['en', null as unknown as string])` here, which no JSON holds",
    to: "useReactiveState<string[]>(first === '' ? Intl.getCanonicalLocales(['en', null as unknown as string]) : [])",
    what: 'a state a site reads, started of `Intl.getCanonicalLocales` of a list of what is no text, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Atomics.wait(',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)) : first)",
    what: 'a state a site reads, started of `Atomics.wait`, which blocks the thread it runs on',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first].filter(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `[first].filter(() => { throw new Error('bad'); })` here, which no JSON holds",
    to: "useReactiveState<string[]>([first].filter(() => { throw new Error('bad'); }))",
    what: 'a state a site reads, started of `filter` of an element of a function that throws each time it is called',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "[first, 'b', 'c'].toSorted(",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `[first, 'b', 'c'].toSorted(() => decodeURI('%').length)` here, which no JSON holds",
    to: "useReactiveState<string[]>([first, 'b', 'c'].toSorted(() => decodeURI('%').length))",
    what: 'a state a site reads, started of `toSorted` of two known-defined literals and an unknown prop of a comparator that throws of what it computes',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(1).toLocaleString',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `(1).toLocaleString('en-US', { style: 'currency' })` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (1).toLocaleString('en-US', { style: 'currency' }) : first)",
    what: 'a state a site reads, started of `toLocaleString` of a number of options of no shape, a currency of no code',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Intl.NumberFormat('en'",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Intl.NumberFormat('en', { style: 'currency' })` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Intl.NumberFormat('en', { style: 'currency' }).format(1) : first)",
    what: 'a state a site reads, started of a format of `Intl` of options of no shape',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first.localeCompare',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `first.localeCompare('a', 'en', { sensitivity: 'bad' as 'base…` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? first.localeCompare('a', 'en', { sensitivity: 'bad' as 'base' }) : 0)",
    what: 'a state a site reads, started of `localeCompare` of an option of no value it takes',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Intl.DisplayNames('en'",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Intl.DisplayNames('en', {} as Intl.DisplayNamesOptions)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new Intl.DisplayNames('en', {} as Intl.DisplayNamesOptions).of('ja') ?? first) : first)",
    what: 'a state a site reads, started of `Intl.DisplayNames` of no options, which it needs',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(Map as unknown',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `(Map as unknown as () => string)()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Map as unknown as () => string)() : first)",
    what: 'a state a site reads, started of `Map` called without `new`, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(Intl.Segmenter as unknown',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `(Intl.Segmenter as unknown as () => string)()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Intl.Segmenter as unknown as () => string)() : first)",
    what: 'a state a site reads, started of a class of `Intl` called without `new`, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new (Symbol as unknown',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new (Symbol as unknown as new () => string)()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? new (Symbol as unknown as new () => string)() : first)",
    what: 'a state a site reads, started of `new` of `Symbol`, no class, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "atob('!')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `atob('!')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? atob('!') : first)",
    what: 'a state a site reads, started of `atob` of text of no base64, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "btoa('✓')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `btoa('✓')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? btoa('✓') : first)",
    what: 'a state a site reads, started of `btoa` of a character past Latin-1, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new TextDecoder('bad')",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `new TextDecoder('bad')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new TextDecoder('bad').encoding : first)",
    what: 'a state a site reads, started of a `TextDecoder` of a label of no encoding, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Response(null',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Response(null, { status: 99 })` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? new Response(null, { status: 99 }).statusText : first)",
    what: 'a state a site reads, started of a `Response` of a status past those of one, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Headers({ 'bad name'",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Headers({ 'bad name': 'x' })` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new Headers({ 'bad name': 'x' }).get('a') ?? first) : first)",
    what: 'a state a site reads, started of `Headers` of a name of no header, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Intl.supportedValuesOf(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Intl.supportedValuesOf('bad' as 'calendar')` here, which no JSON holds",
    to: "useReactiveState<string[]>(first === '' ? Intl.supportedValuesOf('bad' as 'calendar') : [])",
    what: 'a state a site reads, started of `Intl.supportedValuesOf` of a key of no list of values, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: `\`\${Symbol('x')}\``,
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: `useReactiveState<string>(first === '' ? String.raw\`\${Symbol('x')}\` : first)`,
    what: 'a String.raw tagged template that still coerces a symbol substitution',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: `\`\${Symbol('x')}\``,
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      '  const raw = globalThis.String.raw;',
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? raw\`\${Symbol('x')}\` : first);`,
    ].join('\n'),
    what: 'a String.raw tagged template through a constant still coercing a symbol',
  },
  ...(
    [
      ['null', 'Date.prototype.toJSON.call(null)'],
      ['undefined', 'Date.prototype.toJSON.call(undefined)'],
      ['no receiver', 'Date.prototype.toJSON.call()'],
      ['an empty object', 'Date.prototype.toJSON.call({})'],
      ['a noncallable method', 'Date.prototype.toJSON.call({ toISOString: null })'],
      [
        'a class-valued method',
        'Date.prototype.toJSON.call({ toISOString: class {} } as unknown as Date)',
      ],
      ['a finite number', 'Date.prototype.toJSON.call(1)'],
      ['a symbol', "Date.prototype.toJSON.call(Symbol('x'))"],
      ['an apply null receiver', 'Date.prototype.toJSON.apply(null, [])'],
      ['a reflected undefined receiver', 'Reflect.apply(Date.prototype.toJSON, undefined, [])'],
    ] as const
  ).map(([what, call]) => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a generic Date toJSON receiver: ${what}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: 'Date.prototype.toJSON.call({ toISOString: iso }',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of',
    to: [
      '  const iso = class {};',
      "  const [selected, setSelected] = useReactiveState<string>(first === '' ? (Date.prototype.toJSON.call({ toISOString: iso } as unknown as Date), 'ok') : first);",
    ].join('\n'),
    what: 'a generic Date toJSON receiver: a constant class-valued method',
  },
  ...(
    [
      ['Object numeric prototype', 'Object.setPrototypeOf({}, 1 as never)'],
      ['Reflect numeric prototype', 'Reflect.setPrototypeOf({}, 1 as never)'],
      ['missing prototype', 'Object.setPrototypeOf({})'],
      ['undefined prototype', 'Reflect.setPrototypeOf({}, undefined as never)'],
      ['text prototype', "Object.setPrototypeOf({}, 'x' as never)"],
      ['boolean prototype', 'Reflect.setPrototypeOf({}, true as never)'],
      ['bigint prototype', 'Object.setPrototypeOf({}, 1n as never)'],
      ['symbol prototype', "Reflect.setPrototypeOf({}, Symbol('x') as never)"],
    ] as const
  ).map(([what, call]) => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a prototype argument of no object: ${what}`,
    };
  }),
  ...(
    [
      ['construct an arrow', 'Reflect.construct(() => 1, [])'],
      ['construct an async function', 'Reflect.construct(async function () {}, [])'],
      ['construct a generator', 'Reflect.construct(function* () {}, [])'],
      ['construct an object', 'Reflect.construct({}, [])'],
      ['apply a class', 'Reflect.apply(class {}, null, [])'],
      ['apply an object', 'Reflect.apply({}, null, [])'],
      ['an arrow newTarget', 'Reflect.construct(function () {}, [], () => 1)'],
      ['an async newTarget', 'Reflect.construct(function () {}, [], async function () {})'],
      ['an object newTarget', 'Reflect.construct(function () {}, [], {})'],
      ['an undefined newTarget', 'Reflect.construct(function () {}, [], undefined)'],
    ] as const
  ).map(([what, call]) => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a reflected target of the wrong kind: ${what}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Number(Symbol('x'))",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `Number(Symbol('x'))` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? Number(Symbol('x')) : 0)",
    what: 'a state a site reads, started of `Number` of a symbol, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '+(Symbol.for(',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `+(Symbol.for('x') as unknown as number)` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? +(Symbol.for('x') as unknown as number) : 0)",
    what: 'a state a site reads, started of `+` of a symbol, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: `\`\${first}\${Symbol.iterator`,
    original: KINDS_SOURCE,
    reason: `A state the authority starts is of \`\`\${first}\${Symbol.iterator as unknown as string}\`\` here, which no JSON holds`,
    to: `useReactiveState<string>(first === '' ? \`\${first}\${Symbol.iterator as unknown as string}\` : first)`,
    what: 'a state a site reads, started of a template of a symbol, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: '  const [selected, setSelected] = useReactiveState(first);',
    marker: "structuredClone('x', { transfer: [buffer",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `structuredClone('x', { transfer: [buffer, buffer] })` here, which no JSON holds",
    to: "  const buffer = new ArrayBuffer(1);\n  const [selected, setSelected] = useReactiveState<string>(first === '' ? structuredClone('x', { transfer: [buffer, buffer] }) : first);",
    what: 'a state a site reads, started of `structuredClone` of a transfer list of a buffer twice, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "structuredClone('x', { transfer: ['y'",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `structuredClone('x', { transfer: ['y' as unknown as ArrayBuf…` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? structuredClone('x', { transfer: ['y' as unknown as ArrayBuffer] }) : first)",
    what: 'a state a site reads, started of `structuredClone` of a transfer list of text, which transfers not',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new DataView(new ArrayBuffer(8), 0, -1)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new DataView(new ArrayBuffer(8), 0, -1)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new DataView(new ArrayBuffer(8), 0, -1).byteLength : 0)",
    what: 'a state a site reads, started of a member of a `DataView` made of a length below none, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Int32Array(new ArrayBuffer(8), 2)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Int32Array(new ArrayBuffer(8), 2)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Int32Array(new ArrayBuffer(8), 2).length : 0)",
    what: 'a state a site reads, started of a member of a typed array made over a buffer from an offset of no whole elements, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Int32Array(new ArrayBuffer(8), 0, 3)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Int32Array(new ArrayBuffer(8), 0, 3)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Int32Array(new ArrayBuffer(8), 0, 3).length : 0)",
    what: 'a state a site reads, started of a member of a typed array made over a buffer for more elements than its bytes hold, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Int32Array(new ArrayBuffer(6))',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Int32Array(new ArrayBuffer(6))` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Int32Array(new ArrayBuffer(6)).length : 0)",
    what: 'a state a site reads, started of a member of a typed array made over a buffer of no whole elements, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array(3).fill(0, 1).map((each) => each + 1)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array(3).fill(0, 1).map((each) => each + 1)` here, which no JSON holds',
    to: 'useReactiveState<number[]>(Array(3).fill(0, 1).map((each) => each + 1))',
    what: 'a state a site reads, started of what `map` answers of an array of holes `fill` puts a value at some of the indexes of, which it keeps',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Reflect.defineProperty({}, 'x', { get: 1",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `Reflect.defineProperty({}, 'x', { get: 1",
    to: "useReactiveState<boolean>(first === '' ? Reflect.defineProperty({}, 'x', { get: 1 as unknown as () => number }) : false)",
    what: 'a state a site reads, started of `Reflect.defineProperty` of a descriptor of a getter of no function, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Reflect.defineProperty({}, 'x', { get: () => 1, value: 1 })",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `Reflect.defineProperty({}, 'x', { get: () => 1, value: 1 })` here, which no JSON holds",
    to: "useReactiveState<boolean>(first === '' ? Reflect.defineProperty({}, 'x', { get: () => 1, value: 1 }) : false)",
    what: 'a state a site reads, started of `Reflect.defineProperty` of a descriptor of both a getter and a value, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Object.create(null, { x: 1',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Object.create(null, { x: 1',
    to: "useReactiveState<number>(first === '' ? Object.keys(Object.create(null, { x: 1 as unknown as PropertyDescriptor })).length : 0)",
    what: 'a state a site reads, started of `Object.create` of descriptors of one of no object, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new BigInt64Array([1]',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new BigInt64Array([1] as unknown as bigint[])` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new BigInt64Array([1] as unknown as bigint[]).length : 0)",
    what: 'a state a site reads, started of a member of a typed array of `bigint`s made of an array of a number, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Int32Array([1n]',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Int32Array([1n] as unknown as number[])` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new Int32Array([1n] as unknown as number[]).length : 0)",
    what: 'a state a site reads, started of a member of a typed array of numbers made of an array of a `bigint`, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'BigInt64Array.of(1',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `BigInt64Array.of(1 as unknown as bigint)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? BigInt64Array.of(1 as unknown as bigint).length : 0)",
    what: 'a state a site reads, started of a member of a typed array of `bigint`s `of` a number, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new BigInt64Array(2).fill(1',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new BigInt64Array(2).fill(1 as unknown as bigint)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new BigInt64Array(2).fill(1 as unknown as bigint).length : 0)",
    what: 'a state a site reads, started of a member of a typed array of `bigint`s filled with a number, which throws of it',
  },
  ...[
    'new Uint8Array(1).with(1, 0)',
    'new Uint8Array(1).with(-2, 0)',
    'new Uint8Array(1).with(1.9, 0)',
    'new Uint8Array(1).with(-2.9, 0)',
    'new Uint8Array().with(0, 0)',
    'new Uint8Array([]).with(NaN, 0)',
    'new Uint8Array([0, 0]).with(2, 0)',
    'new Uint16Array(new ArrayBuffer(4)).with(-3, 0)',
    'new BigInt64Array(1).with(1, 0n)',
    "new Uint8Array(1)['with'](1, 0)",
    'new Uint8Array(Number(first)).with(Infinity, 0)',
    'new Uint8Array(Number(first)).with(-Infinity, 0)',
    'new Uint8Array(1).with(0n as unknown as number, 0)',
    'new Uint8Array(1).with(BigInt(0) as unknown as number, 0)',
    "new Uint8Array(1).with(Symbol('index') as unknown as number, 0)",
    'new Uint8Array(1).with(Symbol.iterator as unknown as number, 0)',
    'new Uint8Array(0).with(undefined as unknown as number, 0)',
    'new Uint8Array(0).with(void 0 as unknown as number, 0)',
    'new Uint8Array(0).with(null as unknown as number, 0)',
    'new Uint8Array(0).with(false as unknown as number, 0)',
    'new Uint8Array(1).with(true as unknown as number, 0)',
  ].map((expression): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `a typed array’s with index outside its elements: ${expression}`,
    };
  }),
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Atomics.store(new Int32Array(1), 0, 1n',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Atomics.store(new Int32Array(1), 0, 1n as unknown as number)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? Atomics.store(new Int32Array(1), 0, 1n as unknown as number) : 0)",
    what: 'a state a site reads, started of `Atomics.store` of a `bigint` into a typed array of numbers, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'BigInt.asIntN(-1, 0n)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `BigInt.asIntN(-1, 0n)` here, which no JSON holds',
    to: "useReactiveState<boolean>(first === '' ? BigInt.asIntN(-1, 0n) === 0n : false)",
    what: 'a state a site reads, started of `BigInt.asIntN` of a width below none, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'BigInt.asUintN(8, 1',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `BigInt.asUintN(8, 1 as unknown as bigint)` here, which no JSON holds',
    to: "useReactiveState<boolean>(first === '' ? BigInt.asUintN(8, 1 as unknown as bigint) === 1n : false)",
    what: 'a state a site reads, started of `BigInt.asUintN` of a number, of which it makes no `bigint`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'BigInt(1.5)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `BigInt(1.5)` here, which no JSON holds',
    to: "useReactiveState<boolean>(first === '' ? BigInt(1.5) > 0n : false)",
    what: 'a state a site reads, started of `BigInt` of a number of no integer, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date(0).toLocaleDateString('bad_locale')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date(0).toLocaleDateString('bad_locale')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Date(0).toLocaleDateString('bad_locale') : first)",
    what: 'a state a site reads, started of a date’s text of a locale of no language tag, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date(0).toLocaleString('en-US', { timeZone",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date(0).toLocaleString('en-US', { timeZone: 'Nowhere/Non",
    to: "useReactiveState<string>(first === '' ? new Date(0).toLocaleString('en-US', { timeZone: 'Nowhere/None' }) : first)",
    what: 'a state a site reads, started of a date’s text of options of no time zone, which throws of them',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(8, { maxByteLength: 4 })',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(8, { maxByteLength: 4 })` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new ArrayBuffer(8, { maxByteLength: 4 }).byteLength : 0)",
    what: 'a state a site reads, started of a member of a buffer made of a size past the most bytes it may grow to, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(-1, { maxByteLength: 4 })',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(-1, { maxByteLength: 4 })` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new ArrayBuffer(-1, { maxByteLength: 4 }).byteLength : 0)",
    what: 'a state a site reads, started of a member of a buffer made of a size below none, beside options, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(8, { maxByteLength: 16 }).resize(32)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(8, { maxByteLength: 16 }).resize(32)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? (new ArrayBuffer(8, { maxByteLength: 16 }).resize(32), 0) : 0)",
    what: 'a state a site reads, started of a buffer resized past the most bytes it may grow to, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(8).resize(4)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(8).resize(4)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? (new ArrayBuffer(8).resize(4), 0) : 0)",
    what: 'a state a site reads, started of a buffer of a size it keeps resized, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(4)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(4)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? (new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(4), 0) : 0)",
    what: 'a state a site reads, started of a shared buffer grown to fewer bytes than it holds, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new ArrayBuffer(8).transfer(-1)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new ArrayBuffer(8).transfer(-1)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? new ArrayBuffer(8).transfer(-1).byteLength : 0)",
    what: 'a state a site reads, started of a buffer transferred to a size below none, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Headers().append('bad name', 'x')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Headers().append('bad name', 'x')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new Headers().append('bad name', 'x'), 'ok') : first)",
    what: 'a state a site reads, started of what `append` of a header of no name throws of',
  },
  {
    beside: {
      'domain/appended.ts':
        "export function appended(): string {\n  const headers = new Headers();\n  headers.append('bad name', 'x');\n  return 'ok';\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'appended()',
    original: KINDS_SOURCE.replace(
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { appended } from '@/domain/appended';",
    ),
    reason: 'A state the authority starts is of `appended()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? appended() : first)",
    what: 'a state a site reads, started of a shared function that appends a header of no name to headers it makes, which throws each time',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Headers()['has']('bad name')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Headers()['has']('bad name')` here, which no JSON holds",
    to: "useReactiveState<boolean>(first === '' ? new Headers()['has']('bad name') : false)",
    what: 'a state a site reads, started of `has` of headers called by its name in brackets, of a header of no name, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "'x'['repeat'](-1)",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `'x'['repeat'](-1)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? 'x'['repeat'](-1) : first)",
    what: 'a state a site reads, started of `repeat` of text called by its name in brackets, of a count below none, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date(0)['toLocaleDateString']('bad_locale')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date(0)['toLocaleDateString']('bad_locale')` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Date(0)['toLocaleDateString']('bad_locale') : first)",
    what: 'a state a site reads, started of a date’s text called by its name in brackets, of a locale of no language tag, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new BigInt64Array(2)['fill'](1 as unknown as bigint)",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new BigInt64Array(2)['fill'](1 as unknown as bigint)` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? new BigInt64Array(2)['fill'](1 as unknown as bigint).length : 0)",
    what: 'a state a site reads, started of a typed array of `bigint`s filled by its method’s name in brackets with a number, which throws of it',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Proxy({}, null as unknown as ProxyHandler<object>)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Proxy({}, null as unknown as ProxyHandler<object>)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Proxy({}, null as unknown as ProxyHandler<object>), 'ok') : first)",
    what: 'a state a site reads, started of a `Proxy` made of a handler of no object, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Promise(1 as unknown as () => void)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new Promise(1 as unknown as () => void)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Promise(1 as unknown as () => void), 'ok') : first)",
    what: 'a state a site reads, started of a `Promise` made of no function, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new WeakRef(1 as unknown as object)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new WeakRef(1 as unknown as object)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new WeakRef(1 as unknown as object), 'ok') : first)",
    what: 'a state a site reads, started of a `WeakRef` made of no object, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new FinalizationRegistry(1 as unknown as () => void)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new FinalizationRegistry(1 as unknown as () => void)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new FinalizationRegistry(1 as unknown as () => void), 'ok') : first)",
    what: 'a state a site reads, started of a `FinalizationRegistry` made of no function, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new WeakMap([[1 as unknown as object, 2]])',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new WeakMap([[1 as unknown as object, 2]])` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new WeakMap([[1 as unknown as object, 2]]), 'ok') : first)",
    what: 'a state a site reads, started of a `WeakMap` made of an entry of a key of no object, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new WeakSet([1 as unknown as object])',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `new WeakSet([1 as unknown as object])` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new WeakSet([1 as unknown as object]), 'ok') : first)",
    what: 'a state a site reads, started of a `WeakSet` made of a value of no object, which throws as it is made',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new CompressionStream('brotli' as CompressionFormat)",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new CompressionStream('brotli' as CompressionFormat)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new CompressionStream('brotli' as CompressionFormat), 'ok') : first)",
    what: 'a state a site reads, started of a compression stream of `brotli`, which workerd throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new URLSearchParams(Symbol('x') as unknown as string)",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new URLSearchParams(Symbol('x') as unknown as string)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new URLSearchParams(Symbol('x') as unknown as string), 'ok') : first)",
    what: 'a state a site reads, started of a `URLSearchParams` made of a symbol, which no text is',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Event(Symbol('x') as unknown as string)",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Event(Symbol('x') as unknown as string)` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (new Event(Symbol('x') as unknown as string), 'ok') : first)",
    what: 'a state a site reads, started of an event made of a symbol for its type, which no text is',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new TextEncoder().encode(Symbol('x') as unknown as string)",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new TextEncoder().encode(Symbol('x') as unknown as string)` here, which no JSON holds",
    to: "useReactiveState<number>(first === '' ? new TextEncoder().encode(Symbol('x') as unknown as string).length : 0)",
    what: 'a state a site reads, started of `encode` of a symbol, which no text is',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Array.from([1], 1 as unknown as () => number)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `Array.from([1], 1 as unknown as () => number)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (Array.from([1], 1 as unknown as () => number), 'ok') : first)",
    what: 'a state a site reads, started of `Array.from` given a number to map by, which is no function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[1].map(1 as unknown as () => number)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[1].map(1 as unknown as () => number)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? [1].map(1 as unknown as () => number).length : 0)",
    what: 'a state a site reads, started of `map` given a number to map by, which is no function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[1].forEach(1 as unknown as () => void)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[1].forEach(1 as unknown as () => void)` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? ([1].forEach(1 as unknown as () => void), 'ok') : first)",
    what: 'a state a site reads, started of `forEach` given a number to call, which is no function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[2, 1].sort(1 as unknown as () => number)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[2, 1].sort(1 as unknown as () => number)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? [2, 1].sort(1 as unknown as () => number).length : 0)",
    what: 'a state a site reads, started of `sort` given a number to compare by, which is no function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[1].reduce(1 as unknown as () => number, 0)',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `[1].reduce(1 as unknown as () => number, 0)` here, which no JSON holds',
    to: "useReactiveState<number>(first === '' ? [1].reduce(1 as unknown as () => number, 0) : 0)",
    what: 'a state a site reads, started of `reduce` given a number to reduce by, which is no function',
  },
  {
    beside: {
      'domain/stamped.ts':
        "export function stamped(): string {\n  Date.prototype.getTime.call({} as Date);\n  return 'ok';\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'stamped()',
    original: KINDS_SOURCE.replace(
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { stamped } from '@/domain/stamped';",
    ),
    reason: 'A state the authority starts is of `stamped()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? stamped() : first)",
    what: 'a state a site reads, started of a shared function that borrows a method of `Date.prototype` for an object of no date, which throws each time',
  },
  {
    beside: {
      'domain/sized.ts':
        "export function sized(): string {\n  Reflect.apply(Set.prototype.has, [], [1]);\n  return 'ok';\n}\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'sized()',
    original: KINDS_SOURCE.replace(
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { sized } from '@/domain/sized';",
    ),
    reason: 'A state the authority starts is of `sized()` here, which no JSON holds',
    to: "useReactiveState<string>(first === '' ? sized() : first)",
    what: 'a state a site reads, started of a shared function that borrows a method of `Set.prototype` through `Reflect.apply` for an array, which throws each time',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(() => first).apply',
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `(() => first).apply(null, 'ab' as unknown as [])` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? (() => first).apply(null, 'ab' as unknown as []) : first)",
    what: 'a state a site reads, started of a function’s `apply` of text for its list of arguments, which it throws of',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "new Date('not-a-date')",
    original: KINDS_SOURCE,
    reason:
      "A state the authority starts is of `new Date('not-a-date').toISOString()` here, which no JSON holds",
    to: "useReactiveState<string>(first === '' ? new Date('not-a-date').toISOString() : first)",
    what: 'a state a site reads, started of `toISOString` of a date of no time, which it throws of',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { stamp } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function stamp() {\n  const when = new Date(NaN);\n  return when.toISOString();\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'stamp()',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `stamp()` here, which no JSON holds',
    to: 'useReactiveState<string>(stamp())',
    what: 'a state a site reads, started of what a shared function answers of `toISOString` of a constant’s date of no time',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { run } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'export function run(source: string): string {\n  return String(eval(source));\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'run(selected)',
    original: KINDS_SOURCE,
    reason: "`run` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={run(selected)}',
    what: 'a site computed of a module that makes code of text, `eval`, which would run what a view sends on the authority',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { made } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts':
        'const make = Function;\nexport function made(source: string): string {\n  return String(make(source)());\n}\n',
    },
    file: 'components/kinds.reactive.tsx',
    from: "id={typeof selected === 'string' ? selected : ''}",
    marker: 'made(selected)',
    original: KINDS_SOURCE,
    reason: "`made` is `@/domain/helpers`'s, and is read in JSX the authority renders",
    to: 'id={made(selected)}',
    what: 'a site computed of a module that holds what makes code of text, `Function`',
  },
  {
    beside: { [SHEET]: SHEET_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'export function useFilter(initialFilter: TodoFilter) {',
    marker: 'export function useFilter(initialFilter: string)',
    original: USE_FILTER,
    reason: '`useFilter` is declared over overloads',
    to: [
      'export function useFilter(initialFilter: string): unknown;',
      'export function useFilter(initialFilter: TodoFilter): unknown;',
      'export function useFilter(initialFilter: TodoFilter) {',
    ].join('\n'),
    what: 'a hook declaring a state, declared over overloads',
  },
  {
    also: [
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import TodoCommands from '@/components/todo-commands.reactive';\nimport { pick } from '@/domain/helpers';",
    ],
    beside: {
      'domain/helpers.ts': [
        'export function pick(value: string): string;',
        'export function pick(value: number): Date;',
        'export function pick(value: string | number): string | Date {',
        "  return typeof value === 'string' ? value : new Date(value);",
        '}',
        '',
      ].join('\n'),
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'pick(first)',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `pick(first)` here, which no JSON holds',
    to: 'useReactiveState<string>(pick(first))',
    what: 'a state a site reads, started of what a shared function declared over overloads answers, of any of them',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Error(first) as',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Error(first)` here, which no JSON holds',
    to: 'useReactiveState(Error(first) as unknown as string)',
    what: 'a state a site reads, started of the error a global function answers called without `new`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'globalThis.AbortSignal',
    original: KINDS_SOURCE,
    reason:
      'A state the authority starts is of `globalThis.AbortSignal.timeout(1)` here, which no JSON holds',
    to: "useReactiveState(first === '' ? first : (globalThis.AbortSignal.timeout(1) as unknown as string))",
    what: 'a state a site reads, started of what a global’s function answers, an object of its class, read of the global object',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'string | { id: string }>',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'useReactiveState<string | { id: string }>(first)',
    what: 'a state a site reads, started from a prop, typed of values of more than one kind of JSON',
  },
  {
    also: ['useReactiveState(first)', "useReactiveState(options['initial'])"],
    file: 'components/kinds.reactive.tsx',
    from: 'Kinds({ projectId, first }: { projectId: string; first: string })',
    marker: "options['initial'])",
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'Kinds({ projectId, options }: { projectId: string; options: { initial: string | { id: string } } })',
    what: 'a state a site reads, started from a prop’s member read in brackets, of more than one kind of JSON',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(string | number) & {',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: "useReactiveState<(string | number) & { readonly brand: 'Id' }>(first as never)",
    what: 'a state a site reads typed of a brand’s intersection of more than one kind of JSON',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Selection } from '@/domain/selection';",
    ],
    beside: { 'domain/selection.ts': 'export interface Selection {}\n' },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Selection>(first',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<Selection>(first as Selection)',
    what: 'a state a site reads typed of an empty interface, which text satisfies too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ length: number }>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<{ length: number }>(first)',
    what: 'a state a site reads typed of members text and arrays hold too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ (): string; id: string }>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<{ (): string; id: string }>(first as never)',
    what: 'a state a site reads typed of what is called, a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "run() { return 'x'; } } as",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `run() { return 'x'; }` here, which no JSON holds",
    to: "useReactiveState({ run() { return 'x'; } } as unknown as { run: string })",
    what: 'a state a site reads started of an object of a method, which no JSON holds, its type cast',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "() => 'x' } as",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `() => 'x'` here, which no JSON holds",
    to: "useReactiveState({ run: () => 'x' } as unknown as { run: string })",
    what: 'a state a site reads started of an object holding a function, which no JSON holds, its type cast',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Symbol(), first])',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `Symbol()` here, which no JSON holds',
    to: 'useReactiveState<unknown[]>([Symbol(), first])',
    what: 'a state the authority starts of an array holding a symbol, which no JSON holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Date(), first })',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `new Date()` here, which no JSON holds',
    to: 'useReactiveState<{ when: unknown; first: string }>({ when: new Date(), first })',
    what: 'a state the authority starts of an object holding one a class made, which no JSON holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "run() { return 'x'; } } } as",
    original: KINDS_SOURCE,
    reason: "A state the authority starts is of `run() { return 'x'; }` here, which no JSON holds",
    to: "useReactiveState({ ...{ run() { return 'x'; } } } as unknown as { run: string })",
    what: 'a state a site reads started of what an object spreads of a method, which no JSON holds, its type cast',
  },
  {
    also: [
      '  const [selected, setSelected]',
      '  const bad = 0 / 0;\n  const [selected, setSelected]',
    ],
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '0 / 0;',
    original: KINDS_SOURCE,
    reason: 'A state the authority starts is of `0 / 0` here, which no JSON holds',
    to: 'useReactiveState<number>(bad)',
    what: 'a state a site reads started of a constant of the component’s that is not finite',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Nest } from '@/domain/nest';",
    ],
    beside: { 'domain/nest.ts': 'export type Nest = readonly Nest[];\n' },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]])',
    original: KINDS_SOURCE,
    reason: 'nests more than 64 arrays and objects deep',
    to: 'useReactiveState<Nest>([[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]])',
    what: 'a state a site reads started of arrays nested deeper than JSON may',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ run?: () => void }>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type that admits what no JSON holds inside its values — `() => void`, a function —',
    to: 'useReactiveState<{ run?: () => void }>({})',
    what: 'a state a site reads typed of an object that may hold a function',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; run(): void }>',
    original: KINDS_SOURCE,
    reason: '— `run(): void`, a method, a function —',
    to: 'useReactiveState<{ id: string; run(): void }>(null as never)',
    what: 'a state a site reads typed of an object of a method',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; when: Date }[]>',
    original: KINDS_SOURCE,
    reason:
      "— `Date`, a type of the language's own, which an object of its class satisfies, `new Date()`, `new Number(1)`, or one the compile cannot read —",
    to: 'useReactiveState<{ id: string; when: Date }[]>([])',
    what: 'a state a site reads typed of an array of objects holding a date',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; step: 1 | -1n }>',
    original: KINDS_SOURCE,
    reason: '— `-1n`, an integer of `bigint` —',
    to: 'useReactiveState<{ id: string; step: 1 | -1n }>(null as never)',
    what: 'a state a site reads typed of an object holding a negative integer of `bigint`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; [k: string | symbol]: string }>',
    original: KINDS_SOURCE,
    reason:
      '— `[k: string | symbol]: string`, an entry of a name that may be a symbol, which JSON holds none of —',
    to: 'useReactiveState<{ id: string; [k: string | symbol]: string }>(null as never)',
    what: 'a state a site reads typed of an object of entries a symbol may name',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Number>(0)',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<Number>(0)',
    what: 'a state a site reads typed of the language’s wrapper of numbers, which `new Number(1)` satisfies',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; label: String }>',
    original: KINDS_SOURCE,
    reason: "— `String`, a type of the language's own, which an object of its class satisfies",
    to: 'useReactiveState<{ id: string; label: String }>(null as never)',
    what: 'a state a site reads typed of an object holding the language’s wrapper of text',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Choice } from '@/domain/choice';",
    ],
    beside: { 'domain/choice.ts': 'export enum Choice {\n  Fine = 0,\n  Huge = 1e400,\n}\n' },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Choice>(null as never)',
    original: KINDS_SOURCE,
    reason: '— `Huge = 1e400`, a number no JSON holds, which is not finite —',
    to: 'useReactiveState<Choice>(null as never)',
    what: 'a state a site reads typed of an enum of a number that is not finite',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Box } from '@/domain/box';",
    ],
    beside: { 'domain/box.ts': 'export interface Box<T> {\n  id: string;\n  value: T;\n}\n' },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Box<string>>(null as never)',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<Box<string>>(null as never)',
    what: 'a state a site reads typed of an interface of type parameters, which the compile gives no arguments',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Record<number, string>>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<Record<number, string>>({})',
    what: 'a state a site reads typed of entries numbers name, which text satisfies too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "Pick<{ id: string; name: string }, 'name'>>",
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: "useReactiveState<Pick<{ id: string; name: string }, 'name'>>(null as never)",
    what: 'a state a site reads typed of what a function satisfies of the members it picks',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Partial<{ id: string; length: number }>>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<Partial<{ id: string; length: number }>>({})',
    what: 'a state a site reads typed of members it leaves out beside one text holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '(string | undefined)[]>',
    original: KINDS_SOURCE,
    reason: "— `undefined`, among an array's elements, which JSON holds no `undefined` among —",
    to: 'useReactiveState<(string | undefined)[]>([])',
    what: 'a state a site reads typed of an array that may hold `undefined`',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id: string; owner: { name: string } }>',
    original: KINDS_SOURCE,
    reason: '— `{ name: string }`, which a function satisfies as well —',
    to: 'useReactiveState<{ id: string; owner: { name: string } }>(null as never)',
    what: 'a state a site reads typed of an object holding one of members a function holds too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Record<string, unknown>>',
    original: KINDS_SOURCE,
    reason: '— `unknown`, which holds any value —',
    to: 'useReactiveState<Record<string, unknown>>({})',
    what: 'a state a site reads typed of entries of any value',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ name: string }>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<{ name: string }>(null as never)',
    what: 'a state a site reads typed of members a function holds too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{ id?: string; length?: number }>',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<{ id?: string; length?: number }>({})',
    what: 'a state a site reads typed of members that may be left out beside one text holds',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "{ name: 'x' })",
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads that starts of what the compile cannot read the type of',
    to: "useReactiveState({ name: 'x' })",
    what: 'a state a site reads started of an object TypeScript types of members a function holds too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '[first])',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads that starts of what the compile cannot read the type of',
    to: 'useReactiveState([first])',
    what: 'a state a site reads started of an array of what the compile cannot type',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: "first ?? 't1')",
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads that starts of what the compile cannot read the type of',
    to: "useReactiveState(first ?? 't1')",
    what: 'a state a site reads, started of what the compile cannot type, untyped',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'first: string }',
    marker: 'first);',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'first: string | { id: string } }',
    what: 'a state a site reads, started from a prop of values of more than one kind of JSON',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'string | undefined>',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state a site reads that may hold `undefined`',
    to: 'useReactiveState<string | undefined>(first)',
    what: 'a state a site reads typed of `undefined` too',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'first: string }',
    marker: 'first);',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state a site reads that may hold `undefined`',
    to: 'first?: string }',
    what: 'a state a site reads, started from a prop that may be left out',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Selection } from '@/domain/selection';",
    ],
    beside: { 'domain/selection.ts': SELECTION_SOURCE },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Selection>(first)',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'useReactiveState<Selection>(first)',
    what: 'a state a site reads typed of an alias, imported, of more than one kind of JSON',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Chosen } from '@/domain/types';",
    ],
    beside: {
      'domain/selection.ts': SELECTION_SOURCE,
      'domain/types.ts': "export type { Selection as Chosen } from './selection';\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Chosen>(first)',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'useReactiveState<Chosen>(first)',
    what: 'a state a site reads typed of an alias re-exported under another name',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { ReactNode } from 'react';",
    ],
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'ReactNode>(first)',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<ReactNode>(first)',
    what: 'a state a site reads typed of a package’s type, whose kind the compile cannot tell',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Selection } from '@/domain/selection';",
    ],
    beside: { 'domain/selection.ts': SELECTION_SOURCE },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'first as Selection',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'useReactiveState(first as Selection)',
    what: 'a state a site reads, started of what is cast to an alias of more than one kind of JSON',
  },
  {
    also: [
      "import { useReactiveState } from 'framework/react';",
      "import { useReactiveState } from 'framework/react';\nimport type { Selection } from '@/domain/types';",
    ],
    beside: {
      'domain/other.ts': 'export type Selection = string;\n',
      'domain/types.ts':
        "export * from './other';\nexport type Selection = string | { id: string };\n",
    },
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'Selection>(first)',
    original: KINDS_SOURCE,
    reason: '`selected` declares a state of values of more than one kind of JSON',
    to: 'useReactiveState<Selection>(first)',
    what: 'a state a site reads typed of a module’s own alias, which an `export *` before it does not shadow',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'reads a member of `Object` by a name the compile cannot read',
    to: "const shown = [listed].some((Object as unknown as Record<string, (value: unknown) => boolean>)['is' + 'Frozen']) ? listed : 'all';",
    what: 'a dynamic site of a member of `Object` named by a value, handed on',
  },
  {
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: '{}>(first)',
    original: KINDS_SOURCE,
    reason:
      '`selected` declares a state a site reads of a type whose kind of JSON the compile cannot tell',
    to: 'useReactiveState<{}>(first)',
    what: 'a state a site reads typed `{}`, which holds text as well as objects',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport type { Selection } from '@/domain/selection';",
    ],
    beside: { [SHEET]: SHEET_SOURCE, 'domain/selection.ts': SELECTION_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'useFilter(initialFilter: TodoFilter)',
    marker: 'Selection) {',
    original: USE_FILTER,
    reason: '`initialFilter` declares a state of values of more than one kind of JSON',
    to: 'useFilter(initialFilter: Selection)',
    what: 'a hook’s local state typed of an alias, imported, of more than one kind of JSON',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = {',
      '    initial: initialFilter as unknown,',
      '    map(value: unknown): void {',
      '      this.initial = value;',
      '    },',
      '  };',
      '  options.map(ref.title);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what a method of the server part’s own named `map` wrote into what it is called on',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  [options.initial] = [ref.title];',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part destructured a field into',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  ({ initial: options.initial } = { initial: ref.title });',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part destructured a field into, by an object’s pattern',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  for (options.initial of [ref.title]);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what a loop of the server part wrote a field into',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  (options satisfies { initial: unknown }).initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through `satisfies`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  {',
      '    const alias = options;',
      '    alias.initial = ref.title;',
      '  }',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a constant of a block of it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  let alias: { initial: unknown } = { initial: null };',
      '  alias = options;',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a name it assigned it to',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  let alias: { initial: unknown } | undefined;',
      '  alias ??= options;',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a name it assigned it to by `??=`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const { alias = options } = {} as { alias?: { initial: unknown } };',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a name a pattern takes apart of a default of it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  [undefined].forEach((alias: { initial: unknown } = options) => {',
      '    alias.initial = ref.title;',
      '  });',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a parameter of a default of it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  let alias: { initial: unknown } | undefined;',
      '  ({ alias = options } = {} as { alias?: { initial: unknown } });',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a name an assignment takes apart of a default of it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  let alias: { initial: unknown } | undefined;',
      '  alias ||= options;',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a name it assigned it to by `||=`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const fill = (strings: TemplateStringsArray, ...values: unknown[]): number =>',
      '    strings.length + values.length;',
      `  fill\`\${options}\${ref.title}\`;`,
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed a tagged template, which calls its tag',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { db } from '@/db';\nimport { Number } from '@/domain/factories';",
    ],
    beside: {
      'domain/factories.ts':
        'export function Number(value: unknown): { initial: unknown } {\n  return { initial: value };\n}\n',
      'hooks/use-filter.ts': USE_FILTER,
    },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = Number(initialFilter);',
      '  Object.assign(options, { initial: ref.title });',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote into what a function of a module imported as `Number` answered',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'is async, answering a promise',
    to: 'const shown = [listed].map(async (value) => value)[0];',
    what: 'a dynamic site of what an async function a method is given computes',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`Math.random()` answers of chance',
    to: "const shown = Math.random() > 0.5 ? listed : 'all';",
    what: 'a dynamic site of a value of chance',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'answers of the locale it runs in',
    to: "const shown = listed.toLocaleUpperCase() === 'DONE' ? listed : 'all';",
    what: 'a dynamic site of a value of the locale',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.normalize()` answers of the Unicode data its engine ships',
    to: "const shown = listed.normalize('NFC') === 'done' ? listed : 'all';",
    what: 'a dynamic site of text normalized as its engine’s Unicode data says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.toUpperCase()` answers of the Unicode data its engine ships',
    to: "const shown = listed.toUpperCase() === 'DONE' ? listed : 'all';",
    what: 'a dynamic site of text cased as its engine’s Unicode data says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.trim()` answers of the Unicode data its engine ships',
    to: "const shown = listed.trim() === 'done' ? listed : 'all';",
    what: 'a dynamic site of text trimmed of the spaces its engine’s Unicode data says',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `sharedHelper` here, which no JSON holds",
    to: 'const shown = sharedHelper;',
    what: 'a dynamic site whose element is given a function a shared module exports',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { helper } from '@/domain/index';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "const sharedHelper = (): string => 'x';\n\nexport { sharedHelper };\n",
      'domain/index.ts': "export { sharedHelper as helper } from './helpers';\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `helper` here, which no JSON holds",
    to: 'const shown = helper;',
    what: 'a dynamic site whose element is given a constant of a function a shared module re-exports under another name',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport * as helpers from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `helpers.sharedHelper` here, which no JSON holds",
    to: 'const shown = helpers.sharedHelper;',
    what: 'a dynamic site whose element is given a function a shared module exports, of its namespace',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { helper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        "function fill(): string {\n  return 'x';\n}\n\nexport const helper = fill;\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `helper` here, which no JSON holds",
    to: 'const shown = helper;',
    what: 'a dynamic site whose element is given a constant a shared module exports of a function it names',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { label } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export async function label(text: string): Promise<string> {\n  return text;\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `label(listed)` here, which no JSON holds",
    to: 'const shown = label(listed);',
    what: 'a dynamic site whose element is given what an async function a shared module exports answers, a promise',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { marker } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export const marker = Symbol('marker');\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `marker` here, which no JSON holds",
    to: 'const shown = { [marker]: listed };',
    what: 'a dynamic site whose element is given an object of an entry a symbol a shared module exports keys',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { makeValue } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export function makeValue(_text: string): unknown {\n  return new Date(0);\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `makeValue(listed)` here, which no JSON holds",
    to: 'const shown = makeValue(listed);',
    what: 'a dynamic site whose element is given what a shared function typed to answer `unknown` answers',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { stamp } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export function stamp(text: string) {\n  return { text, when: new Date(0) };\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `stamp(listed)` here, which no JSON holds",
    to: 'const shown = stamp(listed);',
    what: 'a dynamic site whose element is given what a shared function of no type returns, an object of a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'export function make<T>(_value: T): Date {\n  return new Date(0);\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `make(listed)` here, which no JSON holds",
    to: 'const shown = make(listed);',
    what: 'a dynamic site whose element is given what a shared function of a type parameter typed to answer a date answers',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'export const payload = { when: new Date(0) };\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload.when` here, which no JSON holds",
    to: 'const shown = payload.when;',
    what: 'a dynamic site whose element is given an entry of an object a shared module exports, a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport * as helpers from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'const WHEN = new Date(0);\n\nexport const payload = { list: [{ when: WHEN }] };\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `helpers.payload.list[0]['when']` here, which no JSON holds",
    to: "const shown = helpers.payload.list[0]['when'];",
    what: 'a dynamic site whose element is given an entry of an element of an object a shared module’s namespace exports, a constant of a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'const WHEN = new Date(0);\n\nexport const payload = { when: WHEN };\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload` here, which no JSON holds",
    to: 'const shown = payload;',
    what: 'a dynamic site whose element is given an object a shared module exports of a constant of a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { NONE } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'export const NONE = undefined;\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `NONE` here, which no JSON holds",
    to: 'const shown = [NONE];',
    what: 'a dynamic site whose element is given an array of what a shared module exports as `undefined`, which no array of JSON holds',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export const payload = {\n  make(): Date {\n    return new Date(0);\n  },\n};\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `payload.make()` here, which no JSON holds",
    to: 'const shown = payload.make();',
    what: 'a dynamic site whose element is given what a method of an object a shared module exports answers, typed a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { identity } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'export function identity<T>(value: T): T {\n  return value;\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `identity(() => 'x')` here, which no JSON holds",
    to: "const shown = identity(() => 'x');",
    what: 'a dynamic site whose element is given what a shared function answers of its type parameter, given a function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { boxed } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': 'export function boxed(value: unknown) {\n  return { value };\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `boxed(() => 'x')` here, which no JSON holds",
    to: "const shown = boxed(() => 'x');",
    what: 'a dynamic site whose element is given what a shared function of no type returns of its parameter, given a function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `Array.of(sharedHelper)` here, which no JSON holds",
    to: 'const shown = Array.of(sharedHelper);',
    what: 'a dynamic site whose element is given an array a global’s function makes of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[listed].map(() => sharedHelper)` here, which no JSON holds",
    to: 'const shown = [listed].map(() => sharedHelper);',
    what: 'a dynamic site whose element is given an array a value’s method makes of what its function answers, a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper, listed].slice(1, 2).concat(listed)` here, which no JSON holds",
    to: 'const shown = [sharedHelper, listed].slice(1, 2).concat(listed);',
    what: 'a dynamic site whose element is given what value’s methods hold of an array of a shared function',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[listed].values()` here, which no JSON holds",
    to: 'const shown = [listed].values();',
    what: 'a dynamic site whose element is given an iterator of an array',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `Object.values({ listed, missing: undefined })` here, which no JSON holds",
    to: 'const shown = Object.values({ listed, missing: undefined });',
    what: 'a dynamic site whose element is given the values of an object’s entries, `undefined` among them, an array’s elements',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `Object.entries({ listed, ...{ missing: undefined } })` here, which no JSON holds",
    to: 'const shown = Object.entries({ listed, ...{ missing: undefined } });',
    what: 'a dynamic site whose element is given the entries of an object, `undefined` of a spread among their values',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `JSON.parse(JSON.stringify(listed), () => sharedHelper)` here, which no JSON holds",
    to: 'const shown = JSON.parse(JSON.stringify(listed), () => sharedHelper);',
    what: 'a dynamic site whose element is given what `JSON.parse` answers of what its reviver answers, a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { marker } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export const marker = Symbol('group');\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `Object.groupBy([listed], () => marker)` here, which no JSON holds",
    to: 'const shown = Object.groupBy([listed], () => marker);',
    what: 'a dynamic site whose element is given groups keyed by what their function answers, a symbol',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper].reduce(() => 'ok')` here, which no JSON holds",
    to: "const shown = [sharedHelper].reduce(() => 'ok');",
    what: 'a dynamic site whose element is given what `reduce` answers of no first value, an element of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper].pop()` here, which no JSON holds",
    to: 'const shown = [sharedHelper].pop();',
    what: 'a dynamic site whose element is given the element `pop` takes, a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `Object.freeze({ run: sharedHelper })` here, which no JSON holds",
    to: 'const shown = Object.freeze({ run: sharedHelper });',
    what: 'a dynamic site whose element is given the object `Object.freeze` answers, of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export function make() {\n  const value = new Date(0);\n  return value;\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `make()` here, which no JSON holds",
    to: 'const shown = make();',
    what: 'a dynamic site whose element is given what a shared function of no type returns of a constant of its own, a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { stamp } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'const WHEN = new Date(0);\n\nexport function stamp() {\n  return WHEN;\n}\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `stamp()` here, which no JSON holds",
    to: 'const shown = stamp();',
    what: 'a dynamic site whose element is given what a shared function of no type returns of a constant of its module, a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { make } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        "class Payload {\n  id = 'x';\n}\n\nexport function make(): { id: string } {\n  return new Payload();\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `make()` here, which no JSON holds",
    to: 'const shown = make();',
    what: 'a dynamic site whose element is given what a shared function typed of JSON’s shape returns, an object of a class',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        "export const payload = { when: new Date(0), ...{ other: 'x' }, ...null };\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload.when` here, which no JSON holds",
    to: 'const shown = payload.when;',
    what: 'a dynamic site whose element is given an entry of a shared object, past spreads of none of it',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        "const KEY = 'other';\n\nexport const payload = { when: new Date(0), [KEY]: 'x' };\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload.when` here, which no JSON holds",
    to: 'const shown = payload.when;',
    what: 'a dynamic site whose element is given an entry of a shared object, past a key it computes of a constant of other text',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper].map((value) => value)` here, which no JSON holds",
    to: 'const shown = [sharedHelper].map((value) => value);',
    what: 'a dynamic site whose element is given an array of what its function answers of its parameter, an element of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper].map((_value, _index, all) => all)` here, which no JSON holds",
    to: 'const shown = [sharedHelper].map((_value, _index, all) => all);',
    what: 'a dynamic site whose element is given an array of what its function answers of the array it is called on, of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts': "export function sharedHelper(): string {\n  return 'x';\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[{ run: sharedHelper }].map((each) => each.run)` here, which no JSON holds",
    to: 'const shown = [{ run: sharedHelper }].map((each) => each.run);',
    what: 'a dynamic site whose element is given an array of what its function answers of a member of its parameter, a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { identity, sharedHelper } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        "export function sharedHelper(): string {\n  return 'x';\n}\n\nexport function identity<T>(value: T): T {\n  return value;\n}\n",
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `[sharedHelper].map(identity)` here, which no JSON holds",
    to: 'const shown = [sharedHelper].map(identity);',
    what: 'a dynamic site whose element is given an array of what a shared function answers of what `map` hands it, an element of a shared function',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export const payload = {\n  get when(): Date {\n    return new Date(0);\n  },\n};\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload.when` here, which no JSON holds",
    to: 'const shown = payload.when;',
    what: 'a dynamic site whose element is given what a getter of an object a shared module exports answers, typed a date',
  },
  {
    also: [
      "import type { TodoFilter } from '@/navigation';",
      "import type { TodoFilter } from '@/navigation';\nimport { payload } from '@/domain/helpers';",
    ],
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE,
      'domain/helpers.ts':
        'export const payload = {\n  get when() {\n    return new Date(0);\n  },\n  set when(_value) {},\n};\n',
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `payload.when` here, which no JSON holds",
    to: 'const shown = payload.when;',
    what: 'a dynamic site whose element is given what a getter of no type answers, a setter beside it',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.sort(…)` given a comparator orders as each engine',
    to: "const shown = [listed, 'all'].sort(() => 1)[0];",
    what: 'a dynamic site given the first of an array sorted by a comparator, which the engine may choose of',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "What a dynamic site's element is given is of `+bad` here, which no JSON holds",
    to: "const bad = 'x';\n  const shown = +bad;",
    what: 'a dynamic site whose element is given a number of a constant of text, `NaN`',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "What a dynamic site's element is given is of `listed.length / zero` here, which no JSON holds",
    to: 'const zero = 0;\n  const shown = listed.length / zero;',
    what: 'a dynamic site whose element is given what a constant of zero divides, never finite',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`.toLowerCase()` answers of the Unicode data its engine ships',
    to: "const shown = listed.toLowerCase() === 'done' ? listed : 'all';",
    what: 'a dynamic site of text cased down as its engine’s Unicode data says',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'calls what may be no function, `?.(…)`',
    to: "const shown = listed.at?.(0) === 'd' ? listed : 'all';",
    what: 'a dynamic site of a call made optionally',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'calls what may be no function, `?.(…)`',
    to: "const shown = listed?.at?.(0) === 'd' ? listed : 'all';",
    what: 'a dynamic site of a call made optionally after an optional receiver',
  },
  ...['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map((method): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: `new Date(0).${method}('bad_locale')`,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? new Date(0).${method}('bad_locale') : first)`,
      what: `a valid date rejecting malformed locales: ${method}`,
    };
  }),
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        'export function useListed(initialFilter: TodoFilter) {',
        "export function useListed(initialFilter: TodoFilter, fallback: TodoFilter = 'all') {",
      ).replace("? 'done' : 'all';", "? 'done' : fallback;"),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'the parameter `fallback` takes a default',
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes of a parameter’s default',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: '  const { filter, setFilter, listed } = useListed(initialFilter);',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "`filter` starts from the hook's parameter, which the call gives no value of its own",
    to: '  const { filter, setFilter, listed } = useListed();',
    what: 'a dynamic site of what a hook computes of a state its call gives no first value',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        'export function useListed(initialFilter: TodoFilter) {',
        'export function useListed<T extends TodoFilter>(initialFilter: T) {',
      ).replace("? 'done' : 'all';", "? 'done' : ('all' as T);"),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'the type `T` is declared within the hook',
    to: 'const shown = listed;',
    what: 'a dynamic site of what a generic hook computes as its type parameter',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "`typeof filter` is the type of a value of the browser's",
    to: 'const shown = listed as typeof filter;',
    what: 'a dynamic site of a value typed as another of the browser’s',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`shown` is computed of itself',
    to: "const shown = listed === 'done' ? listed : again;\n  const again = shown;",
    what: 'a dynamic site of a constant computed of itself',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: [
      '  const { filter, setFilter, listed } = useListed(initialFilter);',
      '  const shown = listed;',
    ].join('\n'),
    marker: 'shown} />',
    original: LISTING_SOURCE.replace(
      '<button type="button" onClick={() => setFilter(\'done\')}>{filter}</button>',
      '<button type="button">filter</button>',
    ),
    reason: 'holds all `useListed` returns',
    to: ['  const listing = useListed(initialFilter);', '  const shown = listing.listed;'].join(
      '\n',
    ),
    what: 'a dynamic site of what a hook returns, held whole',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        '  return { filter, setFilter, listed };',
        '  return { setFilter, listed };',
      ),
    },
    file: LISTING,
    from: '  const { filter, setFilter, listed } = useListed(initialFilter);',
    marker: 'shown} />',
    original: LISTING_SOURCE.replace('{filter}</button>', 'filter</button>'),
    reason: '`useListed` returns no item that holds its state `filter`',
    to: '  const { setFilter, listed } = useListed(initialFilter);',
    what: 'a dynamic site of what a hook computes of a state it returns not',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        '  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);',
        "  const [filter, setFilter] = useReactiveState<TodoFilter>('all');\n  const started = initialFilter;",
      ),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: '`filter` is a state the hook starts itself, in the browser',
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes of a state it starts itself',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        '  const listed = pick(filter);',
      ).replace(
        'export function useListed',
        "function pick(value: TodoFilter): TodoFilter {\n  return value === 'done' ? 'done' : 'all';\n}\n\nexport function useListed",
      ),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "`pick` is declared by the hook's module for itself",
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes by a function its module declares',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "is a constant of the browser's that holds a function",
    to: 'const shown = () => listed;',
    what: 'a dynamic site of a constant that holds a function',
  },
  {
    beside: { [LISTED_HOOK]: LISTED_HOOK_SOURCE },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: 'is no such value',
    to: 'const shown = new String(listed);',
    what: 'a dynamic site of a value made by `new`',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        "  const listed = filter === 'done' ? 'done' : String(projectId);",
      ),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "`projectId` is a global, which the component's own `projectId` would answer",
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes of a global the component names',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        'export function useListed(initialFilter: TodoFilter) {',
        'export function useListed(initialFilter: TodoFilter, fallback: string) {',
      ).replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        "  const listed = [filter].map((projectId) => (projectId === 'done' ? 'done' : fallback))[0];",
      ),
    },
    file: LISTING,
    from: 'useListed(initialFilter);',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason:
      "`projectId` is the component's own, and what reads it is written in place within code that declares a parameter of the name",
    to: 'useListed(initialFilter, projectId);',
    what: 'a dynamic site of what a hook computes of the component’s name, under its parameter of the name',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        "  const listed = filter === 'done' && Number.isFinite(1) ? 'done' : 'all';",
      ),
    },
    file: LISTING,
    from: '<TodoResults projectId={projectId} filter={shown} />',
    marker: 'shown)[0]',
    original: LISTING_SOURCE,
    reason: "`Number` is a global that what a dynamic site's value is computed of reads",
    to: "<TodoResults projectId={projectId} filter={['x'].map((Number) => shown)[0] ?? shown} />",
    what: 'a dynamic site whose own function takes the name of a global its value is computed of',
  },
  {
    beside: {
      [LISTED_HOOK]: LISTED_HOOK_SOURCE.replace(
        "  const listed = filter === 'done' ? 'done' : 'all';",
        "  const listed = (filter === 'done' ? 'done' : 'all') as Listed;",
      ).replace(
        'export function useListed',
        'type Listed = TodoFilter;\n\nexport function useListed',
      ),
    },
    file: LISTING,
    from: 'const shown = listed;',
    marker: 'shown} />',
    original: LISTING_SOURCE,
    reason: "the type `Listed` is the hook's own",
    to: 'const shown = listed;',
    what: 'a dynamic site of what a hook computes as a type its module declares',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: "setShown('done')",
    original: SHEET_SOURCE,
    reason: 'The setter is called from the handler of an event',
    to: "  const [shown, setShown] = useReactiveState(initialFilter);\n  return <p>{setShown('done')}{filter}{shown}</p>;",
    what: 'a local state’s setter, of a state the authority starts, called while the JSX is built',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: "again('done')",
    original: SHEET_SOURCE,
    reason: '`again` writes a state, so it is called, or handed on, from the handler of an event',
    to: "  const [shown, setShown] = useReactiveState(initialFilter);\n  const again = setShown;\n  return <p>{again('done')}{filter}{shown}</p>;",
    what: 'a local state’s setter, under another name, called while the JSX is built',
  },
  ...[
    {
      declaration: '  const actions = { reset: setSelected };',
      marker: "actions.reset('t2')",
      render: "{actions.reset('t2')}",
      what: 'a container’s local writer called through a property while the JSX is built',
    },
    {
      declaration: '  const actions = [setSelected];',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a container’s local writer called through an index while the JSX is built',
    },
    {
      declaration: '  const actions = { call: setSelected };',
      marker: "actions.call('t2')",
      render: "{actions.call('t2')}",
      what: 'a container’s local writer named call invoked while the JSX is built',
    },
    {
      declaration: '  const actions = { apply: setSelected };',
      marker: "actions.apply('t2')",
      render: "{actions.apply('t2')}",
      what: 'a container’s local writer named apply invoked while the JSX is built',
    },
    {
      declaration: '  const actions = { reset: setSelected };',
      marker: 'actions.reset)',
      render: "{['t2'].map(actions.reset)}",
      what: 'a container’s local writer handed to a call while the JSX is built',
    },
    {
      declaration: '  const actions = { reset: setSelected };',
      marker: 'actions.reset} />',
      render: '<p ref={actions.reset} />',
      what: 'a container’s local writer handed to a committed ref',
    },
    {
      declaration: [
        "  const actions = { reset: () => '', nested: { reset: setSelected } };",
        "  const reset = selected === 't1' ? actions.nested.reset : actions.reset;",
      ].join('\n'),
      marker: "reset('t2')",
      render: "{reset('t2')}",
      what: 'a container’s local writer selected beside a non-writing sibling while the JSX is built',
    },
    {
      declaration: '',
      marker: "({ reset: setSelected }).reset('t2')",
      reason: 'The setter is called',
      render: "{({ reset: setSelected }).reset('t2')}",
      what: 'a container’s local writer called through an inline object while the JSX is built',
    },
    {
      declaration: '',
      marker: "([setSelected][0])('t2')",
      reason: 'The setter is called',
      render: "{([setSelected][0])('t2')}",
      what: 'a container’s local writer called through an inline array while the JSX is built',
    },
    {
      declaration: '  const [, write] = [0, setSelected] as const;',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a destructured local writer from an array called while the JSX is built',
    },
    {
      declaration: '  const { nested: { write } } = { nested: { write: setSelected } };',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a destructured local writer from a nested object called while the JSX is built',
    },
    {
      declaration: '  const [[write]] = [[setSelected]] as const;',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a destructured local writer from nested arrays called while the JSX is built',
    },
    {
      declaration: '  const { nested: [, write] } = { nested: [0, setSelected] as const };',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a destructured local writer from an array in an object called while the JSX is built',
    },
    {
      declaration: '  const [, { write }] = [0, { write: setSelected }] as const;',
      marker: 'write)',
      render: "{['t2'].map(write)}",
      what: 'a destructured local writer from an object in an array handed to a render-time call',
    },
    {
      declaration: '  const [, actions] = [0, { write: setSelected }] as const;',
      marker: "actions.write('t2')",
      render: "{actions.write('t2')}",
      what: 'a destructured local writer from an array’s container member called while the JSX is built',
    },
    {
      declaration:
        "  const { ['nested']: { ['write']: write } } = { nested: { write: setSelected } };",
      marker: 'write} />',
      render: '<p ref={write} />',
      what: 'a destructured local writer from nested computed keys handed to a committed ref',
    },
    {
      declaration: '  const { ...actions } = { write: setSelected };',
      marker: "actions.write('t2')",
      render: "{actions.write('t2')}",
      what: 'a rest-bound local writer copied from an object called while the JSX is built',
    },
    {
      declaration: '  const { ignored, ...actions } = { ignored: 0, write: setSelected };',
      marker: 'actions.write)',
      render: "{['t2'].map(actions.write)}",
      what: 'a rest-bound local writer after an excluded object property handed to a render-time call',
    },
    {
      declaration: '  const [, ...actions] = [0, setSelected] as const;',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a rest-bound local writer copied from an array called while the JSX is built',
    },
    {
      declaration: '  const [, ...[write]] = [0, setSelected] as const;',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a rest-bound local writer from an array’s nested pattern called while the JSX is built',
    },
    {
      declaration:
        '  const { nested: { ignored, ...actions } } = { nested: { ignored: 0, write: setSelected } };',
      marker: 'actions.write} />',
      render: '<p ref={actions.write} />',
      what: 'a rest-bound local writer inside a nested object handed to a committed ref',
    },
    {
      declaration: '  const [, ...[{ write }]] = [0, { write: setSelected }] as const;',
      marker: 'write)',
      render: "{['t2'].map(write)}",
      what: 'a rest-bound local writer from an object inside an array rest handed to a render-time call',
    },
    {
      declaration: '  const [, ...[, ...actions]] = [0, 0, setSelected] as const;',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a rest-bound local writer through two nested array rests called while the JSX is built',
    },
    {
      declaration:
        '  const { ignored, ...kept } = { ignored: 0, write: setSelected };\n  const { ...actions } = kept;',
      marker: "actions.write('t2')",
      render: "{actions.write('t2')}",
      what: 'a rest-bound local writer through two object rests called while the JSX is built',
    },
    {
      declaration: '  const { ...actions } = [setSelected] as const;',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a rest-bound local writer copied from array entries into an object called while the JSX is built',
    },
    {
      declaration: '  const [, ...{ 0: write }] = [0, setSelected] as const;',
      marker: "write('t2')",
      render: "{write('t2')}",
      what: 'a rest-bound local writer selected by an object pattern inside array rest called while the JSX is built',
    },
    {
      declaration: '  const [, ...actions] = [0, ...[setSelected]] as const;',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a rest-bound local writer from a spread after a prefix called while the JSX is built',
    },
    {
      declaration: '  const [, ...actions] = [...[0], ...[setSelected]] as const;',
      marker: "actions[0]('t2')",
      render: "{actions[0]('t2')}",
      what: 'a rest-bound local writer from two source spreads called while the JSX is built',
    },
    ...[
      '  const [write = setSelected] = [];',
      '  const { write = setSelected } = {};',
      '  const { nested: { write = setSelected } = {} } = {};',
      '  const [, { write = setSelected } = {}] = [0] as const;',
      '  const { write = setSelected } = { write: undefined };',
      '  const [, ...[write = setSelected]] = [0] as const;',
    ].map((declaration) => {
      return {
        declaration,
        marker: "write('t2')",
        render: "{write('t2')}",
        what: `a default-bound local writer called while the JSX is built: ${declaration.trim()}`,
      };
    }),
    {
      declaration: [
        '  const reset = (): void => { again(); };',
        "  const again = selected === 't1' ? reset : setSelected;",
      ].join('\n'),
      marker: 'reset()}',
      render: '<button onClick={again} />{reset()}',
      what: 'a cyclic alias’s local writer called while the JSX is built',
    },
    {
      declaration: [
        '  const reset = (): void => { again(); };',
        "  const again = selected === 't1' ? reset : setSelected;",
      ].join('\n'),
      marker: 'reset} />',
      render: '<button onClick={again} /><p ref={reset} />',
      what: 'a cyclic alias’s local writer handed to a committed ref',
    },
  ].map(({ declaration, marker, reason = 'writes a state', render, what }): Refused => {
    return {
      also: ['    <section>', `    <section>${render}`],
      file: 'components/kinds.reactive.tsx',
      from: '  return (',
      marker,
      original: KINDS_SOURCE,
      reason,
      to: `${declaration}\n  return (`,
      what,
    };
  }),
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: "setShown.call(undefined, 'done')",
    original: SHEET_SOURCE,
    reason: 'The setter is called from the handler of an event',
    to: "  const [shown, setShown] = useReactiveState(initialFilter);\n  return <p>{setShown.call(undefined, 'done')}{filter}{shown}</p>;",
    what: 'a local state’s setter called through `.call` while the JSX is built',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);\n  return <p>{filter}</p>;',
    marker: "setFilter('done')",
    original: SHEET_SOURCE,
    reason: 'The setter is called from the handler of an event',
    to: "  const { filter, setFilter } = useFilter(initialFilter);\n  return <p>{setFilter('done')}{filter}</p>;",
    what: 'a hook’s local state’s setter called while the JSX is built',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: 'keep}>',
    original: SHEET_SOURCE,
    reason:
      '`keep` writes a state, and React calls what `ref` is given itself, as the element commits',
    to: [
      '  const [shown, setShown] = useReactiveState(initialFilter);',
      '  const keep = (): void => {',
      "    setShown('done');",
      '  };',
      '  return <p ref={keep}>{filter}{shown}</p>;',
    ].join('\n'),
    what: 'a function that writes a local state given to `ref`, which React calls again on each commit it is a new function on',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: 'keep : undefined}>',
    original: SHEET_SOURCE,
    reason:
      '`keep` writes a state, and React calls what `ref` is given itself, as the element commits',
    to: [
      '  const [shown, setShown] = useReactiveState(initialFilter);',
      '  const keep = (): void => {',
      "    setShown('done');",
      '  };',
      "  return <p ref={shown === 'all' ? keep : undefined}>{filter}{shown}</p>;",
    ].join('\n'),
    what: 'a function that writes a local state given to `ref` as an answer of a condition',
  },
  {
    also: [
      "import { db } from '@/db';",
      "import { useReactiveState } from 'framework/react';\nimport { db } from '@/db';",
    ],
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  return <p>{filter}</p>;',
    marker: 'setShown} />',
    original: SHEET_SOURCE,
    reason:
      '`setShown` writes a state, and React calls what `onLoad` is given itself, as the element commits',
    to: [
      '  const [shown, setShown] = useReactiveState(initialFilter);',
      '  return <p>{filter}{shown}<img alt="" onLoad={setShown} /></p>;',
    ].join('\n'),
    what: 'a local state’s setter given to an event of an element of the browser’s that fires by itself',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  options.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, after a prop',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const fill = (into: { initial: unknown }): void => {',
      '    into.initial = ref.title;',
      '  };',
      '  fill(options);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a function of its own',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const fill = (into: { target: { initial: unknown } }, title: unknown): void => {',
      '    into.target.initial = title;',
      '  };',
      '  fill({ target: options }, ref.title);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a function of its own inside an object',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const fill = (into: () => { initial: unknown }): void => {',
      '    into().initial = ref.title;',
      '  };',
      '  fill(() => options);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a function of its own in a function',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const other = { initial: initialFilter as unknown };',
      "  (id === '' ? other : options).initial = ref.title;",
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a condition',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  [options].forEach((item) => Object.assign(item, { initial: ref.title }));',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a callback’s parameter',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  for (const item of [options]) {',
      '    item.initial = ref.title;',
      '  }',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a loop’s variable',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'initialFilter) => {',
    original: SHEET_SOURCE,
    reason: '`initialFilter` is one of the top-level names of the component',
    to: [
      '  const shadowing = [{ initial: 1 }];',
      '  shadowing.forEach((initialFilter) => {',
      '    initialFilter.initial = 2;',
      '  });',
      '  const { filter } = useFilter(initialFilter);',
    ].join('\n'),
    what: 'a server part’s parameter of a prop’s name, whose writes would be taken for the prop’s',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const fill = (item: { initial: unknown }): void => {',
      '    item.initial = ref.title;',
      '  };',
      '  [options].forEach(fill);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a function of its own an array’s method is given',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const mutate = (item: { initial: unknown }): void => {',
      '    item.initial = ref.title;',
      '  };',
      '  const alias = mutate;',
      '  [options].forEach(alias);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a function an array’s method is given under another name',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const handlers = {',
      '    fill: (item: { initial: unknown }): void => {',
      '      item.initial = ref.title;',
      '    },',
      '  };',
      '  [options].forEach(handlers.fill);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a member function an array’s method is given',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const mutate = (item: { initial: unknown }): void => {',
      '    item.initial = ref.title;',
      '  };',
      '  const alias = mutate;',
      '  Array.from([options], alias);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through what `Array.from` calls under another name',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const run = (fill: (item: { initial: unknown }) => void): void => {',
      '    [options].forEach(fill);',
      '  };',
      '  const keep = (): void => {',
      '    const fill = (entry: { initial: unknown }): unknown => entry;',
      '    run(fill);',
      '  };',
      '  keep();',
      '  run((item) => {',
      '    item.initial = ref.title;',
      '  });',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through a parameter named as a function declared elsewhere',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      "  const method = 'assign';",
      '  (Object as unknown as Record<string, (...given: unknown[]) => void>)[method]?.(options, { initial: ref.title });',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a function of `Object` named by a value',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const String = (into: { initial: unknown }): void => {',
      '    into.initial = ref.title;',
      '  };',
      '  String(options);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a function of its own named `String`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const helper = {',
      '    map: (into: { initial: unknown }, value: unknown): void => {',
      '      into.initial = value;',
      '    },',
      '  };',
      '  helper.map(options, ref.title);',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part handed to a method of its own named `map`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'rest.initial as TodoFilter)',
    original: SHEET_SOURCE.replace(
      'export default function Sheet({ id, initialFilter }: { id: string; initialFilter: TodoFilter }) {',
      'export default function Sheet({ id, initialFilter, options }: { id: string; initialFilter: TodoFilter; options: { readonly initial: string } }) {',
    ),
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const { ...rest } = options;',
      '  Object.assign(rest, { initial: ref.title });',
      '  const { filter } = useFilter(rest.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, a rest element of a prop',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const alias = options;',
      '  alias.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through a constant of it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const all = [options];',
      '  all[0]!.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, through an array that holds it',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      "  Object['assign'](options, { initial: ref.title });",
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into, by a function called by its name in brackets',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'titles[1] as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const titles = [initialFilter as unknown];',
      "  titles['push'](ref.title);",
      '  const { filter } = useFilter(titles[1] as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part pushed a field into, by a method named in brackets',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'titles[1] as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const titles = [initialFilter as unknown];',
      '  [].push.call(titles, ref.title);',
      '  const { filter } = useFilter(titles[1] as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part pushed a field into through `call`',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const list: { initial: unknown }[] = [];',
      '  list.push(options);',
      '  list[0]!.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through an array it pushed it into',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: '  const { filter } = useFilter(initialFilter);',
    marker: 'options.initial as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: [
      '  const options = { initial: initialFilter as unknown };',
      '  const holder: { options?: { initial: unknown } } = {};',
      '  Object.assign(holder, { options });',
      '  holder.options!.initial = ref.title;',
      '  const { filter } = useFilter(options.initial as TodoFilter);',
    ].join('\n'),
    what: 'a hook’s local state given what the server part wrote a field into through an object it assigned it into',
  },
  {
    beside: {
      'components/fielded.reactive.tsx': [
        "import { db } from '@/db';",
        "import { useField } from '@/hooks/use-field';",
        '',
        'export default function Fielded({ id }: { id: string }) {',
        '  const ref = db.todos.ref(id);',
        '  const { value } = useField(ref.title);',
        '  return <p>{value}</p>;',
        '}',
        '',
      ].join('\n'),
    },
    file: 'hooks/use-field.ts',
    from: 'ref: FieldRef<string>',
    marker: 'ref: FieldRef)',
    original: [
      "import { useReactiveState } from 'framework/react';",
      "import type { FieldRef } from '@arkorlab/reactive-state/program';",
      '',
      'export function useField(ref: FieldRef<string>) {',
      '  const [value, setValue] = useReactiveState(ref);',
      '  return { value, setValue };',
      '}',
      '',
    ].join('\n'),
    reason: "is typed `FieldRef` of no value's type",
    to: 'ref: FieldRef',
    what: 'a hook’s state of a field typed `FieldRef` of no value’s type',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: 'useFilter(initialFilter)',
    marker: 'window.location.hash as TodoFilter)',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: 'useFilter(window.location.hash as TodoFilter)',
    what: 'a hook’s local state given a global the browser alone has',
  },
  {
    file: 'components/viewport.reactive.tsx',
    from: 'window.innerWidth',
    marker: 'width)} />',
    original: [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      '',
      'export default function Viewport({ projectId }: { projectId: string }) {',
      '  const [width] = useReactiveState(window.innerWidth);',
      '  return <TodoCommands projectId={projectId} id={String(width)} />;',
      '}',
      '',
    ].join('\n'),
    reason: '`width` starts from `window`, a global the authority has not',
    to: 'window.innerWidth',
    what: 'a state a site reads, started from a global the browser alone has',
  },
  {
    beside: { [SHEET]: SHEET_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'useFilter(initialFilter: TodoFilter)',
    marker: "initialFilter: TodoFilter = 'all')",
    original: USE_FILTER,
    reason: '`initialFilter` declares a state, and takes a default',
    to: "useFilter(initialFilter: TodoFilter = 'all')",
    what: 'a hook’s state of a parameter that takes a default',
  },
  {
    beside: { [SHEET]: SHEET_SOURCE },
    file: 'hooks/use-filter.ts',
    from: 'useFilter(initialFilter: TodoFilter)',
    marker: 'initialFilter?: TodoFilter)',
    original: USE_FILTER,
    reason: '`initialFilter` declares a state, and is optional',
    to: 'useFilter(initialFilter?: TodoFilter)',
    what: 'a hook’s state of a parameter that is optional',
  },
  {
    beside: { 'hooks/use-filter.ts': USE_FILTER },
    file: SHEET,
    from: 'useFilter(initialFilter)',
    marker: 'ref.title',
    original: SHEET_SOURCE,
    reason: '`useFilter` declares a local state with this argument as it is',
    to: 'useFilter(ref.title)',
    what: 'a hook’s local state given a field of the database',
  },
  {
    beside: {
      'components/titled.reactive.tsx': [
        "import { useOuter } from '@/hooks/use-outer';",
        '',
        'export default function Titled({ title }: { title: string }) {',
        '  const { value } = useOuter(title);',
        '  return <p>{value}</p>;',
        '}',
        '',
      ].join('\n'),
      'hooks/use-inner.ts': [
        "import { useReactiveState } from 'framework/react';",
        '',
        'export function useInner(initial: string) {',
        '  const [value, setValue] = useReactiveState(initial);',
        '  return { value, setValue };',
        '}',
        '',
      ].join('\n'),
    },
    file: OUTER,
    from: 'useOuter(title: string)',
    marker: 'title: FieldRef<string>',
    original: OUTER_SOURCE,
    reason:
      '`title` is typed `FieldRef<T>`, a field of the database, and gives it on to a hook that declares a local state of it',
    to: 'useOuter(title: FieldRef<string>)',
    what: 'a field given on to a hook that declares a local state of it',
  },
  {
    also: [
      "import type { ReactNode } from 'react';",
      "import type { ReactNode } from 'react';\nimport Card from '@/components/card.reactive';",
    ],
    beside: CARD,
    file: LAYOUT,
    from: '<h2>{title}</h2>',
    marker: 'header={',
    reason: '`Card` is handed nodes by `header`',
    to: '<Card header={<h2>{title}</h2>} />',
    what: 'an element handed to a reactive component by a prop typed through a type it imports',
  },
  {
    beside: CARD,
    file: WRAPPER,
    from: '<Card header={title} />',
    marker: 'header={children}',
    original: WRAPPER_SOURCE,
    reason: '`Card` is handed nodes by `header`',
    to: '<Card header={children} />',
    what: 'a prop of nodes handed on to a reactive component by a prop it takes as JSON',
  },
  {
    beside: CARD,
    file: WRAPPER,
    from: '<Card header={title} />',
    marker: 'header={heading}',
    original: WRAPPER_SOURCE,
    reason: '`Card` is handed nodes by `header`',
    to: '<Card header={heading} />',
    what: 'a constant of the server part holding an element, handed by a prop taken as JSON',
  },
  {
    beside: CARD,
    file: WRAPPER,
    from: '<Card header={title} />',
    marker: '{...{ header',
    original: WRAPPER_SOURCE,
    reason: '`Card` is handed nodes by a spread',
    to: '<Card {...{ header: children }} />',
    what: 'nodes handed to a reactive component by a spread',
  },
  {
    also: [HOOK_IMPORT, "import { bump } from '@/domain/format';"],
    beside: {
      'domain/format.ts':
        "import { version } from 'react';\nexport function bump(value: number, step: number): number {\n  return value + step + version.length * 0;\n}\n",
    },
    file: EDITOR,
    from: INLINE,
    marker: 'bump(current',
    reason: "`bump` is `@/domain/format`'s, which is no shared module of the application's",
    to: '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const increase = () => setEstimate(current => bump(current, step));',
    what: 'an update that calls a module that is not shared, which the authority and the browser cannot both run',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'title} />',
    reason:
      '`title` starts from what the server part computes — `ref` — which could be a field of the database',
    to: '      <TodoCommands projectId={projectId} id={title} />',
    what: 'a reactive child rendered of a state that starts from what the server part computes',
  },
  {
    also: [COMMANDS, '      <TodoCommands projectId={projectId} id={draft} />'],
    file: EDITOR,
    from: ['  const ref = db.todos.ref(id);', STATES, DRAFT].join('\n'),
    marker: 'draft} />',
    reason: '`draft` starts from `id`, which the server part writes into',
    to: [
      '  id = String(id);',
      '  const ref = db.todos.ref(id);',
      STATES,
      '  const [draft, setDraft] = useReactiveState(id);',
    ].join('\n'),
    what: 'a reactive child rendered of a state that starts from a prop the server part writes into',
  },
  {
    also: [COMMANDS, '      <TodoCommands projectId={projectId} id={draft} />'],
    file: EDITOR,
    from: DRAFT,
    marker: 'draft} />',
    reason: '`draft` starts from what the server part awaits',
    to: '  const [draft, setDraft] = useReactiveState(await id);',
    what: 'a reactive child rendered of a state that starts from what the server part awaits',
  },
  {
    also: [DRAFT, `${DRAFT}\n  const [owner] = useReactiveState(requireUser.name);`],
    file: EDITOR,
    from: COMMANDS,
    marker: 'owner} />',
    reason: "`owner` starts from `@/auth`'s, which is no shared module of the application's",
    to: '      <TodoCommands projectId={projectId} id={owner} />',
    what: 'a reactive child rendered of a state that starts from a module only the authority runs',
  },
  {
    also: OF_DRAFT,
    file: EDITOR,
    from: DRAFT,
    marker: 'draft} />',
    reason: '`draft` starts from a function, which React calls in the browser',
    to: "  const [draft, setDraft] = useReactiveState(() => '');",
    what: 'a reactive child rendered of a state that starts from a function',
  },
  {
    also: OF_DRAFT,
    file: EDITOR,
    from: DRAFT,
    marker: 'draft} />',
    reason: "`draft` starts from `step`, a value of the browser's",
    to: '  const [draft, setDraft] = useReactiveState(String(step));',
    what: 'a reactive child rendered of a state that starts from another state',
  },
  {
    also: OF_DRAFT,
    file: EDITOR,
    from: DRAFT,
    marker: 'draft} />',
    reason:
      "`draft` starts from `@/ui`'s, which is no shared module of the application's — one the authority runs as the browser does",
    to: '  const [draft, setDraft] = useReactiveState(TextInput.name);',
    what: 'a reactive child rendered of a state that starts from a module of the browser’s',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'n => [<TodoCommands',
    reason:
      'or once for each item of a keyed `.map()` — `items.map((item) => <Card key={item.id}>…</Card>)`, whose callback takes the item alone and returns the element it keys — and in no other function of the browser',
    to: '      {[step].flatMap(n => [<TodoCommands key={n} projectId={projectId} id={id} />])}',
    what: 'a reactive child of a state within a function of the browser’s other than a keyed `.map()`’s',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: '<b>{step}</b>',
    reason: 'is rendered at a dynamic site, which the authority renders again',
    to: '      {expanded && <TodoCommands projectId={projectId} id={id}><b>{step}</b></TodoCommands>}',
    what: 'a reactive child at a dynamic site given children',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: '{...{ projectId, id }}',
    reason: 'which the compiler reads prop by prop: a spread hides them',
    to: '      {expanded && <TodoCommands {...{ projectId, id }} />}',
    what: 'a reactive child at a dynamic site given a spread of props',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: '<TodoCommands projectId={projectId} id={title} /> &&',
    reason: '`TodoCommands` is used as a condition — the test of a `?:`, or the left of `&&`',
    to: '      {<TodoCommands projectId={projectId} id={title} /> && <b>x</b>}',
    what: 'a reactive child at a dynamic site used as a condition',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: '<b />',
    reason: 'holds no JSX, which is always true and renders nothing there',
    to: '      {(expanded && <b />) ? <TodoCommands projectId={projectId} id={id} /> : null}',
    what: 'a reactive child at a dynamic site under a condition that holds JSX',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'setStep.name',
    reason:
      '`setStep` is a setter, which the browser holds, and a dynamic site is rendered of values alone',
    to: '      <TodoCommands projectId={projectId} id={setStep.name} />',
    what: 'a reactive child rendered of a setter',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'status} />',
    reason:
      '`completed` starts from what the server part computes — `ref` — which could be a field',
    to: '      <TodoCommands projectId={projectId} id={status} />',
    what: 'a reactive child rendered of a constant the browser computes of a field of the database',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'estimate)} />',
    reason: 'In `useEstimate` (hooks/use-estimate.ts): `estimate` binds a field of the database',
    to: '      <TodoCommands projectId={projectId} id={String(estimate)} />',
    what: 'a reactive child rendered of a custom hook’s field of the database',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: "user.id !== ''",
    reason:
      '`user` is computed in the server part, which the browser never has, and a condition a dynamic site stands under',
    to: "      {user.id !== '' && expanded && <TodoCommands projectId={projectId} id={id} />}",
    what: 'a dynamic site under a condition that reads what the server part computes',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: "status === '完了'",
    reason:
      '`completed` starts from what the server part computes — `ref` — which could be a field',
    to: "      {status === '完了' && <TodoCommands projectId={projectId} id={id} />}",
    what: 'a dynamic site under a condition of a constant the browser computes of a field of the database',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'estimate > 0',
    reason: 'In `useEstimate` (hooks/use-estimate.ts): `estimate` binds a field of the database',
    to: '      {estimate > 0 && <TodoCommands projectId={projectId} id={id} />}',
    what: 'a dynamic site under a condition of a custom hook’s field of the database',
  },
  {
    file: EDITOR,
    from: COMMANDS,
    marker: 'TextInput.length',
    reason:
      "`TextInput` is `@/ui`'s, which is no shared module of the application's — one that runs anywhere alike — and a condition",
    to: '      {TextInput.length > 0 && expanded && <TodoCommands projectId={projectId} id={id} />}',
    what: 'a dynamic site under a condition that reads a module that is not shared',
  },
  {
    file: PANEL,
    from: '      {children}',
    marker: 'open && children',
    original: PANEL_SOURCE,
    reason: '`children` holds nodes the authority renders into a slot whatever the browser holds',
    to: '      {open && children}',
    what: 'the nodes a component is given, under a condition the browser decides',
  },
  {
    file: PANEL,
    from: '      {children}',
    marker: 'children)}',
    original: PANEL_SOURCE,
    reason:
      '`children` holds nodes the authority renders, which the browser shows in a slot, rendered once',
    to: '      {[open].map(() => children)}',
    what: 'the nodes a component is given, within a function of the browser’s',
  },
  {
    file: PANEL,
    from: '  const [open, setOpen] = useReactiveState(true);',
    marker: 'children;',
    original: PANEL_SOURCE,
    reason: 'in a slot, and reads nowhere else: a constant, or any other code of the browser',
    to: '  const [open, setOpen] = useReactiveState(true);\n  const shown = children;',
    what: 'the nodes a component is given, read by a constant of the browser’s',
  },
  {
    file: PANEL,
    from: 'useReactiveState(true)',
    marker: 'children !== null',
    original: PANEL_SOURCE,
    reason: '`children` holds nodes the authority renders, and a state holds JSON',
    to: 'useReactiveState(children !== null)',
    what: 'the nodes a component is given, read by what a state starts from',
  },
  {
    file: PANEL,
    from: '      <TodoCommands projectId={projectId} id="t1" />',
    marker: 'children} />',
    original: PANEL_SOURCE,
    reason: '`children` holds nodes the authority renders once for the component',
    to: '      <TodoCommands projectId={projectId} id={String(open)} header={children} />',
    what: 'the nodes a component is given, as a prop of a reactive child at a dynamic site',
  },
  {
    file: PANEL,
    from: '      <TodoCommands projectId={projectId} id="t1" />',
    marker: 'children && open',
    original: PANEL_SOURCE,
    reason: '`children` holds nodes the authority renders once for the component',
    to: '      {children && open ? <TodoCommands projectId={projectId} id="t1" /> : null}',
    what: 'the nodes a component is given, read by a condition a dynamic site stands under',
  },
  {
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: 'sites =',
    reason: "`sites` is a name the compile's outputs read within the component's code",
    to: "  const status = completed ? '完了' : '未完了';\n  const sites = status;",
    what: '`sites`, which the Client Component shows its dynamic sites by',
  },
  {
    file: EDITOR,
    from: "import { TextInput, Checkbox } from '@/ui';",
    marker: 'useSites }',
    reason: '`useSites` is a name an output declares itself',
    to: "import { TextInput, Checkbox, useSites } from '@/ui';",
    what: '`useSites` imported, which the Client Component imports itself',
  },
  {
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: 'TodoCommands projectId={projectId} id={id} />;',
    reason: 'is a reactive component, which renders in the JSX the component returns',
    to: "  const status = completed ? '完了' : '未完了';\n  const commands = <TodoCommands projectId={projectId} id={id} />;",
    what: 'a reactive element in a constant of the browser’s, where no slot holds it',
  },
  {
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: 'user.id',
    reason: '`user` is computed in the server part, on the authority; the browser never has it',
    to: '<p>{user.id}</p>',
    what: 'a value of the server part read by the browser',
  },
  {
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: "db.todos ? '' : '?'",
    reason: "`db` is `@/db`'s, a module only the authority runs",
    to: "<p>{db.todos ? '' : '?'}</p>",
    what: 'a module only the authority runs, read by the browser',
  },
  {
    also: [
      HOOK_IMPORT,
      `import { b } from '@/lib/b';\nimport { a } from '@/lib/a';\n${HOOK_IMPORT}`,
    ],
    beside: {
      'lib/a.ts': "import { b } from './b';\nexport function a(): string {\n  return b();\n}\n",
      'lib/b.ts':
        "import { db } from '@/db';\nimport { a } from './a';\nexport function b(): string {\n  return typeof db + typeof a;\n}\n",
    },
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: 'a()}',
    reason: "`a` is `@/lib/a`'s, a module only the authority runs",
    to: '<p>{status}{a()}</p>',
    what: 'a module that imports one only the authority runs through a cycle, read by the browser',
  },
  {
    file: LAYOUT,
    from: '<h2>{title}</h2>',
    marker: '() => undefined',
    reason: 'What the authority renders is data, which holds no function',
    to: '<h2 onClick={() => undefined}>{title}</h2>',
    what: 'a function given to an element the authority renders',
  },
  {
    file: CONTENT,
    from: '<ProjectLayout title={access.project.title}>',
    marker: 'requireUser.name',
    reason: "`requireUser` is `@/auth`'s, and is read in JSX the authority renders",
    to: '<ProjectLayout title={requireUser.name}>',
    what: 'a module only the authority runs, read in the JSX it renders, which reads shared modules alone',
  },
  {
    file: 'components/project-commands.reactive.tsx',
    from: '  await assertCanEditProject(user, projectId);',
    marker: 'createTodo(projectId',
    reason: "is a server operation, which a person's action runs, not a render",
    to: '  await assertCanEditProject(user, projectId);\n  await createTodo(projectId, new FormData());',
    what: 'a server operation called as the authority renders',
  },
  {
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: "setTitle('x')",
    reason: "The setter is called from the handler of an event a person's action dispatches",
    to: "<p>{setTitle('x')}</p>",
    what: 'a setter called as the JSX is built',
  },
  {
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: 'setTitle} aria-label="raw"',
    reason: 'handed as it is to such an attribute of a component',
    to: '<p>{status}</p>\n      <input onChange={setTitle} aria-label="raw" />',
    what: 'a setter handed to an element of the browser’s, which would write the event',
  },
  {
    file: EDITOR,
    from: '<p>{status}</p>',
    marker: 'increase()',
    reason:
      '`increase` writes a state, so it is called, or handed on, from the handler of an event',
    to: '<p>{status}{increase()}</p>',
    what: 'a hook’s function that writes, called as the JSX is built',
  },
  {
    // `again` writes only through `close`, which calls it back: what it reaches, it writes, whichever
    // of the two is read first.
    also: ['<p>{status}</p>', '<p>{status}{again(1)}</p>'],
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: 'again(1)',
    reason: '`again` writes a state, so it is called, or handed on, from the handler of an event',
    to: "  const status = completed ? '完了' : '未完了';\n  const again = (n: number): void => {\n    if (n > 0) {\n      close(n - 1);\n    }\n  };\n  const close = (n: number): void => {\n    setCompleted(false);\n    again(n);\n  };",
    what: 'a function that writes through one that calls it back, called as the JSX is built',
  },
  {
    file: EDITOR,
    from: 'useEstimate(ref.estimate, step)',
    marker: 'step, step)',
    reason:
      '`useEstimate` declares a state with this argument as it is, which the authority evaluates',
    to: 'useEstimate(step, step)',
    what: 'a hook’s state given a value of the browser’s, which the authority cannot evaluate',
  },
  {
    file: EDITOR,
    from: "import { TextInput, Checkbox } from '@/ui';",
    marker: "'./ui'",
    reason:
      '`./ui` is a relative path, which names another module from where the outputs are written',
    to: "import { TextInput, Checkbox } from './ui';",
    what: 'a relative path, which names another module from where the outputs are written',
  },
  {
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: "import('@/ui')",
    reason: 'imports nothing at run time',
    to: "  const status = completed ? '完了' : '未完了';\n  const later = import('@/ui');",
    what: 'an import made at run time',
  },
  {
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: "require('@/ui')",
    reason: "`require` is CommonJS's",
    to: "  const status = completed ? '完了' : '未完了';\n  const later = require('@/ui');",
    what: 'CommonJS’s `require`',
  },
  {
    file: EDITOR,
    from: "  const status = completed ? '完了' : '未完了';",
    marker: '@track',
    reason: 'After the state, the component decorates nothing',
    to: "  const status = completed ? '完了' : '未完了';\n  const Panel = class {\n    @track\n    method(open: boolean) {\n      return open;\n    }\n  };",
    what: 'a decorator after the state, which is evaluated outside what it decorates',
  },
  {
    file: EDITOR,
    from: 'onChange={event => setStep(Number(event.currentTarget.value))}',
    marker: 'title => setStep',
    reason: '`title` is one of the top-level names of the component',
    to: 'onChange={title => setStep(Number(title.currentTarget.value))}',
    what: 'a top-level name declared again inside the component',
  },
  {
    file: EDITOR,
    from: '  const user = await requireUser();',
    marker: '$ = 1',
    reason: "`$` is what the authority's program renders with",
    to: '  const user = await requireUser();\n  const $ = 1;',
    what: '`$`, which the authority’s program renders with',
  },
  {
    file: EDITOR,
    from: "  const [draft, setDraft] = useReactiveState('');",
    marker: '__proto__]',
    reason: "`__proto__` is a name the compile's outputs read within the component's code",
    to: "  const [draft, setDraft] = useReactiveState('');\n  const [__proto__] = useReactiveState(0);",
    what: '`__proto__` as the name of a state',
  },
  {
    file: EDITOR,
    from: "import { TextInput, Checkbox } from '@/ui';",
    marker: 'TextInput aria-label',
    reason: '`TextInput` is imported as a type, which has no value at run time',
    to: "import { type TextInput, Checkbox } from '@/ui';",
    what: 'a value imported as a type alone',
  },
  {
    file: EDITOR,
    from: '  const ref = db.todos.ref(id);',
    marker: 'TextInput.name',
    reason: 'which the authority renders by reference, as an element',
    to: '  const ref = db.todos.ref(id);\n  const label = TextInput.name;',
    what: "a `'use client'` module’s value read by the server part",
  },
  {
    also: ADD_ESTIMATE,
    file: EDITOR,
    from: INLINE,
    marker: 'stepped))',
    reason: '`stepped` is captured by an update, which the authority types by the value',
    to: '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const stepped = Number(step);\n  const increase = () => setEstimate(current => addEstimate(current, stepped));',
    what: 'a captured value whose type the compiler cannot write',
  },
  {
    also: ADD_ESTIMATE,
    file: EDITOR,
    from: INLINE,
    marker: 'twice))',
    reason: '`twice` is a function, which an update does not capture',
    to: '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const twice = (value: number): number => value * 2;\n  const increase = () => setEstimate(current => addEstimate(current, twice));',
    what: 'a function captured by an update',
  },
  {
    also: ADD_ESTIMATE,
    file: EDITOR,
    from: INLINE,
    marker: '(current, more)',
    reason: 'An update is a function of the current value alone',
    to: '  const [estimate, setEstimate] = useReactiveState(ref.estimate);\n  const increase = () => setEstimate((current, more) => addEstimate(current, step));',
    what: 'an update of two parameters',
  },
  {
    file: LAYOUT,
    from: '<h2>{title}</h2>',
    marker: '{...title}',
    reason: 'JSX spreads no children',
    to: '<h2>{...title}</h2>',
    what: 'a spread of children, which React has none of',
  },
  {
    file: LAYOUT,
    from: '<h2>{title}</h2>',
    marker: 'children={title',
    reason: 'is given its children between its tags',
    to: '<h2 children={title} />',
    what: '`children` given as an attribute to what the authority renders',
  },
  {
    file: HOOK,
    from: '  const [estimate, setEstimate] = useReactiveState(ref);',
    marker: 'ref, step',
    reason: '`ref` declares a state as it is',
    to: '  const [estimate, setEstimate] = useReactiveState(ref);\n  const both = [ref, step];',
    what: 'a hook’s parameter that declares a state, read again',
  },
  {
    file: HOOK,
    from: "import { addEstimate } from '@/domain/estimate';",
    marker: 'db.todos',
    reason: "`db` is `@/db`'s, a module only the authority runs, which the copy of the module",
    to: "import { addEstimate } from '@/domain/estimate';\nimport { db } from '@/db';\nconst tables = db.todos;",
    what: 'a hook’s module that reads a module only the authority runs',
  },
  {
    beside: {
      'actions/more.ts':
        "'use server';\n\nexport async function more(): Promise<void> {\n  await Promise.resolve();\n}\n",
    },
    file: 'actions/todos.ts',
    from: "import { requiredText } from '@/input';",
    marker: "export * from '@/actions/more'",
    reason: 'exports its operations by name',
    to: "import { requiredText } from '@/input';\n\nexport * from '@/actions/more';",
    what: 'a server module that re-exports another’s operations with `export *`',
  },
  {
    file: EDITOR,
    from: 'export default async function TodoEditor',
    marker: 'export default async function*',
    reason: 'The component is a function, not a generator',
    to: 'export default async function* TodoEditor',
    what: 'a component declared as a generator',
  },
  ...[
    'WebAssembly.Memory({ initial: 0 })',
    "WebAssembly.Table({ element: 'externref', initial: 0 })",
    'WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))',
    'WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))',
    'new WebAssembly.Memory({ initial: -1 })',
    'new WebAssembly.Memory({})',
    'new WebAssembly.Memory({ initial: 1, maximum: 0 })',
    'new WebAssembly.Memory({ initial: 0, shared: true })',
    'new WebAssembly.Memory({ initial: NaN })',
    'new WebAssembly.Module(new Uint8Array([0, 97, 115, 109]))',
    'new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255]))',
    'new WebAssembly.Module([] as never)',
    'new WebAssembly.Module(new ArrayBuffer(0))',
    "new WebAssembly.Table({ element: 'bad', initial: 0 } as never)",
    "new WebAssembly.Table({ element: 'externref', initial: -1 })",
    "new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 0 })",
    "new WebAssembly.Table({ element: 'externref' } as never)",
    'new WebAssembly.Instance({} as never)',
    'new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), null as never)',
  ].map((made): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: made,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `useReactiveState<string>(first === '' ? (${made}, 'ok') : first)`,
      what: `an invalid written WebAssembly construction: ${made}`,
    };
  }),
  ...(
    [
      [
        'const initial = -1; const options = { initial }; const Made = globalThis.WebAssembly.Memory;',
        'new Made(options)',
      ],
      [
        'const bytes = new Uint8Array([0, 97, 115, 109]); const wasm = WebAssembly; const Made = wasm.Module;',
        'new Made(bytes)',
      ],
    ] as const
  ).map(([declaration, made]): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: '  const [selected, setSelected] = useReactiveState(first);',
      marker: made,
      original: KINDS_SOURCE,
      reason: 'A state the authority starts is of',
      to: `  ${declaration}\n  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${made}, 'ok') : first);`,
      what: `an invalid written WebAssembly construction through aliases: ${made}`,
    };
  }),
  // R108: borrowed built-ins keep the argument checks of the invoked method.
  ...[
    'Array.prototype.reduce.call([], (a, b) => a + b)',
    'Array.prototype.reduce.apply([], [(a, b) => a + b])',
    'Reflect.apply(Array.prototype.reduce, [], [(a, b) => a + b])',
    'Array.prototype.reduceRight.call([,], (a, b) => a + b)',
    'Array.prototype.with.call([1], 1, 0)',
    'Number.prototype.toFixed.apply(1, [101])',
    "Reflect.apply(String.prototype.repeat, 'x', [-1])",
    "Date.prototype.toISOString.call(new Date('bad'))",
    'DataView.prototype.getInt32.apply(new DataView(new ArrayBuffer(1)), [0])',
    "Headers.prototype.append.call(new Headers(), 'bad name', 'x')",
    'BigInt64Array.prototype.fill.call(new BigInt64Array(1), 1)',
    "Reflect.apply(Number.prototype.toLocaleString, 1, ['bad_locale'])",
    'Array.prototype.map.call([], null)',
    'Array.prototype.map.call({ length: 0, map() { return []; } }, null)',
    "String.prototype.repeat.call({ toString: () => 'x', repeat: () => 'ok' }, -1)",
  ].map((call): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `R108 a borrowed built-in with arguments that throw: ${call}`,
    };
  }),
  // R109: written target constraints are checked before defining properties.
  ...[
    "Object.defineProperty(Object.preventExtensions({}), 'x', { value: 1 })",
    'Object.defineProperties(Object.preventExtensions({}), { x: { value: 1 } })',
    "Object.defineProperty(Object.freeze({}), 'x', { value: 1 })",
    "Object.defineProperty(Object.seal({}), 'x', { value: 1 })",
    "Object.defineProperty(Object.freeze({ x: 1 }), 'x', { value: 2 })",
    "Object.defineProperty(Object.seal({ x: 1 }), 'x', { configurable: true })",
    "Object.defineProperty(Object.freeze({ x: 1 }), 'x', { writable: true })",
    "Object.defineProperty(Object.freeze({ x: 1 }), 'x', { enumerable: false })",
    "Object.defineProperty(Object.freeze({ x: 1 }), 'x', { get: () => 1 })",
    "Object.defineProperty(Object.seal({ get x() { return 1; } }), 'x', { get: () => 1 })",
    "Object.defineProperty(Object.defineProperty({}, 'x', { value: 1 }), 'x', { value: 2 })",
    "Object.defineProperty(Object.defineProperties({}, { x: { value: 1 } }), 'x', { writable: true })",
    "Object.defineProperty(Object.create(null, { x: { value: 1 } }), 'x', { value: 2 })",
    "Object.defineProperty(Object.freeze([1]), '0', { value: 2 })",
    "Object.defineProperty(Object.freeze([1]), 'length', { value: 2 })",
    "Object.defineProperty(Object.seal([1]), '1', { value: 2 })",
    "Object.defineProperty(Object.preventExtensions([1]), '1', { value: 2 })",
    "Object.defineProperty(Object.freeze({ x: -0 }), 'x', { value: 0 })",
  ].map((call): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `R109 an incompatible property definition on a written target: ${call}`,
    };
  }),
  ...[
    {
      declaration: '  const write = setSelected.bind(null);',
      called: "write('bad')",
      reason: '`write` writes a state',
    },
    { declaration: '', called: "setSelected.bind(null)('bad')", reason: 'The setter is called' },
    {
      declaration: "  const invoke = 'call';",
      called: "setSelected[invoke](null, 'bad')",
      reason: 'The setter is called',
    },
    {
      declaration: "  const invoke = 'apply';",
      called: "setSelected[invoke](null, ['bad'])",
      reason: 'The setter is called',
    },
    {
      declaration:
        '  const prototype = { reset: setSelected };\n  const actions = { __proto__: prototype };',
      called: "actions.reset('bad')",
      reason: '`actions` writes a state',
    },
    {
      declaration:
        '  const prototype = { nested: { reset: setSelected } };\n  const actions = { __proto__: prototype };',
      called: "actions.nested.reset('bad')",
      reason: '`actions` writes a state',
    },
    {
      declaration:
        '  const prototype = { reset: setSelected };\n  const actions = { __proto__: prototype };\n  const { reset } = actions;',
      called: "reset('bad')",
      reason: '`reset` writes a state',
    },
  ].map(({ declaration, called, reason }): Refused => {
    return {
      also: ['    <section>', '    <section>{ran}'],
      file: 'components/kinds.reactive.tsx',
      from: '  return (',
      marker: called,
      original: KINDS_SOURCE,
      reason,
      to: `${declaration}\n  const ran = (${called}, 'ok');\n  return (`,
      what: `a render-time writer escape through binding, computed invocation or prototype: ${called}`,
    };
  }),
  ...[
    "new RegExp('a')",
    'new RegExp(/a/)',
    "RegExp(/a/g, '')",
    'new RegExp(/a/, undefined)',
    'RegExp(/a/, void 0)',
    "new RegExp('a', undefined)",
  ].map((pattern): Refused => {
    const call = `first.replaceAll(${pattern}, 'x')`;
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? ${call} : first)`,
      what: `a pattern copy whose known flags lack global: ${pattern}`,
    };
  }),
  ...[
    'new Array(...([-1] as const))',
    'Array(...([-1] as const))',
    'String.fromCodePoint(...([0x110000] as const))',
    'new Array(...[...[-1]])',
    'new WeakRef(...([1] as const))',
    'Reflect.ownKeys(...([null] as const))',
  ].map((call): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: call,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${call}, 'ok') : first)`,
      what: `a native call given a known throwing spread tuple: ${call}`,
    };
  }),
  {
    also: [
      '  const [selected, setSelected]',
      '  const tuple = [-1] as const;\n  const [selected, setSelected]',
    ],
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Array(...tuple)',
    original: KINDS_SOURCE,
    reason: 'which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Array(...tuple), 'ok') : first)",
    what: 'a native call given a known throwing spread tuple through a constant',
  },
  ...[
    "(new Proxy({}, { get() { throw new Error('bad'); } })).value",
    "(new Proxy({}, { get() { throw new Error('bad'); } }))['value']",
    "(new Proxy({}, { get() { throw new Error('bad'); } }))?.value",
    "(new Proxy({}, { get: () => { throw new Error('bad'); } })).value",
    "(new Proxy({}, { get: () => Number(Symbol('bad')) })).value",
    "(new Proxy({}, { get get() { throw new Error('bad'); } })).value",
  ].map((read): Refused => {
    return {
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: read,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${read}, 'ok') : first)`,
      what: `a proxy property read invoking a written throwing trap: ${read}`,
    };
  }),
  {
    also: [
      '  const [selected, setSelected]',
      "  const handler = { get() { throw new Error('bad'); } };\n  const [selected, setSelected]",
    ],
    file: 'components/kinds.reactive.tsx',
    from: 'useReactiveState(first)',
    marker: 'new Proxy({}, handler).value',
    original: KINDS_SOURCE,
    reason: 'which no JSON holds',
    to: "useReactiveState<string>(first === '' ? (new Proxy({}, handler).value, 'ok') : first)",
    what: 'a proxy property read invoking a written throwing trap through a handler alias',
  },
  // R112: constant text expressions name invocation members just as their literal answers do.
  ...[
    { declaration: "  const invoke = 'c' + 'all';", called: "setSelected[invoke](null, 'bad')" },
    { declaration: '', called: "setSelected['c' + 'all'](null, 'bad')" },
    {
      declaration: "  const invoke = 'bi' + 'nd';\n  const write = setSelected[invoke](null);",
      called: "write('bad')",
    },
  ].map(({ declaration, called }): Refused => {
    return {
      also: ['    <section>', '    <section>{ran}'],
      file: 'components/kinds.reactive.tsx',
      from: '  return (',
      marker: called,
      original: KINDS_SOURCE,
      reason: 'from the handler of an event',
      to: `${declaration}\n  const ran = (${called}, 'ok');\n  return (`,
      what: `R112 a render-time local writer called through a constant text key: ${called}`,
    };
  }),
  ...['1970-01-01T00:00:00'].map((timestamp): Refused => {
    const current = Date.parse(timestamp);
    const zoned = Date.parse(`${timestamp}Z`);
    const elsewhere = current === zoned ? Date.parse(`${timestamp}+09:00`) : zoned;
    return {
      also: ['    <section>', '    <section><span>{ran}</span>'],
      file: 'components/kinds.reactive.tsx',
      from: '  return (',
      marker: 'actions[key]',
      original: KINDS_SOURCE,
      reason: 'writes a state',
      to: [
        `  const key = Date.parse('${timestamp}');`,
        `  const actions = { '${current}': () => 'pure', '${elsewhere}': setSelected };`,
        "  const ran = (actions[key]('bad'), 'ok');",
        '  return (',
      ].join('\n'),
      what: 'R112 a local writer hidden by a time-zone-dependent computed key',
    };
  }),
  ...[
    { type: 'bigint', answer: 'BigInt(panel.panelId.length)' },
    { type: '{ readonly id: string }', answer: '{ id: panel.panelId }' },
    { type: 'boolean', answer: "panel.panelId !== ''" },
    { type: 'string | null', answer: 'panel.panelId || null' },
    { type: 'string | undefined', answer: 'panel.panelId || undefined' },
    { type: 'readonly string[]', answer: '[panel.panelId]' },
    { type: 'symbol', answer: 'Symbol.for(panel.panelId)' },
  ].map(({ type, answer }): Refused => {
    return {
      also: [
        "import { initialPanelsFor } from '@/domain/todo-panels';",
        "import { initialPanelsFor } from '@/domain/todo-panels';\nimport { keyOf } from '@/domain/list-key';",
      ],
      beside: {
        'domain/list-key.ts': `export function keyOf(panel: { readonly panelId: string }): ${type} { return ${answer}; }\n`,
      },
      file: PANELS_LIST,
      from: PANEL_CARD,
      marker: 'keyOf(panel)}',
      original: PANELS_LIST_SOURCE,
      reason: "The key of a list's item reads `keyOf(panel)` here",
      to: '        <PanelCard key={keyOf(panel)} panelId={panel.panelId} todoId={panel.todoId}>',
      what: `R113 declared-return list key of ${type}`,
    };
  }),
  {
    also: [
      "import { initialPanelsFor } from '@/domain/todo-panels';",
      "import { initialPanelsFor } from '@/domain/todo-panels';\nimport { keyOf } from '@/domain/list-key';",
    ],
    beside: {
      'domain/list-key.ts': [
        'export function keyOf(panel: { readonly panelId: string }): bigint;',
        'export function keyOf(panel: { readonly panelId: string }): string | bigint { return BigInt(panel.panelId.length); }',
      ].join('\n'),
    },
    file: PANELS_LIST,
    from: PANEL_CARD,
    marker: 'keyOf(panel)}',
    original: PANELS_LIST_SOURCE,
    reason: "The key of a list's item reads `keyOf(panel)` here",
    to: '        <PanelCard key={keyOf(panel)} panelId={panel.panelId} todoId={panel.todoId}>',
    what: 'R113 declared-return list key of a non-key public overload',
  },
  ...[
    {
      declaration: "  const invoke = first as 'call';",
      called: "setSelected[invoke](null, 'bad')",
    },
    {
      declaration: "  const write = setSelected; const invoke = first as 'call';",
      called: "write[invoke](null, 'bad')",
    },
    {
      declaration: "  const { invoke = 'call' } = {};",
      called: "setSelected[invoke](null, 'bad')",
    },
    { declaration: '  const actions = { call: setSelected };', called: "actions.call('bad')" },
    { declaration: '  const actions = { apply: setSelected };', called: "actions.apply('bad')" },
    {
      declaration:
        "  const invoke = first as 'reset'; const actions = { reset: setSelected, read: () => 'pure' };",
      called: "actions[invoke]('bad')",
    },
    {
      declaration: `  const prefix = 'c';\n  const invoke = \`\${prefix}all\`;`,
      called: "setSelected[invoke](null, 'bad')",
    },
    {
      declaration:
        "  const invoke = first as 'call'; const change = () => setSelected[invoke](null, 'bad');",
      called: 'change()',
    },
    {
      declaration:
        "  const write = setSelected; const invoke = first as 'call'; const change = () => write[invoke](null, 'bad');",
      called: 'change()',
    },
    {
      declaration:
        "  const invoke = first as 'call'; const change = () => run(); const run = () => setSelected[invoke](null, 'bad');",
      called: 'change()',
    },
    {
      declaration:
        "  const invoke = first as 'call'; const actions = { reset: setSelected, read: () => 'pure' };",
      called: "actions.reset[invoke](null, 'bad')",
    },
  ].map(({ declaration, called }): Refused => {
    return {
      also: ['    <section>', '    <section>{ran}'],
      file: 'components/kinds.reactive.tsx',
      from: '  return (',
      marker: called,
      original: KINDS_SOURCE,
      reason: 'from the handler of an event',
      to: [declaration, `  const ran = (${called}, 'ok');`, '  return ('].join('\n'),
      what: `an uncertain invocation key that may call a local writer: ${declaration}`,
    };
  }),
  // Binary membership operators require an object on their right, even in a discarded operand.
  ...['null', 'undefined', 'true', '1', '1n', "'text'", "Symbol('key')", 'void 0'].flatMap(
    (right): Refused[] => {
      return ['in', 'instanceof'].map((operator): Refused => {
        const expression = `1 ${operator} (${right} as never)`;
        return {
          file: 'components/kinds.reactive.tsx',
          from: 'useReactiveState(first)',
          marker: expression,
          original: KINDS_SOURCE,
          reason: 'which no JSON holds',
          to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
          what: `a binary membership operator with a primitive right operand: ${operator} ${right}`,
        };
      });
    },
  ),
  ...['in', 'instanceof'].map((operator): Refused => {
    const expression = `1 ${operator} (again as never)`;
    return {
      also: [
        '  const [selected, setSelected]',
        '  const invalid = null; const again = invalid;\n  const [selected, setSelected]',
      ],
      file: 'components/kinds.reactive.tsx',
      from: 'useReactiveState(first)',
      marker: expression,
      original: KINDS_SOURCE,
      reason: 'which no JSON holds',
      to: `useReactiveState<string>(first === '' ? (${expression}, 'ok') : first)`,
      what: `a binary membership operator with an aliased primitive right operand: ${operator}`,
    };
  }),
  // R113: shared functions receive frozen copies of the browser's mutable JSON inputs.
  ...[
    'Object.isFrozen(items)',
    'Object.isSealed(items)',
    'Object.isExtensible(items)',
    "Object.getOwnPropertyDescriptor(items, 'length')?.writable",
    "Object.getOwnPropertyDescriptors(items)['length']?.writable",
    'Reflect.isExtensible(items)',
    "Reflect.getOwnPropertyDescriptor(items, 'length')?.writable",
    "Object['isFrozen'](items)",
    '(() => { const inspect = Object.isFrozen; return inspect(items); })()',
    '(() => { const { isSealed: inspect } = Object; return inspect(items); })()',
    '(() => { const alias = items; return Object.isFrozen(alias); })()',
  ].map((read): Refused => {
    return {
      beside: {
        'domain/input-metadata.ts': `export function label(items: readonly string[]): string { return ${read} ? 'authority' : 'browser'; }\n`,
      },
      file: 'components/input-metadata.reactive.tsx',
      from: 'id={label(items)}',
      marker: 'label(items)}',
      original: [
        "import { useReactiveState } from 'framework/react';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        "import { label } from '@/domain/input-metadata';",
        'export default function InputMetadata({ projectId, first }: { projectId: string; first: readonly string[] }) {',
        '  const [items, setItems] = useReactiveState(first);',
        '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
        '}',
      ].join('\n'),
      reason: 'a shared module that answers otherwise',
      to: 'id={label(items)}',
      what: `R113 a shared helper reads input freezing metadata: ${read}`,
    };
  }),
  {
    what: 'native iterator shared reported-values-next-payload',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_ITERATOR_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision.values().next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_ITERATOR_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },
  {
    what: 'native iterator shared advanced-native-cursor',
    file: 'app/boards/[projectId]/middleware.ts',
    from: 'NATIVE_ITERATOR_MIDDLEWARE',
    to: "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false},{allowed:false}];const iterator=decision.values();\nawait requirePublishedProject(params.projectId);\niterator.next();iterator.next().value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[1]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n",
    original: 'NATIVE_ITERATOR_MIDDLEWARE',
    marker: 'const decision',
    reason: 'A collection (`decision`) read by both the guard and the host is mutated',
  },
  // A tuple's rest written as a reference to the language's array is the array's elements: an
  // index the code computes, and `at`, read an Error of it.
  ...(
    [
      ['tuple rest Array index retains frames', '[string,...Array<Error>]', 'values[i]!'],
      ['tuple rest Array at retains frames', '[string,...Array<Error>]', 'values.at(-1)!'],
      [
        'readonly tuple rest retains frames',
        'readonly [string,...ReadonlyArray<Error>]',
        'values[i]!',
      ],
      [
        'tuple rest global Array retains frames',
        '[string,...globalThis.Array<Error>]',
        'values[i]!',
      ],
    ] as const
  ).map(([what, tuple, read]): Refused => {
    return {
      beside: { 'domain/todo-filter.ts': tupleRestFrames('', tuple, read) },
      file: 'components/project-workspace.reactive.tsx',
      from: 'const renderedFilter = effectiveFilter;',
      marker: 'renderedFilter} />',
      reason: 'a shared module that answers otherwise',
      to: 'const renderedFilter = effectiveFilter;',
      what,
    };
  }),
];

describe('the compiler refuses', () => {
  const { apps, compile } = compilerApplications();

  it.each(REFUSED)(
    '$what',
    async ({ also, beside = {}, file, from, marker, original, reason, to }) => {
      const once = variant(original ?? (await source(file)), from, to);
      const changed = also === undefined ? once : variant(once, ...also);
      const app = await application({ ...beside, [file]: changed });
      apps.push(app);

      expect(refusalOf(compile(app))).toMatchObject({
        ...positionOf(changed, marker),
        fileName: file,
        name: 'ReactiveCompileError',
        reason: expect.stringContaining(reason) as unknown,
      });
    },
  );

  it('no tuple rest of an `Array` the module declares itself, which is no array', async () => {
    // The twin of 'tuple rest Array index retains frames': the name is the module's own type here,
    // of a text `stack`, so the read is of no Error.
    const app = await application({
      'domain/todo-filter.ts': tupleRestFrames(
        'type Array<T>={stack:string};',
        '[string,...Array<Error>]',
        'values[i]!',
      ),
    });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it('a module read on both sides of a component, which the browser would import whole', async () => {
    const editor = variant(
      variant(
        await source(EDITOR),
        "import { db } from '@/db';",
        "import { db } from '@/db';\nimport { allow } from 'gate';\nimport { label } from 'gate/browser';",
      ),
      '<p>{status}</p>',
      '<p>{status}{label}</p>',
    );
    const changed = variant(
      editor,
      '  const ref = db.todos.ref(id);',
      "  const ref = db.todos.ref(allow() ? id : '');",
    );
    const app = await application({ [EDITOR]: changed });
    apps.push(app);
    const gate = path.join(app.root, 'node_modules/gate');
    await mkdir(gate, { recursive: true });
    await writeFile(
      path.join(gate, 'package.json'),
      JSON.stringify({
        exports: { '.': './shared.js', './browser': './shared.js' },
        name: 'gate',
        type: 'module',
      }),
    );
    await writeFile(
      path.join(gate, 'shared.js'),
      "export const allow = () => true;\nexport const label = 'gate';\n",
    );

    expect(refusalOf(compile(app))).toMatchObject({
      ...positionOf(changed, 'label}'),
      reason: expect.stringContaining(
        "`label` is `gate/browser`'s, which the server part reads on the authority",
      ) as unknown,
    });
  });

  it('a module of hooks for what it is, in each component that imports it', async () => {
    // A read its hook's body makes, which the module's analysis refuses, as each component that
    // imports it has the module analyzed.
    const hook = variant(
      variant(
        await source(HOOK),
        "import { addEstimate } from '@/domain/estimate';",
        "import { addEstimate } from '@/domain/estimate';\nimport { db } from '@/db';",
      ),
      '  const [estimate, setEstimate] = useReactiveState(ref);',
      '  const [estimate, setEstimate] = useReactiveState(ref);\n  const tables = db.todos;',
    );
    const app = await application({
      'components/estimate-again.reactive.tsx': [
        "import { db } from '@/db';",
        "import { useEstimate } from '@/hooks/use-estimate';",
        '',
        'export default function EstimateAgain({ id }: { id: string }) {',
        '  const [estimate, increase] = useEstimate(db.todos.ref(id).estimate, 1);',
        '  return <button type="button" onClick={increase}>{estimate}</button>;',
        '}',
        '',
      ].join('\n'),
      [HOOK]: hook,
    });
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((refusal) => refusal.reason);

    // Read again by the second component that imports it, and refused for the same reason — said
    // once — rather than taken for a cycle.
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("`db` is `@/db`'s, a module only the authority runs");
  });

  it('every refusal of every component, once each', async () => {
    const editor = await source(EDITOR);
    const app = await application({
      [EDITOR]: variant(editor, '<p>{status}</p>', '<p>{user.id}</p>'),
      [LAYOUT]: variant(await source(LAYOUT), '<h2>{title}</h2>', '<h2 onClick={() => 1} />'),
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals.map((refusal) => refusal.fileName)).toStrictEqual([LAYOUT, EDITOR]);
    expect(compiled.outputs.size).toBe(0);
  });
});
