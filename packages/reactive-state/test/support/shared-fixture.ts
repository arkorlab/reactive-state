import { onTestFinished } from 'vitest';

import { Engine } from '../../src/authority/index.ts';
import type { SiteFetch } from '../../src/authority/shared-generate.ts';
import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../../src/program.ts';
import {
  type GateAnswer,
  GENERATION_HEADER,
  type RouteRegistration,
  type SharedEvent,
} from '../../src/routing.ts';
import { boolean, currentUser, database, forbidden, table, text } from '../../src/server/index.ts';
import { nextPageParam } from './next-page.ts';

/**
 * The shared views of an application of its own — a public board of a project's to-dos, which shows
 * only a published project; a page of the to-do a pin names; and a page that says who is reading
 * it — rendered through the engine's own gate, with a site that renders the page as the page's root
 * entry does: by asking the engine for the route's root with the generation's token. No Next.js, no
 * edge: what the authority decides, and what it counts.
 */

export const BUILD = 'b_shared';
/**
 * The deployment of the site that renders the pages (`pageOf`), which every answer of it names
 * (`x-nextjs-deployment-id`), and every gate's question of `ask` names as the one it is of.
 */
const DEPLOYMENT = 'dpl_test';
export const BOARD = '/boards/[projectId]';
const PINNED = '/pinned/[pinId]';
export const WHOAMI = '/whoami/[projectId]';
export const WORKSPACE = '/workspace/[projectId]';

/** How long `rewrite` waits between its writes: longer than a view waits for more commits. */
const WRITE_GAP_MS = 15;
/** How long `quiet` lets the engine's timers run: past a view's settling, and what follows it. */
const QUIET_MS = 50;

const db = database(
  {
    projects: table({
      ownerId: text({ maxLength: 64 }),
      title: text({ maxLength: 200 }),
      published: boolean(),
      internalNote: text({ maxLength: 2000 }),
    }),
    todos: table({
      projectId: text({ maxLength: 64 }),
      title: text({ maxLength: 200 }),
      completed: boolean(),
    }),
    // Which to-do the pinned page shows: a row read only to choose which other row to read.
    pins: table({ todoId: text({ maxLength: 64 }) }),
  },
  {
    seed: {
      pins: { main: { todoId: 't1' } },
      projects: {
        p1: { internalNote: 'PRIVATE_P1', ownerId: 'alice', published: true, title: '開発' },
        p2: { internalNote: 'PRIVATE_P2', ownerId: 'alice', published: false, title: '運用' },
      },
      todos: {
        t1: { completed: false, projectId: 'p1', title: '一覧を作る' },
        t2: { completed: false, projectId: 'p1', title: '同期を確認する' },
      },
    },
  },
);

type Props = Readonly<Record<string, unknown>>;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** A published project's title and its to-dos; for any other project, the generic refusal. */
async function board(props: Props, $: RenderScope): Promise<unknown> {
  const projectId = String(props['projectId']);
  const project = await db.projects.get(projectId);
  if (project?.published !== true) {
    forbidden();
  }
  return $.h(
    'main',
    null,
    $.h('h1', null, project.title),
    $.h(componentRef('components/board-todos'), { projectId }),
  );
}

async function boardTodos(props: Props, $: RenderScope): Promise<unknown> {
  const todos = await db.todos.findMany({ where: { projectId: String(props['projectId']) } });
  return todos.length === 0
    ? $.h('p', null, 'empty')
    : $.h('ul', null, ...todos.map((todo) => $.h('li', { key: todo.id }, todo.title)));
}

/** The title of the to-do the pin names: the pin read, and then that one to-do alone. */
async function pinned(props: Props, $: RenderScope): Promise<unknown> {
  const pin = await db.pins.get(String(props['pinId']));
  const todo = pin === null ? null : await db.todos.get(pin.todoId);
  return $.h('p', null, todo?.title ?? 'none');
}

async function whoami(_props: Props, $: RenderScope): Promise<unknown> {
  const user = await currentUser();
  return $.h('p', null, user === null ? 'anonymous' : user.id);
}

/** A page of the request's own: the filter it shows is the page's, not the route's. */
function workspace(props: Props, $: RenderScope): unknown {
  return $.h('p', null, `${String(props['projectId'])}:${String(props['filter'])}`);
}

const EVALUATES: Readonly<Record<string, ComponentProgram['evaluate']>> = {
  'components/board': board,
  'components/board-todos': boardTodos,
  'components/pinned': pinned,
  'components/whoami': whoami,
  'components/workspace': workspace,
};

