import {
  type Expression,
  type Identifier,
  isArrowFunction,
  isFunctionExpression,
  isParenthesizedExpression,
  type Node,
} from 'typescript/ast';

import { impureGlobal } from './alike.ts';
import type { OwnedState, TopLevel } from './analyze.ts';
import type { SiteInput } from './frames.ts';
import type { ImportBinding } from './imports.ts';
import { checkStateKinds } from './kinds.ts';
import { holdsAwait } from './locality.ts';
import { entryOf, type SideState } from './reads.ts';
import type { Visitor } from './scope.ts';
import type { Site } from './sites.ts';
import type { StateDeclaration } from './statements.ts';
import { writtenIn } from './writes.ts';

/**
 * What the states a component's dynamic sites read are held to (`sides.ts`): each is a local state —
 * one the authority starts of a value of the page's, which the page sends it again as it changes —
 * and a state the browser would start, which a site reads, is the authority's to start instead.
 */

/** A state the authority evaluates: its key, the expression it evaluates, and where it is declared. */
export interface Evaluated {
  readonly key: string;
  readonly input: Expression;
  readonly state: OwnedState;
  /**
   * The type its program writes what it starts from as, which the value itself would widen: the
   * type argument of a state the browser would start, which the authority evaluates for a dynamic
   * site that reads it — `useReactiveState<TodoFilter>('all')` — or the type a hook's parameter
   * gives a local state of the caller's argument. None for any other.
   */
  readonly type?: string;
  /**
   * Whether it starts from a value of the page's, never a field of the database (`holdsPageValue`):
   * a local state, whose setter is React's — the compile registers no update of it, and the page
   * sends nothing of it but what a dynamic site reads.
   */
  readonly local: boolean;
}

/** The names whose values the browser holds. */
export const BROWSER_VALUES: ReadonlySet<TopLevel['kind']> = new Set([
  'constant',
  'hooked',
  'setter',
  'state',
]);

export interface Walking {
  readonly state: SideState;
  readonly walking: (node: Node, visitor: Visitor, outer?: ReadonlySet<string>) => void;
}

