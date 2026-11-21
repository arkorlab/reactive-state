import {
  isFunctionDeclaration,
  isIdentifier,
  isJsxAttribute,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isVariableStatement,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type Node,
} from 'typescript/ast';

import type { Component } from './analyze.ts';
import type { CompiledComponent } from './emit-app.ts';
import { isJsx } from './jsx.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';

/**
 * The nodes a component hands a reactive component by its props: by `children`, or by a prop the
 * component it hands them to takes nodes by — one its parameter's own type literal types as React's
 * node (`nodes.ts`). What a prop typed through a type the component names holds, the compile does
 * not read: the component's outputs take it for JSON, which the authority refuses as it renders
 * nodes given to it. Nodes handed to such a prop are refused here, where they are handed, rather
 * than at the render that would fail: an element, a prop the component itself takes nodes by, or
 * what its server part holds either in — a constant's value, a function's body. What the compile
 * cannot see hold nodes, it takes for JSON, which the authority checks as it renders.
 */

/** What the server part declares `name` with: a constant's value, or a function's body. */
function serverDeclarationOf(component: Component, name: string): Node | undefined {
  for (const statement of component.server) {
    if (isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement.body;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindingIdentifiers(declaration.name).some((each) => each.text === name)) {
          return declaration.initializer;
        }
      }
    }
  }
  return undefined;
}

/**
 * Whether `node` may hold nodes, as the compile sees it: JSX, a prop `component` takes nodes by, or
 * a name its server part declares with either. A top-level name is no other binding anywhere in the
 * file (`scope.ts`), so a read of one is that binding; `seen` are the names followed already.
 */
function mayHoldNodes(node: Node, component: Component, seen: Set<string>): boolean {
  if (isJsx(node)) {
    return true;
  }
  if (isIdentifier(node) && readsBinding(node)) {
    const read = component.names.get(node.text);
    if (read?.kind === 'node') {
      return true;
    }
    if (read?.kind !== 'server' || seen.has(node.text)) {
      return false;
    }
    seen.add(node.text);
    const declared = serverDeclarationOf(component, node.text);
    return declared !== undefined && mayHoldNodes(declared, component, seen);
  }
  let found = false;
  node.forEachChild((child) => {
    found ||= mayHoldNodes(child, component, seen);
  });
  return found;
}

/** What a refusal says of the nodes it refuses, and of where the compile reads a prop as nodes. */
const NODES =
  "an element, a prop that holds nodes, or what of the server part holds either — which it takes as JSON: the compile reads a prop as React's node where the component's parameter types it so in a type literal, not through a type it names, and the authority would refuse the nodes as it renders the component";

/** Refuses an attribute of `element` that hands a reactive component nodes it takes as JSON. */
function checkElement(
  element: JsxOpeningElement | JsxSelfClosingElement,
  compiled: CompiledComponent,
  takes: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const { component } = compiled;
  const tag = element.tagName;
  if (!isIdentifier(tag)) {
    return;
  }
  const target = compiled.sides.refs.components.get(tag.text);
  const nodes = target === undefined ? undefined : takes.get(target);
  if (nodes === undefined) {
    return;
  }
  for (const attribute of element.attributes.properties) {
    if (isJsxSpreadAttribute(attribute)) {
      if (mayHoldNodes(attribute.expression, component, new Set())) {
        component.fail(
          `\`${tag.text}\` is handed nodes by a spread — ${NODES}, and of a spread it cannot tell which. Hand ${tag.text} each by its name, a prop its parameter's type literal types as \`ReactNode\`, or between its tags, as its children.`,
          attribute,
        );
      }
      continue;
    }
    if (!isJsxAttribute(attribute) || !isIdentifier(attribute.name)) {
      continue;
    }
    const name = attribute.name.text;
    const value = attribute.initializer;
    if (
      value !== undefined &&
      name !== 'children' &&
      !nodes.has(name) &&
      mayHoldNodes(value, component, new Set())
    ) {
      component.fail(
        `\`${tag.text}\` is handed nodes by \`${name}\` — ${NODES}. Type \`${name}\` as \`ReactNode\` in the type literal of ${tag.text}'s parameter, or hand ${tag.text} the nodes between its tags, as its children.`,
        attribute,
      );
    }
  }
}

/**
 * Refuses, in each component, every element of a reactive component handed nodes by a prop that
 * component takes as JSON; each component's refusal as `attempt` keeps it.
 */
export function checkNodeArguments(
  components: readonly CompiledComponent[],
  attempt: (run: () => void) => void,
): void {
  const takes = new Map(
    components.map(({ component }) => {
      const nodes = component.props.filter((prop) => prop.node).map((prop) => prop.name);
      return [component.id, new Set(nodes)] as const;
    }),
  );
  for (const compiled of components) {
    attempt(() => {
      const visit = (node: Node): void => {
        if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
          checkElement(node, compiled, takes);
        }
        node.forEachChild(visit);
      };
      compiled.component.sourceFile.forEachChild(visit);
    });
  }
}
