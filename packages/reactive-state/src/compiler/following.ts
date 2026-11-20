import type { Expression, Identifier, Node } from 'typescript/ast';

import type { Component, TopLevel } from './analyze.ts';
import { COMPUTED_BY } from './computed.ts';
import type { Frame, HookFrame, SiteInput } from './frames.ts';
import type { ImportBinding } from './imports.ts';
import type { Space, Visitor } from './scope.ts';

/**
 * What a site's read is followed with (`derive.ts`): what each name it reaches is, as the program
 * writes it, and where the following stands.
 */

/** What a read of a name is, as the authority's program writes it. */
export type Resolution =
  /** A state the page sends: the name the site's function holds it by. */
  | { readonly kind: 'input'; readonly key: string }
  /**
   * A value computed of others, written in place: `name`, the name it is read by, `type` the type
   * a constant is annotated with, as the program writes it.
   */
  | {
      readonly kind: 'value';
      readonly node: Expression;
      readonly frame: Frame;
      readonly name: string;
      readonly type?: string | undefined;
    }
  /** An import of a hook's module, which the program imports itself. */
  | { readonly kind: 'import'; readonly binding: ImportBinding }
  /** A type a hook's module imports, which the program imports as a type. */
  | { readonly kind: 'type'; readonly binding: ImportBinding };

/**
 * A value computed in place: the code of a constant, of an item a hook returns or of a call's
 * argument, reached through the calls `prefix` names (none for the component's), read as `name`.
 */
interface Computed {
  readonly prefix: string;
  readonly node: Expression;
  readonly name: string;
  /** An extracted callee retains its value, so writing a member in place cannot restore this. */
  readonly held?: boolean;
}

/** The names the program writes what a site's values are computed of by. */
export interface Naming {
  /** The name a site's function holds the input `key` by. */
  readonly input: (key: string) => string;
  /** The name the program imports a hook's module's import by. */
  readonly import: (binding: ImportBinding) => string;
  /** The name the program imports a type a hook's module imports by. */
  readonly type: (binding: ImportBinding) => string;
  /**
   * What a value computed in place is written as, `written` its computation: that, or the name the
   * function holds it by (`Held`). None writes it in place each time.
   */
  readonly computed?: (computed: Computed, written: () => string) => string;
}

/** A name alone, as a value written in place may be. */
const NAME = /^[$A-Z_a-z][\w$]*$/u;

/**
 * The values a site's function computes in place, those read more than once held by a name of
 * their own, computed once before what reads them — as the browser's constant is one value, so an
 * item of an array one read finds is an item of the array another read holds. The function's body
 * is written twice: once counting the reads (`counting`), once holding (`holding`).
 */
export class Held {
  readonly #reads = new Map<string, Map<Node, number>>();
  readonly #names = new Map<string, Map<Node, string>>();
  readonly #declarations: string[] = [];
  /** A name of its own for a value read as `wanted`, which nothing else in the function takes. */
  readonly #named: (wanted: string) => string;

  constructor(named: (wanted: string) => string) {
    this.#named = named;
  }

