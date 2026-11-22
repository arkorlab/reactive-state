import {
  type CallExpression,
  type Expression,
  type Identifier,
  isIdentifier,
  isJsxElement,
  isJsxSelfClosingElement,
  isSpreadElement,
  type Node,
  type ReturnStatement,
  type VariableStatement,
} from 'typescript/ast';

import { type Component, DOLLAR, type HookCall, type OwnedState } from './analyze.ts';
import { Derivation } from './derive.ts';
import { checkJson } from './json-values.ts';
import { isIntrinsicTag } from './jsx.ts';
import { holdsPageValue } from './locality.ts';
import type { ModuleKind, Modules } from './modules.ts';
import { canOmit } from './omitted-work.ts';
import {
  authorityVisitor,
  browserVisitor,
  Collected,
  entryOf,
  functionsOf,
  type Reads,
  type Ref,
  type SideState,
} from './reads.ts';
import { bindingIdentifiers, type Names, type Space, type Visitor, walk } from './scope.ts';
import { siteProxyOrigin } from './site-proxies.ts';
import {
  BROWSER_VALUES,
  checkSiteStates,
  type Evaluated,
  functionValue,
  startOf,
  type Walking,
} from './site-states.ts';
import { readSites, type Site } from './sites.ts';
import { findSlots, type Slot } from './slots.ts';
import type { StateDeclaration } from './statements.ts';

export { type Reads, type Ref } from './reads.ts';

/**
 * Which side of the boundary each part of a component runs on. The server part, the argument of
 * each state the authority evaluates, each slot and each dynamic site run on the authority; the rest
 * — a state the browser starts, the constants after the state and the JSX — runs in the browser
 * (`reads.ts` says what each may read there).
 *
 * A state's argument is the authority's to evaluate where it reads a value the server part has — a
 * prop, what the server part computes, a module only the authority runs — and none of the
 * browser's; the engine tells at run time a field it binds from a value a local state starts from.
 * A state a dynamic site reads is the authority's to evaluate too, where it starts from what the
 * authority has as well as the browser: the site is rendered of it on the authority.
 */

/** Whether `name` is read on a side at all — at run time or in a type. */
export function reads(usage: Reads, name: string): boolean {
  return usage.values.has(name) || usage.types.has(name);
}

/** What the authority's program refers to by reference, by the name the component imports it by. */
interface Refs {
  /** Reactive components, by id. */
  readonly components: ReadonlyMap<string, string>;
  /** Components the host renders, by specifier and export. */
  readonly modules: ReadonlyMap<string, Ref>;
  /** Server operations, by module id and export. */
  readonly actions: ReadonlyMap<string, Ref>;
}

export interface Sides {
  /** What the authority's program reads. */
  readonly authority: Reads;
  /** What the Client Component reads. */
  readonly browser: Reads;
  readonly refs: Refs;
  /** The states the authority evaluates, in the order they are declared. */
  readonly evaluated: readonly Evaluated[];
  /** The states declared with `useReactiveState` that the browser starts. */
  readonly local: ReadonlySet<StateDeclaration>;
  /**
   * Constants only dynamic sites read whose initialization runs no application work, which the
   * Client Component may omit while the authority computes their values again.
   */
  readonly dropped: ReadonlySet<VariableStatement>;
  readonly slots: readonly Slot[];
  /** The dynamic sites of the browser's JSX, in the order they stand in it. */
  readonly sites: readonly Site[];
  /** What the sites read of the browser's values, followed back to the states they are made of. */
  readonly derivation: Derivation;
}

/** Names the code of a component may neither declare nor read: what its outputs read within it. */
const RESERVED_IN_CODE: ReadonlyMap<string, string> = new Map([['$', DOLLAR]]);

/** The modules whose values the authority reads for a state, which make it the authority's to evaluate. */
const SERVER_MODULES: ReadonlySet<ModuleKind> = new Set(['operations', 'package', 'server']);
/** The modules whose values the browser has, which make a state the browser's to start. */
const BROWSER_MODULES: ReadonlySet<ModuleKind> = new Set(['client', 'element', 'hooks']);
export interface SideContext {
  readonly component: Component;
  readonly modules: Modules;
  /** The component's file, which its specifiers are resolved from. */
  readonly file: string;
}

