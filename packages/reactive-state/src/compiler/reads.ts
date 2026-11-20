import {
  type Identifier,
  isArrowFunction,
  isAwaitExpression,
  isCallExpression,
  isClassExpression,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxClosingElement,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isVariableStatement,
  type Node,
  type Statement,
} from 'typescript/ast';

import type { Component, TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import { type ImportBinding, INTRINSIC } from './imports.ts';
import type { ModuleKind, Modules } from './modules.ts';
import { checkRunTimeImport, checkServerNode } from './prefix.ts';
import { type Space, type Visitor, withinFunction } from './scope.ts';
import { isWrittenAt } from './shared-import-writes.ts';
import type { ReactiveElement, Slot } from './slots.ts';
import { functionOf } from './statements.ts';

/**
 * What each side of a component may read of its names, and what each read makes of the outputs:
 * an import the authority's program writes, a reference it renders an element by, a module the
 * Client Component imports. The browser never has a server value, nor a module only the authority
 * runs; the authority renders what the browser imports by reference, and runs nothing of it.
 */

/** What one side reads of the component's top-level names. */
export interface Reads {
  /** Each name read at run time, at every place it is read, in order. */
  readonly values: ReadonlyMap<string, readonly Identifier[]>;
  /** Each name a type of the side's names. */
  readonly types: ReadonlySet<string>;
}

/** Reads, as a walk collects them. */
export class Collected implements Reads {
  readonly values = new Map<string, Identifier[]>();
  readonly types = new Set<string>();

  add(identifier: Identifier, space: Space): void {
    if (space === 'type') {
      this.types.add(identifier.text);
      return;
    }
    const at = this.values.get(identifier.text);
    if (at === undefined) {
      this.values.set(identifier.text, [identifier]);
    } else {
      at.push(identifier);
    }
  }
}

/** An export the authority renders, or binds, by reference: its module and its name. */
export interface Ref {
  readonly module: string;
  readonly name: string;
}

/** What a walk of a component's sides holds as it goes. */
export interface SideState {
  readonly component: Component;
  readonly fail: Fail;
  readonly modules: Modules;
  /** The component's file, which its specifiers are resolved from. */
  readonly file: string;
  readonly authority: Collected;
  readonly browser: Collected;
  /** Reactive components the authority renders by reference, by id. */
  readonly components: Map<string, string>;
  /** Components the host renders, by specifier and export. */
  readonly elements: Map<string, Ref>;
  /** Server operations the authority binds, by module id and export. */
  readonly actions: Map<string, Ref>;
  /** The files of each library the authority reads, by every name they may be imported by. */
  readonly libraries: Set<string>;
  /** The names the server part declares that hold a function. */
  readonly serverFunctions: ReadonlySet<string>;
  /** The slots the browser's JSX renders on the authority, once they are found. */
  slots: readonly Slot[];
  /** The elements of the dynamic sites the authority renders of local states, once they are found. */
  siteElements: readonly ReactiveElement[];
}

const INTRINSIC_ONLY = `\`${INTRINSIC}\` is called to declare a state, and for nothing else: \`const [value, setValue] = ${INTRINSIC}(initial)\`, each on its own, after the server part.`;
const OWN_NAME =
  "The component does not read its own name: the authority's program holds no component, and the Client Component written for it is another function.";
const RSC_SHARED_ONLY =
  "is read in JSX the authority renders, where an expression reads the server part's values, props, globals and the application's shared modules alone — a module that runs anywhere alike: read it in the server part, and render the value.";

/** The modules whose components the authority renders by reference, as an element's type. */
const RENDERED_BY_REFERENCE: ReadonlySet<ModuleKind> = new Set([
  'client',
  'component',
  'element',
  'package',
]);

/** What the top-level name `identifier` reads is. */
export function entryOf(state: SideState, identifier: Identifier): TopLevel {
  const entry = state.component.names.get(identifier.text);
  if (entry === undefined) {
    throw new Error(`\`${identifier.text}\` was read as a top-level name, which it is not.`);
  }
  return entry;
}

function refuseIntrinsic(state: SideState): (identifier: Identifier) => void {
  return (identifier) => {
    if (identifier.text === INTRINSIC) {
      state.fail(INTRINSIC_ONLY, identifier);
    }
  };
}

/** The visitor of what runs on the authority: in JSX it renders (`rsc`), or anywhere in it. */
export function authorityVisitor(state: SideState, rsc: boolean): Visitor {
  const { declared } = state.component;
  return {
    global: refuseIntrinsic(state),
    node: (node) => {
      checkServerNode(node, declared, state.fail);
      checkRenderedValue(state, node);
    },
    read: (identifier, space) => {
      authorityRead(state, identifier, { rsc: rsc || withinJsx(identifier), space });
    },
    unresolved: (identifier) => {
      state.fail(unresolved(identifier, "is not in the authority's scope here"), identifier);
    },
  };
}

function authorityRead(
  state: SideState,
  identifier: Identifier,
  at: { readonly space: Space; readonly rsc: boolean },
): void {
  const entry = entryOf(state, identifier);
  if (at.space === 'type') {
    state.authority.add(identifier, at.space);
    return;
  }
  switch (entry.kind) {
    case 'intrinsic': {
      state.fail(INTRINSIC_ONLY, identifier);
      break;
    }
    case 'self': {
      state.fail(OWN_NAME, identifier);
      break;
    }
    case 'import': {
      authorityImport(state, identifier, { binding: entry.binding, rsc: at.rsc });
      break;
    }
    case 'state':
    case 'setter':
    case 'hooked': {
      state.fail(
        `\`${identifier.text}\` is a state's, which the browser holds: what the authority runs — the server part, what a state starts from, a slot — never has it.`,
        identifier,
      );
      break;
    }
    case 'constant': {
      state.fail(
        `\`${identifier.text}\` is computed after the state, in the browser: what the authority runs — the server part, what a state starts from, a slot — never has it.`,
        identifier,
      );
      break;
    }
    case 'node':
    case 'prop':
    case 'server': {
      state.authority.add(identifier, at.space);
      break;
    }
    case 'module':
    case 'param': {
      throw new Error(`\`${identifier.text}\` is no name of a component's.`);
    }
  }
}

function authorityImport(
  state: SideState,
  identifier: Identifier,
  read: { readonly binding: ImportBinding; readonly rsc: boolean },
): void {
  const { binding } = read;
  const { module } = binding;
  const { kind } = module.target;
  if (binding.typeOnly) {
    state.fail(
      `\`${identifier.text}\` is imported as a type, which has no value at run time.`,
      identifier,
    );
  }
  if (isTagName(identifier)) {
    if (!RENDERED_BY_REFERENCE.has(kind)) {
      state.fail(
        `\`${identifier.text}\` is \`${module.specifier}\`'s, which renders no element the authority can name: an element's type is a tag of the browser's, a reactive component, or a component of a \`'use client'\` module or a library's.`,
        identifier,
      );
    }
    elementType(state, identifier, binding);
    return;
  }
  switch (kind) {
    case 'component':
    case 'client':
    case 'element': {
      state.fail(
        `\`${identifier.text}\` is \`${module.specifier}\`'s, which the authority renders by reference, as an element — \`<${identifier.text} … />\` — and reads nothing else of.`,
        identifier,
      );
      break;
    }
    case 'operations': {
      action(state, identifier, binding);
      break;
    }
    case 'hooks': {
      state.fail(
        `\`${identifier.text}\` is a custom hook's module's, which the browser runs: a custom hook is called with the states, after the server part.`,
        identifier,
      );
      break;
    }
    case 'shared': {
      if (isWrittenAt(identifier)) {
        state.fail(
          `\`${identifier.text}\` is \`${module.specifier}\`'s, a shared module of the application's, and the authority runs this code in its own copy of the module, which every session shares: a write here stays for the next render of any. Copy it — \`const mine = { ...${identifier.text} }\` — and write the copy, or keep the value in a state.`,
          identifier,
        );
      }
      state.authority.add(identifier, 'value');
      break;
    }
    case 'server':
    case 'package': {
      if (read.rsc) {
        state.fail(
          `\`${identifier.text}\` is \`${module.specifier}\`'s, and ${RSC_SHARED_ONLY}`,
          identifier,
        );
      }
      state.authority.add(identifier, 'value');
      if (kind === 'package') {
        for (const identity of state.modules.identities(
          module.specifier,
          state.file,
          'authority',
        )) {
          state.libraries.add(identity);
        }
      }
      break;
    }
  }
}

/** An element's type the authority renders by reference: a reactive component, or the host's. */
function elementType(state: SideState, identifier: Identifier, binding: ImportBinding): void {
  const { module } = binding;
  if (binding.form === 'namespace') {
    state.fail(
      `\`${identifier.text}\` imports \`${module.specifier}\` whole: the authority renders a component by its export's name, so import it by name.`,
      identifier,
    );
  }
  if (module.target.kind !== 'component') {
    state.elements.set(identifier.text, { module: module.specifier, name: binding.exported });
    return;
  }
  const { id } = module.target;
  if (id === undefined || binding.form !== 'default') {
    state.fail(
      `\`${identifier.text}\` is a reactive component of the compile's source directory, its file's default export: \`import ${identifier.text} from '…/${identifier.text}.reactive'\`.`,
      identifier,
    );
  }
  state.components.set(identifier.text, id);
}

/** A server operation the authority binds by reference: given to a form, or bound, never called. */
function action(state: SideState, identifier: Identifier, binding: ImportBinding): void {
  const { module } = binding;
  const { parent } = identifier;
  if (binding.form === 'namespace') {
    state.fail(
      `\`${identifier.text}\` imports \`${module.specifier}\` whole: the authority binds a server operation by its export's name, so import it by name.`,
      identifier,
    );
  }
  if (isCallExpression(parent) && parent.expression === identifier) {
    state.fail(
      `\`${identifier.text}\` is a server operation, which a person's action runs, not a render: give it to a form — \`action={${identifier.text}.bind(null, …)}\` — and call nothing while rendering.`,
      identifier,
    );
  }
  if (
    isPropertyAccessExpression(parent) &&
    parent.expression === identifier &&
    parent.name.getText() !== 'bind'
  ) {
    state.fail(
      `\`${identifier.text}\` is a server operation, which the authority holds by reference: it is given as it is, or bound — \`${identifier.text}.bind(null, …)\` — and nothing else.`,
      parent,
    );
  }
  const { id } = module.target;
  if (id === undefined) {
    state.fail(
      `\`${module.specifier}\` is a \`'use server'\` module outside the compile's source directory, which the compile registers its operations from.`,
      identifier,
    );
  }
  state.actions.set(identifier.text, { module: id, name: binding.exported });
}

/**
 * Refuses a function given to what the authority renders, where the compile sees one: a prop or a
 * child the host cannot receive, since the rendered tree is data.
 */
function checkRenderedValue(state: SideState, node: Node): void {
  if (
    !isJsxExpression(node) ||
    node.expression === undefined ||
    !(isJsxAttribute(node.parent) || isJsxElement(node.parent) || isJsxFragment(node.parent))
  ) {
    return;
  }
  let value = node.expression;
  while (isParenthesizedExpression(value)) {
    value = value.expression;
  }
  const named = isIdentifier(value) && state.serverFunctions.has(value.text);
  if (named || isArrowFunction(value) || isFunctionExpression(value) || isClassExpression(value)) {
    state.fail(
      "What the authority renders is data, which holds no function: a handler, a render prop or a callback belongs to a component of the browser's — a `'use client'` component, or the client part of one with state. A server operation is given as it is, or bound.",
      value,
    );
  }
}

/**
 * The visitor of what runs in the browser: the JSX, the constants, a state the browser starts. What
 * a slot holds, and the element of a dynamic site, are the authority's to render, and walked as such.
 */
export function browserVisitor(state: SideState, everywhere = false): Visitor {
  const { declaration, declared } = state.component;
  // What the authority renders in the browser's place — a slot, a site's element — the browser
  // runs nothing of; `everywhere`, for what the browser runs of it all the same: a list's key.
  const rendered = (node: Node): boolean => {
    return (
      !everywhere &&
      (state.slots.some((slot) => within(node, slot.unit)) ||
        state.siteElements.some((element) => within(node, element)))
    );
  };
  return {
    global: refuseIntrinsic(state),
    node: (node) => {
      if (!rendered(node)) {
        checkBrowserNode(node, declaration, declared, state.fail);
      }
    },
    read: (identifier, space) => {
      if (!rendered(identifier)) {
        browserRead(state, identifier, space);
      }
    },
    unresolved: (identifier) => {
      state.fail(unresolved(identifier, 'is not available in the browser here'), identifier);
    },
  };
}

/** Whether `node` stands within `outer`. */
function within(node: Node, outer: Node): boolean {
  return node.pos >= outer.pos && node.end <= outer.end;
}

function browserRead(state: SideState, identifier: Identifier, space: Space): void {
  const entry = entryOf(state, identifier);
  if (entry.kind === 'node') {
    state.fail(
      `\`${identifier.text}\` holds nodes the authority renders, which the browser shows where they stand in the JSX the component returns — \`{${identifier.text}}\` — in a slot, and reads nowhere else: a constant, or any other code of the browser's, never has them.`,
      identifier,
    );
  }
  if (space === 'type') {
    if (entry.kind === 'server') {
      state.fail(
        `\`${identifier.text}\` is declared in the server part, which the authority runs; the browser's code cannot name it.`,
        identifier,
      );
    }
    state.browser.add(identifier, space);
    return;
  }
  switch (entry.kind) {
    case 'intrinsic': {
      state.fail(INTRINSIC_ONLY, identifier);
      break;
    }
    case 'self': {
      state.fail(OWN_NAME, identifier);
      break;
    }
    case 'server': {
      state.fail(
        `\`${identifier.text}\` is computed in the server part, on the authority; the browser never has it. Give the browser what it needs as a state — \`useReactiveState(value)\` — or render it in a slot.`,
        identifier,
      );
      break;
    }
    case 'import': {
      browserImport(state, identifier, entry.binding);
      break;
    }
    case 'constant':
    case 'hooked':
    case 'prop':
    case 'setter':
    case 'state': {
      state.browser.add(identifier, space);
      break;
    }
    case 'module':
    case 'param': {
      throw new Error(`\`${identifier.text}\` is no name of a component's.`);
    }
  }
}

function browserImport(state: SideState, identifier: Identifier, binding: ImportBinding): void {
  const { module } = binding;
  if (binding.typeOnly) {
    state.fail(
      `\`${identifier.text}\` is imported as a type, which has no value at run time.`,
      identifier,
    );
  }
  switch (module.target.kind) {
    case 'component': {
      state.fail(
        `\`${identifier.text}\` is a reactive component, which renders in the JSX the component returns — the authority renders it into a slot, or at a dynamic site — and is read nowhere else in the browser's code.`,
        identifier,
      );
      break;
    }
    case 'server': {
      state.fail(
        `\`${identifier.text}\` is \`${module.specifier}\`'s, a module only the authority runs — it reads the server's modules — which the browser never imports.`,
        identifier,
      );
      break;
    }
    case 'package': {
      const identities = state.modules.identities(module.specifier, state.file, 'browser');
      if (identities.some((identity) => state.libraries.has(identity))) {
        state.fail(
          `\`${identifier.text}\` is \`${module.specifier}\`'s, which the server part reads on the authority: a module is imported on one side alone, and the browser never imports this one.`,
          identifier,
        );
      }
      state.browser.add(identifier, 'value');
      break;
    }
    case 'client':
    case 'element':
    case 'hooks':
    case 'operations':
    case 'shared': {
      state.browser.add(identifier, 'value');
      break;
    }
  }
}

/** Whether an identifier is the tag of a JSX element: `TodoRow` of `<TodoRow …/>`. */
function isTagName(identifier: Identifier): boolean {
  const { parent } = identifier;
  return (
    (isJsxOpeningElement(parent) ||
      isJsxSelfClosingElement(parent) ||
      isJsxClosingElement(parent)) &&
    parent.tagName === identifier
  );
}

/** Whether a node stands within JSX: an element, a fragment, or what they hold. */
function withinJsx(node: Node): boolean {
  for (let parent = node.parent; !isSourceFile(parent); parent = parent.parent) {
    if (isJsxElement(parent) || isJsxSelfClosingElement(parent) || isJsxFragment(parent)) {
      return true;
    }
  }
  return false;
}

/** The names the server part declares that hold a function: a declaration, or a constant's arrow. */
export function functionsOf(statements: readonly Statement[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const statement of statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      found.add(statement.name.text);
    }
    const declarations = isVariableStatement(statement)
      ? statement.declarationList.declarations
      : [];
    for (const declaration of declarations) {
      if (isIdentifier(declaration.name) && functionOf(declaration) !== undefined) {
        found.add(declaration.name.text);
      }
    }
  }
  return found;
}

function unresolved(identifier: Identifier, where: string): string {
  return identifier.text === 'arguments'
    ? "`arguments` is not available here: an arrow has none of its own, and the component's own are neither output's."
    : `\`${identifier.text}\` ${where}: the declaration of that name is in another scope of the component.`;
}

/** Refuses what the Client Component cannot hold, wherever it is in the browser's code. */
export function checkBrowserNode(
  node: Node,
  component: Node,
  declared: ReadonlySet<string>,
  fail: Fail,
): void {
  // The Client Component is not async: an `await` outside the browser's own functions would be
  // the component's, which only the server's is.
  if (isAwaitExpression(node) && !withinFunction(node, component)) {
    fail(
      'After the state, the component awaits nothing outside its own functions: the Client Component written from it is not async.',
      node,
    );
  }
  // A decorator is evaluated where its class is defined, outside what it decorates — not where the
  // walk reads its names.
  if (isDecorator(node)) {
    fail(
      "After the state, the component decorates nothing: a decorator is evaluated outside what it decorates, where the compiler does not read its names. Declare the class in a module of the application's, and import it.",
      node,
    );
  }
  checkRunTimeImport(node, declared, fail);
}
