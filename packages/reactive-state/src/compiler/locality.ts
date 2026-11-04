import {
  type BindingElement,
  type BindingName,
  isAwaitExpression,
  isBindingElement,
  isComputedPropertyName,
  isIdentifier,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { entryOf, type SideState } from './reads.ts';
import type { Visitor } from './scope.ts';
import { isConstant } from './statements.ts';
import { writtenIn } from './writes.ts';

/** What a value is told a value of the page's by: the component, walked lexically. */
export interface Locality {
  readonly state: SideState;
  readonly walking: (node: Node, visitor: Visitor) => void;
}

/**
 * Whether what a state the authority evaluates starts from is a value of the page's, never a field
 * of the database: it reads the props — JSON, which holds no field — literals, globals, the
 * application's shared modules, and what the server part declares with `const` of these alone, and
 * awaits nothing. A field reaches a state through a module only the authority runs, or through what
 * the server part computes of one, which may make the state a binding of it — or what it writes
 * into a prop or a constant (`writtenIn`): one written to is no value of the page's.
 */
export function holdsPageValue(input: Node, context: Locality, seen = new Set<string>()): boolean {
  if (holdsAwait(input)) {
    return false;
  }
  const { state, walking } = context;
  let page = true;
  walking(input, {
    read: (identifier, space) => {
      if (space !== 'value' || !page) {
        return;
      }
      const entry = entryOf(state, identifier);
      if (entry.kind === 'import') {
        page = entry.binding.module.target.kind === 'shared';
      } else if (writtenIn(state.component).has(identifier.text)) {
        page = false;
      } else if (entry.kind === 'server') {
        page = serverValueIsPage(identifier.text, context, seen);
      } else {
        page = entry.kind === 'prop';
      }
    },
  });
  return page;
}

/**
 * Whether what the server part declares `name` by is a value of the page's: a `const` of one.
 * `seen` holds the names being followed: one read again while it is, a cycle, holds no value; one
 * read again once it was followed — twice in one initializer, or by two constants — holds the same.
 */
function serverValueIsPage(name: string, context: Locality, seen: Set<string>): boolean {
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);
  try {
    const { component } = context.state;
    for (const statement of component.server) {
      if (!isVariableStatement(statement) || !isConstant(statement, component.sourceFile)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const path = pathTo(declaration.name, name);
        if (path !== undefined) {
          const { initializer } = declaration;
          return (
            initializer !== undefined &&
            holdsPageValue(initializer, context, seen) &&
            path.every((element) => elementIsPage(element, context, seen))
          );
        }
      }
    }
    return false;
  } finally {
    seen.delete(name);
  }
}

/**
 * The binding elements from `name`, a declaration's, down to the identifier `target` it binds — none
 * of an identifier, which is `target` itself — or nothing where it binds no `target`.
 */
function pathTo(name: BindingName, target: string): readonly BindingElement[] | undefined {
  if (isIdentifier(name)) {
    return name.text === target ? [] : undefined;
  }
  for (const element of name.elements) {
    // An array pattern's hole is an element of no name, which binds nothing.
    if (isBindingElement(element) && element.name !== undefined) {
      const below = pathTo(element.name, target);
      if (below !== undefined) {
        return [element, ...below];
      }
    }
  }
  return undefined;
}

/**
 * Whether what a binding element takes of a value of the page's is one too: its default, and the
 * key it computes, where it has them.
 */
function elementIsPage(element: BindingElement, context: Locality, seen: Set<string>): boolean {
  const key = element.propertyName;
  return (
    (key === undefined ||
      !isComputedPropertyName(key) ||
      holdsPageValue(key.expression, context, seen)) &&
    (element.initializer === undefined || holdsPageValue(element.initializer, context, seen))
  );
}

/** Whether `node` awaits anything: what it awaits is the server's to answer. */
export function holdsAwait(node: Node): boolean {
  if (isAwaitExpression(node)) {
    return true;
  }
  let found = false;
  node.forEachChild((child) => {
    found ||= holdsAwait(child);
  });
  return found;
}