export function resolveSides(context: SideContext): Sides {
  const { component } = context;
  const state: SideState = {
    actions: new Map(),
    authority: new Collected(),
    browser: new Collected(),
    component,
    components: new Map(),
    elements: new Map(),
    fail: component.fail,
    file: context.file,
    libraries: new Set(),
    modules: context.modules,
    serverFunctions: functionsOf(component.server),
    siteElements: [],
    slots: [],
  };
  const names: Names = {
    declared: component.declared,
    declaring: component.declaring,
    reserved: RESERVED_IN_CODE,
    topLevel: new Set(component.names.keys()),
  };
  const walking = (node: Node, visitor: Visitor, outer?: ReadonlySet<string>): void => {
    walk(node, outer === undefined ? names : { ...names, outer }, visitor, component.fail);
  };
  for (const statement of component.server) {
    walking(statement, authorityVisitor(state, false));
  }
  const { evaluated, started } = statesOf({ state, walking });
  const { returned } = component;
  const derived = authorityVisitor(state, true);
  const derivation = new Derivation({
    authority: (identifier, space) => {
      derived.read(identifier, space);
    },
    component,
    reserved: RESERVED_IN_CODE,
    walking,
  });
  const sites = returned === undefined ? [] : findSites(returned, { derivation, state, walking });
  const proxy = siteProxyOrigin(sites, state);
  if (proxy !== undefined) {
    state.fail(
      'A Proxy intermediate cannot be measured without invoking application traps; return an ordinary value from the shared helper.',
      proxy,
    );
  }
  const promoted = checkSiteStates(sites, { evaluated, state, walking });
  const local = new Set<StateDeclaration>();
  for (const declared of started) {
    if (promoted.has(declared)) {
      evaluated.set(declared, [promotedSide(declared, { state, walking })]);
    } else {
      walkTypes(declared.call, { state, walking });
      walking(declared.input, browserVisitor(state));
      local.add(declared);
    }
  }
  const dropped =
    returned === undefined
      ? new Set<VariableStatement>()
      : walkReturned(returned, sites, { derivation, state, walking });
  return {
    authority: state.authority,
    browser: state.browser,
    derivation,
    dropped,
    evaluated: component.states.flatMap((owned) => evaluated.get(owned) ?? []),
    local,
    refs: { actions: state.actions, components: state.components, modules: state.elements },
    sites,
    slots: state.slots,
  };
}

/**
 * The states the authority evaluates, by the statement that declares them, and those declared with
 * `useReactiveState` the browser would start, whose inputs are walked once the sites say whether
 * the authority starts them after all.
 */
function statesOf({ state, walking }: Walking): {
  readonly evaluated: Map<OwnedState, readonly Evaluated[]>;
  readonly started: readonly StateDeclaration[];
} {
  const evaluated = new Map<OwnedState, readonly Evaluated[]>();
  const started: StateDeclaration[] = [];
  for (const owned of state.component.states) {
    checkNodes(owned, { state, walking });
    if (owned.kind !== 'state') {
      evaluated.set(owned, hookCallSide(owned, { state, walking }));
    } else if (evaluatedByAuthority(state, owned.input, walking)) {
      evaluated.set(owned, [stateSide(owned, { state, walking })]);
    } else {
      started.push(owned);
    }
  }
  return { evaluated, started };
}

/**
 * Walks what the JSX the component returns runs on each side: each slot on the authority, the
 * constants and the JSX in the browser — the sites' elements aside, which the sites walked — and
 * each site's inputs, which the Client Component hands the site by their names. A constant only
 * sites read, which the authority computes again of the states they are sent, the browser computes
 * no more: walked last first, each is left out where nothing the browser keeps reads it — again
 * until what is kept reads no more of them, as a function kept may read one declared after it,
 * `const again = () => setFilter(shown)`. Answers those left out.
 */
function walkReturned(
  returned: ReturnStatement,
  sites: readonly Site[],
  { derivation, state, walking }: Walking & { readonly derivation: Derivation },
): ReadonlySet<VariableStatement> {
  for (const slot of state.slots) {
    walking(slot.unit, authorityVisitor(state, true));
  }
  walking(returned, browserVisitor(state));
  // A list's key the browser computes too, beside its item, though it stand on the site's element.
  for (const { list } of sites) {
    if (list !== undefined) {
      walking(list.key, browserVisitor(state, true), new Set([list.item.text]));
    }
  }
  // The Client Component holds the value of each state a site is sent, by the name it binds.
  const sent = sites.flatMap((site) => site.sent);
  for (const input of sent) {
    if (input.browser.kind === 'name') {
      state.browser.add(input.browser.name, 'value');
    }
  }
  return leftOut({ derivation, state, walking });
}

/**
 * The constants the browser leaves out (`isLeftOut`), each it keeps walked, last first, again until
 * what it keeps reads no more of them.
 */
