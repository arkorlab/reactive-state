import {
  fieldKey,
  type Frame,
  type Rendered,
  type RenderedClient,
  type RenderedProp,
  type Value,
} from '../../src/program.ts';

/**
 * Frames and rendered trees, as the suites make and read them: a frame of the counter `main` — its
 * one field — or of any fields, and the client parts and the text a tree holds.
 */

/** The key the counter `main`'s `count` is kept under, on a page and in a frame. */
const COUNT = fieldKey({ field: 'count', id: 'main', table: 'counters' });

/** A frame at `revision` holding `fields`, of the counter's root unless told otherwise. */
function frameWith(
  revision: number,
  fields: Readonly<Record<string, Value>>,
  options: {
    readonly rootKey?: string;
    readonly buildId?: string;
    readonly operations?: readonly string[];
    readonly digest?: string;
    readonly subscription?: string;
    readonly view?: Frame['view'];
  } = {},
): Frame {
  const {
    buildId = 'b_test',
    digest = `digest:${String(revision)}`,
    operations = [],
    rootKey = 'root:counter',
    subscription = 'subscription:counter',
    view = {},
  } = options;
  return { buildId, digest, fields, operations, revision, rootKey, subscription, view };
}

/** A frame of the counter `main` at `revision`, holding `count`, reflecting `operations`. */
export function frameOf(
  revision: number,
  count: number,
  operations: readonly string[] = [],
): Frame {
  return frameWith(revision, { [COUNT]: count }, { operations });
}

/** A promise and the functions that settle it, for a test to settle when it chooses. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  return { promise, reject, resolve };
}

/**
 * The kinds of a rendered node: no object a prop's JSON holds is of one, as the authority refuses
 * JSON shaped as something rendered, whereas JSON of any other `kind` is JSON.
 */
const NODE_KINDS: ReadonlySet<unknown> = new Set(['client', 'element', 'fragment', 'module']);

/**
 * Whether a prop's value is something rendered, as the authority tells one from JSON: a node, or a
 * list that holds one — in a list of it, too — and not an action or JSON, whose lists hold none.
 */
function isRendered(value: RenderedProp): value is Rendered {
  if (Array.isArray(value)) {
    return (value as readonly RenderedProp[]).some((item) => isRendered(item));
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    NODE_KINDS.has((value as { readonly kind?: unknown }).kind)
  );
}

/**
 * Each node of a tree, depth first, its props' rendered values, its slots and what its sites
 * rendered included.
 */
function* nodesOf(tree: Rendered): Generator<Exclude<Rendered, readonly Rendered[]>> {
  if (Array.isArray(tree)) {
    for (const item of tree as readonly Rendered[]) {
      yield* nodesOf(item);
    }
    return;
  }
  const node = tree as Exclude<Rendered, readonly Rendered[]>;
  yield node;
  if (typeof node !== 'object' || node === null) {
    return;
  }
  if (node.kind === 'client') {
    yield* partNodes(node.part);
    return;
  }
  yield* nodesOf(node.children);
  if (node.kind !== 'fragment') {
    for (const value of Object.values(node.props)) {
      if (isRendered(value)) {
        yield* nodesOf(value);
      }
    }
  }
}

/** What a client part holds that renders: its slots, and what its sites rendered — a list's, item by item. */
function* partNodes(
  part: RenderedClient['part'],
): Generator<Exclude<Rendered, readonly Rendered[]>> {
  for (const slot of Object.values(part.slots)) {
    yield* nodesOf(slot);
  }
  const sites = part.sites ?? {};
  for (const site of Object.values(sites)) {
    if (site.refused !== undefined) {
      continue;
    }
    if (site.items === undefined) {
      yield* nodesOf(site.content);
    } else {
      for (const { content } of site.items) {
        yield* nodesOf(content);
      }
    }
  }
}

/** Every client part a tree holds, in its order. */
export function clientsIn(tree: Rendered, component?: string): readonly RenderedClient[] {
  return [...nodesOf(tree)].filter((node): node is RenderedClient => {
    return (
      typeof node === 'object' &&
      node !== null &&
      node.kind === 'client' &&
      (component === undefined || node.component === component)
    );
  });
}

/** The one client part of `component` a tree holds; a test's failure where it holds none, or more. */
export function clientOf(tree: Rendered, component: string): RenderedClient {
  const [client, ...others] = clientsIn(tree, component);
  if (client === undefined || others.length > 0) {
    throw new Error(
      `The tree holds ${String(others.length + (client === undefined ? 0 : 1))} of ${component}.`,
    );
  }
  return client;
}

/** The text a tree renders, each piece where it is. */
export function textOf(tree: Rendered): string {
  return [...nodesOf(tree)]
    .filter((node) => typeof node === 'string' || typeof node === 'number')
    .join('');
}