  /** `naming`, counting each value it writes in place. */
  counting(naming: Naming): Naming {
    return {
      ...naming,
      computed: (computed, written) => {
        const reads = byPrefix(this.#reads, computed.prefix);
        reads.set(computed.node, (reads.get(computed.node) ?? 0) + 1);
        return written();
      },
    };
  }

  /** `naming`, holding each value counted more than once by a name, declared once. */
  holding(naming: Naming): Naming {
    return {
      ...naming,
      computed: (computed, written) => {
        if (
          computed.held !== true &&
          (byPrefix(this.#reads, computed.prefix).get(computed.node) ?? 0) < 2
        ) {
          return written();
        }
        const names = byPrefix(this.#names, computed.prefix);
        const held = names.get(computed.node);
        if (held !== undefined) {
          return held;
        }
        // Written first, so what it is computed of, held too, is declared before it; a name, which
        // computes nothing, is written as it is.
        const text = written();
        if (NAME.test(text)) {
          return text;
        }
        const name = this.#named(computed.name);
        names.set(computed.node, name);
        this.#declarations.push(`const ${name} = ${text};`);
        return name;
      },
    };
  }

  /** The function's body of `text`: the expression, or the values held, then its `return`. */
  body(text: string): string {
    return this.#declarations.length === 0
      ? text
      : `{ ${this.#declarations.join(' ')} return ${text}; }`;
  }
}

/** The entries of `values` for the code reached through the calls `prefix` names. */
function byPrefix<T>(values: Map<string, Map<Node, T>>, prefix: string): Map<Node, T> {
  let entries = values.get(prefix);
  if (entries === undefined) {
    entries = new Map();
    values.set(prefix, entries);
  }
  return entries;
}

/** What a component's derivations are followed with. */
export interface DerivationContext {
  readonly component: Component;
  /** Walks a node of the component's, lexically. */
  readonly walking: (node: Node, visitor: Visitor) => void;
  /** What the authority's program reads of a name of the component's that is no browser value. */
  readonly authority: (identifier: Identifier, space: Space) => void;
  /** The names no code the outputs write within may declare or read, why given by the message. */
  readonly reserved: ReadonlyMap<string, string>;
}

/** One following of a site's read, from the component's name it reads. */
export interface Following {
  readonly inputs: Map<string, SiteInput>;
  /** The component's read the site's value is followed from, which a refusal points at. */
  readonly origin: Identifier;
  /**
   * The code followed already, by the prefix of the calls it is reached through and the names
   * around where it is written: each once.
   */
  readonly visited: Map<string, Set<Node>>;
  /**
   * The names the code around where the code followed is written in place declares — a function's
   * parameters, of the site's own code or of the code it is written within — which no global and no
   * name of the component's that it reads may be: they would answer for it there.
   */
  readonly scope: ReadonlySet<string>;
}

/** `at`, at a read whose `scope` holds, beside the `topLevel` names, those the code around it declares. */
export function around(
  at: Following,
  scope: ReadonlySet<string> | undefined,
  topLevel: { readonly has: (name: string) => boolean },
): Following {
  const declared = [...(scope ?? [])].filter((name) => !topLevel.has(name));
  if (declared.length === 0) {
    return at;
  }
  const names = new Set(at.scope);
  for (const name of declared) {
    names.add(name);
  }
  return { ...at, scope: names };
}

/** What `visited` keys code by: the prefix of the calls it is reached through, and `scope`. */
export function visitKey(prefix: string, scope: ReadonlySet<string>): string {
  return [prefix, ...[...scope].toSorted((a, b) => a.localeCompare(b))].join('\n');
}

/** A following that reached a hook's code, by the call `frame` names. */
export interface Reaching {
  readonly at: Following;
  readonly frame: HookFrame;
}

/** A following that reached the item `item` a hook's call returns. */
export interface HookReaching extends Reaching {
  readonly item: string;
}

/**
 * The constants being followed, by the prefix of the calls their code is reached through: one read
 * again while it is followed is computed of itself, which neither side can compute.
 */
export class Followed {
  readonly #following = new Map<string, Set<Node>>();

  /**
   * Follows the constant `declaration`, reached through the calls `prefix` names, by `follow`;
   * `refuse` where it is followed already.
   */
  within(
    prefix: string,
    declaration: Node,
    following: { readonly follow: () => void; readonly refuse: () => never },
  ): void {
    let declarations = this.#following.get(prefix);
    if (declarations === undefined) {
      declarations = new Set();
      this.#following.set(prefix, declarations);
    }
    if (declarations.has(declaration)) {
      following.refuse();
    }
    declarations.add(declaration);
    try {
      following.follow();
    } finally {
      declarations.delete(declaration);
    }
  }
}

/** Why a constant is refused that is computed of itself. */
export function itself(name: string): string {
  return `\`${name}\` is computed of itself, which neither the browser nor the authority can compute.`;
}

/** Why a parameter may not take the name of a global the code written in place reads. */
export function hidden(name: string): string {
  return `\`${name}\` is a global that what a dynamic site's value is computed of reads, and the parameter of a function in the code the authority writes it within takes the name, which would answer for the global there. Give the parameter another name.`;
}

/** Whether `node`, reached through the calls `prefix` names, is followed the first time; notes it so. */
export function firstVisit(visited: Map<string, Set<Node>>, prefix: string, node: Node): boolean {
  let nodes = visited.get(prefix);
  if (nodes === undefined) {
    nodes = new Set();
    visited.set(prefix, nodes);
  }
  if (nodes.has(node)) {
    return false;
  }
  nodes.add(node);
  return true;
}

/** The names of a component's whose values the browser holds, which the program has no name for. */
export const BROWSER_VALUES: ReadonlySet<TopLevel['kind']> = new Set([
  'constant',
  'hooked',
  'node',
  'setter',
  'state',
]);

/** A read of `identifier`, the value of `node` in `frame`, computed in place, of `type` if given. */
export function valueOf(
  frame: Frame,
  identifier: Identifier,
  node: Expression,
  type?: string,
): Resolution {
  return { frame, kind: 'value', name: identifier.text, node, type };
}

/** Why a type of the browser's value `name` is refused, which the program has no name for. */
export function typeOfBrowser(name: string): string {
  return `\`typeof ${name}\` is the type of a value of the browser's, which the authority's program, where the value is computed again in place, has no name for. Name the type itself.`;
}

/** Why a hook's parameter `name` with a default is refused. */
export function defaulted(name: string): string {
  return `the parameter \`${name}\` takes a default, which the browser's hook applies where its call gives \`undefined\`, and the authority, computing the value in place of what the call gives, would not. Leave the default out, and give the value in the call.`;
}

/** Why a hook's state `name` is refused whose parameter the call gives nothing. */
export function ungiven(name: string): string {
  return `\`${name}\` starts from the hook's parameter, which the call gives no value of its own: the browser starts it of the parameter's default, which the authority has no first value of. Give the call the value.`;
}

/** Why `name`, holding all `hook` returns, is refused. */
export function whole(name: string, hook: string): string {
  return `\`${name}\` holds all \`${hook}\` returns, and what a dynamic site reads of it is followed into the hook item by item: destructure the items it reads — \`const { … } = ${hook}(…)\`.`;
}

/** Why a read of the component's `name` is refused that a name declared around where it is written takes. */
export function captured(name: string): string {
  return `\`${name}\` is the component's own, and what reads it is written in place within code that declares a parameter of the name — a function's of a hook's, or of the site's own — which would answer for it there. Give the parameter another name.`;
}

/** Why a global a hook's code reads is refused that the component's own `name` would answer. */
export function answered(name: string): string {
  return `\`${name}\` is a global, which the component's own \`${name}\` would answer where the authority computes the value. Give one of them another name.`;
}

/** Why a dynamic site's value reads none of these names of the component's. */
const UNREAD: Readonly<Record<'node' | 'self' | 'setter', (name: string) => string>> = {
  node: (name) =>
    `\`${name}\` holds nodes the authority renders once for the component, and a dynamic site is rendered again of values whenever the states they are made of change. Show them beside it, where they stand: \`{${name}}\`.`,
  self: (name) =>
    `\`${name}\` is the component's own name, which no value a dynamic site reads is computed of.`,
  setter: (name) =>
    `\`${name}\` is a setter, which the browser holds, and a dynamic site is rendered of values alone, which the authority computes again of the local states they are made of. Handle the event in the browser part, or in a \`'use client'\` component.`,
};

/** Why a dynamic site's value may not read `name`, a setter, nodes or the component's own name. */
export function unread(name: string, kind: keyof typeof UNREAD): string {
  return UNREAD[kind](name);
}

/** Why `name`, an import of `specifier`, no shared module, is refused in what a site's value is computed by. */
function unshared(name: string, specifier: string): string {
  return `\`${name}\` is \`${specifier}\`'s, no shared module of the application's — one the authority runs as the browser does — and ${COMPUTED_BY}.`;
}

/**
 * Why `name`, an import, is refused in what a site's value is computed by: of no shared module, or
 * of one that answers otherwise each time, or on each side, it runs; none of another.
 */
export function importRefusal(name: string, binding: ImportBinding): string | undefined {
  const { module } = binding;
  if (module.target.kind !== 'shared' || binding.typeOnly) {
    return unshared(name, module.specifier);
  }
  return module.target.unsettled === undefined
    ? undefined
    : unsettledModule(name, module.specifier, module.target.unsettled);
}

/**
 * Why `name`, read as `entry`, is refused where `reads` says what is read alike: of a shared module
 * that answers otherwise each time, or on each side, it runs; none of another.
 */
export function unsettledRefusal(
  name: string,
  entry: TopLevel,
  reads = COMPUTED_BY,
): string | undefined {
  if (entry.kind !== 'import') {
    return undefined;
  }
  const { module } = entry.binding;
  return module.target.unsettled === undefined
    ? undefined
    : unsettledModule(name, module.specifier, module.target.unsettled, reads);
}

/** What a list's key reads, as what it refuses says. */
export const KEY_READS =
  "the key of a list's item is computed by the browser as well as by the authority, and reads the item, the props, the globals of what they are given alone and the application's shared modules alone";

/** What a condition a site stands under reads, as what it refuses says. */
const CONDITION_READS =
  "a condition a dynamic site stands under is evaluated by the authority as well as by the browser — for the page's first render, of the states' first values — and reads the local states and what the browser computes of them, the props, the globals of what they are given alone and the application's shared modules alone";

/**
 * Why a condition a site stands under does not read `name`, where it may not — or what else both
 * sides compute, which `reads` says the reads of.
 */
export function refusedInCondition(
  name: string,
  entry: TopLevel,
  reads = CONDITION_READS,
): string | undefined {
  if (entry.kind === 'server') {
    return `\`${name}\` is computed in the server part, which the browser never has, and ${reads}. Give the browser what it needs as a state — \`useReactiveState(value)\` — or decide it on the server.`;
  }
  if (entry.kind === 'import' && entry.binding.module.target.kind !== 'shared') {
    return `\`${name}\` is \`${entry.binding.module.specifier}\`'s, which is no shared module of the application's — one that runs anywhere alike — and ${reads}.`;
  }
  return unsettledRefusal(name, entry, reads);
}

/**
 * Why `name`, an import of `specifier`, a shared module that answers otherwise each time, or on
 * each side, it runs (`ModuleClass.unsettled`), is refused where `reads` says what is read alike.
 */
function unsettledModule(
  name: string,
  specifier: string,
  reason: string,
  reads = COMPUTED_BY,
): string {
  return `\`${name}\` is \`${specifier}\`'s, a shared module that answers otherwise each time, or on each side, it runs — ${reason} — and ${reads}. Keep what it answers of chance, of the time or of where it runs, and what it keeps between calls, out of that module, or out of what a site is computed of.`;
}

/** Why `name`, of the server part, is refused in what a site's value is computed by. */
export function serverOnly(name: string): string {
  return `\`${name}\` is computed in the server part, which the browser never has, and ${COMPUTED_BY}.`;
}