/** The application's programs, as a compile of `build` writes them. */
function programsOf(build: string): readonly ComponentProgram[] {
  return Object.entries(EVALUATES).map(([component, evaluate]) => {
    return {
      buildId: build,
      component,
      evaluate,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
  });
}

/** A route whose page hands its one param to its root, as the prop of the same name. */
function route(name: string, root: string, param: string): RouteRegistration {
  return {
    blocking: true,
    middleware: [],
    page: `${name.slice(1)}/page.tsx`,
    params: [param],
    props: { [param]: param },
    root,
    route: name,
    shared: true,
  };
}

const BOARD_ROUTE = route(BOARD, 'components/board', 'projectId');

/** The routes the compile registered: every one shared but the workspace, which is the request's. */
const ROUTES: readonly RouteRegistration[] = [
  BOARD_ROUTE,
  route(PINNED, 'components/pinned', 'pinId'),
  route(WHOAMI, 'components/whoami', 'projectId'),
  { ...route(WORKSPACE, 'components/workspace', 'projectId'), shared: false },
];

const ROUTE_OF_SEGMENT: ReadonlyMap<string, RouteRegistration> = new Map(
  ROUTES.map((each) => [each.route.split('/', 2)[1] ?? '', each]),
);

/** The route a path is of, by its first segment: the board's, for a segment no route has. */
function routeOf(path: string): RouteRegistration {
  const [, segment = ''] = path.split('/', 2);
  return ROUTE_OF_SEGMENT.get(segment) ?? BOARD_ROUTE;
}

const admin = {
  async setPublished(id: unknown, published: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.projects.update(String(id), { published: published === true });
    });
  },
  async setNote(id: unknown, internalNote: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.projects.update(String(id), { internalNote: String(internalNote) });
    });
  },
  async setTodoTitle(id: unknown, title: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.todos.update(String(id), { title: String(title) });
    });
  },
  async addTodo(projectId: unknown, title: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.todos.insert({
        completed: false,
        projectId: String(projectId),
        title: String(title),
      });
    });
  },
  async pin(id: unknown, todoId: unknown): Promise<void> {
    await db.transaction(async () => {
      await db.pins.update(String(id), { todoId: String(todoId) });
    });
  },
  /**
   * Renames a project and each of its to-dos after it (`<title>/<id>`), and adds one
   * (`<title>/added`): rows of two tables in one transaction, which waits between its writes as an
   * operation that awaits something between them does.
   */
  async rewrite(projectId: unknown, title: unknown): Promise<void> {
    const id = String(projectId);
    const name = String(title);
    await db.transaction(async () => {
      await db.projects.update(id, { title: name });
      const todos = await db.todos.findMany({ where: { projectId: id } });
      await pause(WRITE_GAP_MS);
      await Promise.all(
        todos.map(async (todo) => db.todos.update(todo.id, { title: `${name}/${todo.id}` })),
      );
      await pause(WRITE_GAP_MS);
      await db.todos.insert({ completed: false, projectId: id, title: `${name}/added` });
    });
  },
};

export interface OpenOptions {
  /** The site the engine asks for a page, made of the engine: `pageOf`'s unless given. */
  readonly site?: (engine: Engine) => SiteFetch;
  readonly gateWaitMs?: number;
  /** The database file; in memory unless given. */
  readonly filename?: string;
  /** The build the application was compiled in: `BUILD` unless given. */
  readonly build?: string;
  /** The engine's clock: the wall clock unless given. */
  readonly clock?: () => number;
}

export interface Opened {
  readonly engine: Engine;
  readonly alice: string;
  /** Each page the site was asked for: its path and the profile. */
  readonly asked: { readonly path: string; readonly rsc: boolean }[];
  readonly operate: (name: string, ...args: readonly unknown[]) => Promise<void>;
  readonly ask: (url: string, headers?: Readonly<Record<string, string>>) => Promise<GateAnswer>;
  /** Closes the engine, once: when the test finishes, unless the test closed it before. */
  readonly close: () => Promise<void>;
}

/** The application's engine, its site, and Alice signed in to run its operations. */
export async function open(options: OpenOptions = {}): Promise<Opened> {
  const { build = BUILD, site, ...given } = options;
  const engine = new Engine({
    buildId: build,
    database: db,
    operations: { 'actions/admin': admin },
    programs: programsOf(build),
    routes: ROUTES,
    ...given,
  });
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= engine.close();
    return closed;
  };
  onTestFinished(close);
  const asked: { path: string; rsc: boolean }[] = [];
  const render = site?.(engine) ?? pageOf(engine);
  engine.site(async (path, headers, signal) => {
    asked.push({ path, rsc: headers['rsc'] === '1' });
    return render(path, headers, signal);
  });
  const { sessionId: alice } = await engine.login('alice');
  let operations = 0;
  return {
    alice,
    ask: async (url, headers = {}) => {
      return engine.gate({
        deployment: DEPLOYMENT,
        headers,
        method: 'GET',
        route: routeOf(url).route,
        url,
      });
    },
    asked,
    close,
    engine,
    operate: async (name, ...args) => {
      operations += 1;
      await engine.operate(alice, {
        args: args.map((json) => ({ json: json as never })),
        build,
        module: 'actions/admin',
        name,
        operationId: `op-${String(operations)}`,
      });
    },
  };
}