function leftOut({
  derivation,
  state,
  walking,
}: Walking & { readonly derivation: Derivation }): ReadonlySet<VariableStatement> {
  const dropped = new Set<VariableStatement>();
  const kept = new Set<VariableStatement>();
  for (let walked = true; walked;) {
    walked = false;
    for (const statement of state.component.constants.toReversed()) {
      if (kept.has(statement)) {
        continue;
      }
      if (isLeftOut(statement, { derivation, state })) {
        dropped.add(statement);
        continue;
      }
      dropped.delete(statement);
      kept.add(statement);
      walking(statement, browserVisitor(state));
      walked = true;
    }
  }
  return dropped;
}

/** Whether only sites read the constant and leaving its initialization out skips no application work. */
function isLeftOut(
  statement: VariableStatement,
  { derivation, state }: { readonly derivation: Derivation; readonly state: SideState },
): boolean {
  const { declarations } = statement.declarationList;
  const names = declarations.flatMap((declaration) => bindingIdentifiers(declaration.name));
  const read = names.some((name) => reads(state.browser, name.text));
  return !read && canOmit(statement) && derivation.computes(declarations);
}

/**
 * The slots of the browser's JSX, and its dynamic sites: the reactive elements no slot holds, each
 * read for the states it renders with.
 */
function findSites(
  returned: ReturnStatement,
  { derivation, state, walking }: Walking & { readonly derivation: Derivation },
): readonly Site[] {
  const { component } = state;
  const found = findSlots(
    returned,
    {
      isReactive: (element) => isReactive(component, element),
      nodes: nodeReads(returned, { state, walking }),
      readsBrowser: (node) => readsBrowser(state, node, walking),
    },
    component.fail,
  );
  state.slots = found.slots;
  state.siteElements = found.sites;
  return readSites(found.sites, { derivation, returned, state, walking });
}

/** A state declared with `useReactiveState` the authority evaluates: one that reads the server's. */
function stateSide(declared: StateDeclaration, { state, walking }: Walking): Evaluated {
  checkValue(state, declared.input);
  walking(declared.input, authorityVisitor(state, false));
  return {
    input: declared.input,
    key: declared.value.text,
    local: holdsPageValue(declared.input, { state, walking }),
    state: declared,
  };
}

/**
 * A state the browser would start that a dynamic site reads, which the authority evaluates instead,
 * typed as its type argument types it: a local state, of what the browser has as well.
 */
function promotedSide(declared: StateDeclaration, { state, walking }: Walking): Evaluated {
  checkJson(state, declared.input);
  walking(declared.input, authorityVisitor(state, false));
  const [type] = declared.call.typeArguments ?? [];
  if (type !== undefined) {
    walking(type, authorityVisitor(state, false));
  }
  return {
    input: declared.input,
    key: declared.value.text,
    local: true,
    state: declared,
    ...(type !== undefined && { type: type.getText(state.component.sourceFile) }),
  };
}

/** Walks the type arguments of a call the Client Component makes as the component wrote it. */
function walkTypes(call: CallExpression, { state, walking }: Walking): void {
  const types = call.typeArguments;
  if (types !== undefined) {
    for (const type of types) {
      walking(type, browserVisitor(state));
    }
  }
}

/**
 * A custom hook's call: each argument a state of the hook is declared with as it is, which the
 * authority evaluates, and the rest, which the browser passes.
 */
function hookCallSide(call: HookCall, { state, walking }: Walking): readonly Evaluated[] {
  const evaluated: Evaluated[] = [];
  for (const [index, argument] of call.call.arguments.entries()) {
    const fed = call.hook.feeds.get(index);
    if (isSpreadElement(argument)) {
      state.fail(
        `\`${call.callee.text}\` is called with its arguments one by one: the compiler binds each to its parameter.`,
        argument,
      );
    }
    if (fed === undefined) {
      walking(argument, browserVisitor(state));
      continue;
    }
    const persistent = call.hook.fed.get(fed)?.persistent ?? false;
    if (persistent && !evaluatedByAuthority(state, argument, walking)) {
      state.fail(
        `\`${call.callee.text}\` declares a state with this argument as it is, which the authority evaluates for the browser: it is a value the server part has — a field of the database, a prop — and none of the browser's.`,
        argument,
      );
    }
    // Where the value comes from first: a constant the server part writes to is no value of the
    // page's, whatever is written (`locality.ts`).
    if (
      !persistent &&
      (!holdsPageValue(argument, { state, walking }) ||
        startOf(argument, { state, walking }).global !== undefined)
    ) {
      state.fail(
        `\`${call.callee.text}\` declares a local state with this argument as it is — its parameter is no \`FieldRef<T>\` — which the authority evaluates for the browser: a value of the page's, read of the props, literals, the application's shared modules, what the server part declares with \`const\` of these and of globals alone, and the globals of what they are given alone. Give it such a value, or type the hook's parameter \`FieldRef<T>\` to bind a field of the database.`,
        argument,
      );
    }
    checkValue(state, argument);
    walking(argument, authorityVisitor(state, false));
    const type = persistent ? undefined : call.hook.fed.get(fed)?.type;
    evaluated.push({
      input: argument,
      key: `${call.prefix}${fed}`,
      local: !persistent,
      state: call,
      ...(type !== undefined && { type }),
    });
  }
  walkTypes(call.call, { state, walking });
  // The hook is the Client Component's to call, imported from the copy the compile writes of it.
  state.browser.add(call.callee, 'value');
  return evaluated;
}