/** The function a state's argument is, written there, if it is one. */
export function functionValue(input: Expression): Expression | undefined {
  let node = input;
  while (isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return isArrowFunction(node) || isFunctionExpression(node) ? node : undefined;
}

/** What a dynamic site is rendered of, as what a state it reads is refused for says. */
const LOCAL_ONLY =
  "a dynamic site is rendered of local states alone: each starts from a value the authority evaluates for the page's first render, and the page sends the authority its value, as JSON, as it changes";

/** What the argument of a state a site reads reads first, where it reads it: what it starts from. */
interface Start {
  /** A value of the browser's: a state, a setter, a constant, a hook's. */
  readonly browser?: Identifier;
  /** A value the server part computes. */
  readonly server?: Identifier;
  /** A name the server part writes into (`writtenIn`): a prop, a constant. */
  readonly written?: Identifier;
  /** A module that is no shared one. */
  readonly module?: ImportBinding;
  /** A shared module that answers otherwise each time, or on each side, it runs. */
  readonly unsettled?: ImportBinding;
  /** A global the authority has not, or answers otherwise. */
  readonly global?: Identifier;
}

export function startOf(input: Expression, { state, walking }: Walking): Start {
  const found: { -readonly [Key in keyof Start]: Start[Key] } = {};
  walking(input, {
    global: (identifier) => {
      if (impureGlobal(identifier.text) !== undefined) {
        found.global ??= identifier;
      }
    },
    read: (identifier, space) => {
      if (space !== 'value') {
        return;
      }
      const entry = entryOf(state, identifier);
      if (writtenIn(state.component).has(identifier.text)) {
        found.written ??= identifier;
      }
      if (BROWSER_VALUES.has(entry.kind)) {
        found.browser ??= identifier;
      } else if (entry.kind === 'server') {
        found.server ??= identifier;
      } else if (entry.kind === 'import' && entry.binding.module.target.kind !== 'shared') {
        found.module ??= entry.binding;
      } else if (entry.kind === 'import' && entry.binding.module.target.unsettled !== undefined) {
        found.unsettled ??= entry.binding;
      }
    },
  });
  return found;
}

/**
 * The states the dynamic sites read — what their elements render with, and what their conditions
 * test — each of which the authority starts, for the page's first render, as a local state: one it
 * evaluates already, where it starts from the props alone; one the browser would start, where it
 * starts from what the authority has as well and answers alike — literals, shared modules, the
 * globals of what they are given alone — which the authority evaluates now. Any other is refused
 * where a site reads it first. Answers those it evaluates now.
 */
export function checkSiteStates(
  sites: readonly Site[],
  context: Walking & { readonly evaluated: ReadonlyMap<OwnedState, readonly Evaluated[]> },
): ReadonlySet<StateDeclaration> {
  // A hook's state a site reads is one its parameter declares, of a value of the page's, which the
  // derivation checked; the component's own are checked here.
  const found = sites
    .flatMap((site) => [...site.inputs, ...site.guarded])
    .flatMap((input) => (input.state === undefined ? [] : [{ ...input, state: input.state }]))
    .toSorted((a, b) => a.at.pos - b.at.pos);
  const checked = new Set<StateDeclaration>();
  const promoted = new Set<StateDeclaration>();
  for (const read of found) {
    if (checked.has(read.state)) {
      continue;
    }
    checked.add(read.state);
    const evaluated = context.evaluated.get(read.state);
    if (evaluated === undefined) {
      checkStarted(read, context);
      promoted.add(read.state);
    } else if (evaluated.some((each) => !each.local)) {
      checkEvaluated(read, context);
    }
    // What the state starts from is refused first, as it is; then what kinds of JSON it holds.
    const { component, fail, file, modules } = context.state;
    const at = { file, sourceFile: component.sourceFile };
    checkStateKinds(read.state, { at, component, modules }, fail);
  }
  return promoted;
}

/**
 * Refuses a state a site reads that the authority evaluates of more than a value of the page's
 * (`holdsPageValue`), as what makes it so says: what the server part computes, a module only the
 * authority runs, what the server part writes into — a prop too — what it awaits; and any other.
 */
function checkEvaluated(read: ComponentInput, context: Walking): never {
  const { fail } = context.state;
  const name = read.state.value.text;
  const { module, server, written } = startOf(read.state.input, context);
  if (server !== undefined) {
    fail(
      `\`${name}\` starts from what the server part computes — \`${server.text}\` — which could be a field of the database, which binds a state rather than starting it, and ${LOCAL_ONLY}. Start the state from a prop, or give the reactive component what it reads the field by, and have it read the field itself.`,
      read.at,
    );
  }
  if (module !== undefined) {
    fail(
      `\`${name}\` starts from \`${module.module.specifier}\`'s, which is no shared module of the application's and could give it a field of the database, which binds a state rather than starting it, and ${LOCAL_ONLY}. Start the state from a prop, or have the reactive component read what it needs itself.`,
      read.at,
    );
  }
  if (written !== undefined) {
    fail(
      `\`${name}\` starts from \`${written.text}\`, which the server part writes into — a field of the database among what it may write — which binds a state rather than starting it, and ${LOCAL_ONLY}. Start the state from a prop the server part leaves as it is, or give the reactive component what it reads the field by, and have it read the field itself.`,
      read.at,
    );
  }
  if (holdsAwait(read.state.input)) {
    fail(
      `\`${name}\` starts from what the server part awaits, which could be a field of the database, which binds a state rather than starting it, and ${LOCAL_ONLY}. Start the state from a prop, or give the reactive component what it reads the field by, and have it read the field itself.`,
      read.at,
    );
  }
  return fail(
    `\`${name}\` starts from what is no value of the page's alone — no prop, literal, shared module's, global of what it is given alone or \`const\` of these — which could be a field of the database, and ${LOCAL_ONLY}. Start the state from a prop, or give the reactive component what it reads the field by, and have it read the field itself.`,
    read.at,
  );
}

/** A state of the component's own a site reads, where it reads it first. */
type ComponentInput = SiteInput & { readonly state: StateDeclaration };

/** Refuses a state a site reads that the browser starts from what the authority has not. */
function checkStarted(read: ComponentInput, context: Walking): void {
  const { fail } = context.state;
  const name = read.state.value.text;
  if (functionValue(read.state.input) !== undefined) {
    fail(
      `\`${name}\` starts from a function, which React calls in the browser, and ${LOCAL_ONLY}. Start it from the value itself: a prop, a literal, a shared module's, or a global of what it is given alone.`,
      read.at,
    );
  }
  const { browser, global, module, unsettled } = startOf(read.state.input, context);
  if (global !== undefined) {
    fail(
      `\`${name}\` starts from \`${global.text}\`, a global the authority has not, or answers otherwise — of the time, of chance, of where it runs — which starts the state for the page's first render, and ${LOCAL_ONLY}. Start it from a prop, a literal, a shared module's value, or a global of what it is given alone.`,
      read.at,
    );
  }
  if (browser !== undefined) {
    fail(
      `\`${name}\` starts from \`${browser.text}\`, a value of the browser's, which the authority does not have for the page's first render, and ${LOCAL_ONLY}. Start it from a prop, a literal, a shared module's value, or a global of what it is given alone.`,
      read.at,
    );
  }
  if (module !== undefined) {
    fail(
      `\`${name}\` starts from \`${module.module.specifier}\`'s, which is no shared module of the application's — one the authority runs as the browser does — and ${LOCAL_ONLY}. Start it from a prop, a literal, a shared module's value, or a global of what it is given alone.`,
      read.at,
    );
  }
  const reason = unsettled?.module.target.unsettled;
  if (unsettled !== undefined && reason !== undefined) {
    fail(
      `\`${name}\` starts from \`${unsettled.module.specifier}\`'s, a shared module that answers otherwise each time, or on each side, it runs — ${reason} — which the browser and the authority each start the state of for the page's first render, and ${LOCAL_ONLY}. Start it from a prop, a literal, a shared module's value of what it is given alone, or a global of what it is given alone.`,
      read.at,
    );
  }
}