/**
 * The page, as its root entry renders it: the route's root, of the param Next.js hands the page
 * (`nextPageParam`), with the request's generation token.
 */
export function pageOf(engine: Engine): SiteFetch {
  return async (path, headers) => {
    const shown = routeOf(path);
    const param = path.split('/', 3)[2] ?? '';
    const [name = ''] = shown.params;
    const answer = await engine.renderShared(null, {
      build: engine.buildId,
      generation: headers[GENERATION_HEADER],
      props: { [name]: nextPageParam(param) },
      route: shown.route,
    });
    const view = answer.kind === 'shared' ? `g${String(answer.view.generation)}` : 'session';
    return new Response(`${JSON.stringify(answer.result.tree)}|${view}`, {
      headers: {
        'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html; charset=utf-8',
        'set-cookie': 'leak=1',
        'x-nextjs-deployment-id': DEPLOYMENT,
      },
    });
  };
}

/** A site whose answers a test holds, and the release of each answer it holds, in order. */
export interface Holding {
  readonly site: (engine: Engine) => SiteFetch;
  readonly releases: readonly (() => void)[];
  /** Resolves once the site holds `count` answers, or has held them: at once for none. */
  readonly until: (count: number) => Promise<void>;
}

/**
 * A site that answers as `pageOf`'s does, and holds each answer `picks` — of its body, its profile
 * and how many it holds already — once the page rendered it and before the authority has it, until
 * the test releases it: a generation's artifact being made while the test commits.
 */
export function holding(picks: (body: string, rsc: boolean, held: number) => boolean): Holding {
  const releases: (() => void)[] = [];
  const waiting = new Map<() => void, number>();
  const until = async (count: number): Promise<void> => {
    if (releases.length < count) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      waiting.set(() => {
        resolve(undefined);
      }, count);
      await promise;
    }
  };
  const hold = async (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    releases.push(() => {
      resolve(undefined);
    });
    for (const [woken, count] of waiting) {
      if (releases.length >= count) {
        waiting.delete(woken);
        woken();
      }
    }
    await promise;
  };
  return {
    releases,
    site: (engine) => {
      const page = pageOf(engine);
      return async (path, headers) => {
        const answer = await page(path, headers);
        if (picks(await answer.clone().text(), headers['rsc'] === '1', releases.length)) {
          await hold();
        }
        return answer;
      };
    },
    until,
  };
}

/** The token a page of p-something's board holds for its stream. */
export async function viewTokenOf(engine: Engine, projectId: string): Promise<string> {
  const rendered = await engine.renderShared(null, {
    build: engine.buildId,
    props: { projectId },
    route: BOARD,
  });
  if (rendered.kind !== 'shared') {
    throw new Error('The board is not shared');
  }
  return rendered.view.token;
}

/** What a page that holds `token` hears of its view: what it missed, then each event, in order. */
export async function follow(engine: Engine, token: string): Promise<readonly SharedEvent[]> {
  const followed = await engine.followShared(token);
  const heard = [...followed.missed];
  const stop = followed.listen((event) => {
    heard.push(event);
  });
  onTestFinished(stop);
  return heard;
}

/** Resolves once timers set now have had their turn: a view's settling, and what follows it. */
export async function later(): Promise<void> {
  await pause(QUIET_MS);
}

/** Lets what the engine has under way run its course: its timers first, then its queue. */
export async function quiet(engine: Engine): Promise<void> {
  await later();
  await engine.stats();
}

export function bodyOf(answer: GateAnswer): string {
  return answer.kind === 'respond' && answer.body !== null
    ? Buffer.from(answer.body, 'base64').toString('utf8')
    : '';
}

/** What a page's body shows: the text of its tree, in order, and the generation it is of. */
export interface Shown {
  readonly texts: readonly string[];
  readonly generation: string;
}

/** What a page's body shows, as `pageOf` wrote it: nothing of a page, for any other body. */
export function shownBy(body: string): Shown {
  const bar = body.lastIndexOf('|');
  if (bar === -1) {
    return { generation: '', texts: [] };
  }
  const texts: string[] = [];
  const read = (node: unknown): void => {
    if (typeof node === 'string') {
      texts.push(node);
    } else if (typeof node === 'object' && node !== null && 'children' in node) {
      for (const child of node.children as readonly unknown[]) {
        read(child);
      }
    }
  };
  read(JSON.parse(body.slice(0, bar)));
  return { generation: body.slice(bar + 1), texts };
}

/** What the body of a gate's answer shows, as `shownBy` reads it. */
export function shownOf(answer: GateAnswer): Shown {
  return shownBy(bodyOf(answer));
}

export function headerOf(answer: GateAnswer, name: string): string | undefined {
  return answer.kind === 'respond' ? answer.headers.find(([key]) => key === name)?.[1] : undefined;
}