/**
 * Whether the authority evaluates a state's argument: it reads a value the server part has — a
 * prop, what the server part computes, a module only the authority runs — and none of the
 * browser's. A literal, a global or a shared module alone is the browser's to start from.
 */
function evaluatedByAuthority(state: SideState, input: Node, walking: Walking['walking']): boolean {
  const found = { browser: false, server: false };
  const read = (identifier: Identifier, space: Space): void => {
    if (space !== 'value') {
      return;
    }
    const entry = entryOf(state, identifier);
    if (entry.kind === 'prop' || entry.kind === 'server') {
      found.server = true;
    } else if (entry.kind === 'import') {
      const { kind } = entry.binding.module.target;
      found.server ||= SERVER_MODULES.has(kind);
      found.browser ||= BROWSER_MODULES.has(kind);
    } else {
      found.browser ||= BROWSER_VALUES.has(entry.kind);
    }
  };
  walking(input, { read });
  return found.server && !found.browser;
}

/** Refuses a function as what the authority evaluates for a state: it sends values alone. */
function checkValue(state: SideState, input: Expression): void {
  checkJson(state, input);
  const fn = functionValue(input);
  if (fn !== undefined) {
    state.fail(
      'A state the authority evaluates starts from a value — a field of the database, or a value the server part computed — and not from a function: the authority sends what it evaluates to the browser.',
      fn,
    );
  }
}

/** Whether a component is given nodes: a prop that holds them (`children`). */
function hasNodes(component: Component): boolean {
  return component.props.some((prop) => prop.node);
}

/** Refuses a prop that holds nodes read by a state's statement: a state holds JSON alone. */
function checkNodes(owned: OwnedState, { state, walking }: Walking): void {
  if (!hasNodes(state.component)) {
    return;
  }
  walking(owned.call, {
    read: (identifier, space) => {
      if (space === 'value' && entryOf(state, identifier).kind === 'node') {
        state.fail(
          `\`${identifier.text}\` holds nodes the authority renders, and a state holds JSON, which the browser holds and sends: show them where they stand in the JSX the component returns — \`{${identifier.text}}\` — in a slot.`,
          identifier,
        );
      }
    },
  });
}

/** Each read, in the JSX the component returns, of a prop that holds nodes. */
function nodeReads(returned: ReturnStatement, { state, walking }: Walking): readonly Identifier[] {
  const found: Identifier[] = [];
  if (hasNodes(state.component)) {
    walking(returned, {
      read: (identifier, space) => {
        if (space === 'value' && entryOf(state, identifier).kind === 'node') {
          found.push(identifier);
        }
      },
    });
  }
  return found;
}

/** Whether an element renders a reactive component the component imports. */
function isReactive(component: Component, element: Node): boolean {
  if (!(isJsxElement(element) || isJsxSelfClosingElement(element))) {
    return false;
  }
  const tag = isJsxElement(element) ? element.openingElement.tagName : element.tagName;
  // A tag React takes for the browser's own is none of a component's, whatever the name imports.
  if (!isIdentifier(tag) || isIntrinsicTag(tag.text)) {
    return false;
  }
  const entry = component.names.get(tag.text);
  return entry?.kind === 'import' && entry.binding.module.target.kind === 'component';
}

/** Whether `node` reads one of the browser's values. */
function readsBrowser(state: SideState, node: Node, walking: Walking['walking']): boolean {
  let found = false;
  const read = (identifier: Identifier, space: Space): void => {
    if (space === 'value') {
      found ||= BROWSER_VALUES.has(entryOf(state, identifier).kind);
    }
  };
  walking(node, { read });
  return found;
}
