import {
  isExpressionWithTypeArguments,
  isIdentifier,
  isQualifiedName,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeQueryNode,
  isTypeReferenceNode,
  type ExpressionWithTypeArguments,
  type Node,
  type TypeReferenceNode,
} from 'typescript/ast';

import {
  localTypeBinding,
  type LocalTypeBinding,
  mergedHeritageDeclarations,
} from './local-type-aliases.ts';
import { capturedTypeReading } from './local-type-captured-sequences.ts';
import { qualifiedClassBinding } from './local-type-class-namespaces.ts';
import {
  boundTypeBody,
  type GenericDeclaration,
  type TypeReading,
} from './local-type-environment.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';

/** Explicit query arguments retain actual bindings rather than an unresolved parameter's constraint. */

interface ArgumentNode {
  readonly node: Node;
  readonly reading: TypeReading;
}

interface ArgumentSelection {
  readonly nodes: readonly ArgumentNode[];
  readonly opaque?: true;
}

/** Only written closed arguments contribute the added callable query specialization. */
export function actualQueryArgument(argument: TypeReading): boolean {
  const pending: ArgumentNode[] = [{ node: argument.type, reading: argument }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const selected = argumentReferences(at);
    if (selected?.opaque === true) return false;
    if (selected !== undefined) {
      pending.push(...selected.nodes);
      continue;
    }
    at.node.forEachChild((child) => {
      pending.push({ node: child, reading: at.reading });
    });
  }
  return true;
}

/** A reference follows actual parameter bindings and local type bodies without reading constraints. */
function argumentReferences(at: ArgumentNode): ArgumentSelection | undefined {
  const { node, reading } = at;
  const captured = capturedTypeReading(node);
  if (captured !== undefined) return { nodes: [{ node: captured.type, reading: captured }] };
  if (isTypeQueryNode(node)) return { nodes: [], opaque: true };
  if (!isTypeReferenceNode(node) && !isExpressionWithTypeArguments(node)) return undefined;
  const binding = referencedBinding(node);
  if (binding === undefined || binding === null) return undefined;
  if (isTypeParameterDeclaration(binding)) {
    const actual = reading.bindings.get(binding);
    return actual === undefined
      ? { nodes: [], opaque: true }
      : { nodes: [{ node: actual.type, reading: actual }] };
  }
  return argumentBodies(binding, node, reading);
}

/**
 * The local declaration a reference names, followed through namespaces as `NS.Alias` writes it, and
 * a class base `NS.Base` as the readers of class heritage follow it.
 */
function referencedBinding(
  node: TypeReferenceNode | ExpressionWithTypeArguments,
): LocalTypeBinding {
  if (isExpressionWithTypeArguments(node)) {
    return isIdentifier(node.expression)
      ? localTypeBinding(node.expression)
      : qualifiedClassBinding(node.expression);
  }
  const name = node.typeName;
  if (isIdentifier(name)) return localTypeBinding(name);
  return isQualifiedName(name) ? qualifiedLocalTypeBinding(name) : undefined;
}

/** Each local declaration retains its supplied defaults and merged declaration environment. */
function argumentBodies(
  binding: GenericDeclaration,
  reference: TypeReferenceNode | ExpressionWithTypeArguments,
  reading: TypeReading,
): ArgumentSelection {
  const declarations = isTypeAliasDeclaration(binding)
    ? [binding]
    : mergedHeritageDeclarations(binding, true);
  const selected: ArgumentNode[] = [];
  for (const declaration of declarations) {
    const bound = boundTypeBody(declaration, reference, reading);
    if (bound === undefined) return { nodes: [], opaque: true };
    const node = isTypeAliasDeclaration(declaration) ? declaration.type : declaration;
    selected.push({ node, reading: { ...bound, type: reading.type } });
  }
  return { nodes: selected };
}
