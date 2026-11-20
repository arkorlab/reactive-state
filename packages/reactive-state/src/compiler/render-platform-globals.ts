import {
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { patternKey, useOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { readsBinding } from './scope.ts';

/** Native URL members whose rendered answers depend on the realm that creates them. */

const BLOB_MEMBER = 'createObjectURL';
const BLOB_INPUT = 'URL.createObjectURL';

const COMPARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

type GlobalPath = (node: Node) => readonly string[] | undefined;

/** A whole constant alias retains the original native constructor, without following projections. */
function constantAlias(node: Expression): VariableDeclaration | undefined {
  if (!isIdentifier(node)) return undefined;
  const selected = frameBindingOf(node);
  if (selected === undefined) return undefined;
  if (selected.keys.length > 0) return undefined;
  const { binding } = selected;
  return isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding
    : undefined;
}

/** Native paths through written whole constructor aliases, retaining lexical shadowing. */
function nativePath(node: Expression, pathOf: GlobalPath): readonly string[] | undefined {
  const tail: string[] = [];
  const seen = new Set<Node>();
  let value = node;
  for (;;) {
    const direct = pathOf(value);
    if (direct !== undefined) return [...direct, ...tail];
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const name = isPropertyAccessExpression(value) ? value.name.text : literalName(value);
      if (name === undefined) return undefined;
      tail.unshift(name);
      value = unwrapped(value.expression);
      continue;
    }
    const binding = constantAlias(value);
    if (binding?.initializer === undefined || seen.has(binding)) return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
}

/** A namespace initializer retains whole constants and known ordinary destructured members. */
function namespaceInitializer(declaration: VariableDeclaration): string | undefined {
  if (isIdentifier(declaration.name) && constantAlias(declaration.name) === declaration) {
    return undefined;
  }
  if (!isObjectBindingPattern(declaration.name)) return 'URL';
  const readsInput = declaration.name.elements.some((element) => {
    const key = patternKey(element);
    return element.dotDotDotToken !== undefined || key === undefined || key === BLOB_MEMBER;
  });
  return readsInput ? BLOB_INPUT : undefined;
}

/** Whether a whole native URL namespace can expose its realm-dependent member at this use. */
function urlNamespaceInput(node: Expression): string | undefined {
  const { at, parent } = useOf(node);
  if (isPropertyAccessExpression(parent) && parent.expression === at) {
    return parent.name.text === BLOB_MEMBER ? BLOB_INPUT : undefined;
  }
  if (isElementAccessExpression(parent) && parent.expression === at) {
    const keys = framedKeyNames(parent.argumentExpression);
    return keys === undefined || keys.includes(BLOB_MEMBER) ? BLOB_INPUT : undefined;
  }
  if (isVariableDeclaration(parent) && isExpression(at) && parent.initializer === at) {
    return namespaceInitializer(parent);
  }
  if (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    isTypeOfExpression(parent) ||
    (isBinaryExpression(parent) && COMPARING.has(parent.operatorToken.kind))
  ) {
    return undefined;
  }
  return 'URL';
}

/** A native realm-dependent URL read, preserving ordinary constructors and known ordinary members. */
export function renderPlatformGlobal(node: Node, pathOf: GlobalPath): string | undefined {
  if (
    !(isIdentifier(node) || isPropertyAccessExpression(node) || isElementAccessExpression(node))
  ) {
    return undefined;
  }
  if (isIdentifier(node) && !readsBinding(node)) return undefined;
  if (isIdentifier(node) && isVariableDeclaration(node.parent) && node.parent.name === node) {
    return undefined;
  }
  const path = nativePath(node, pathOf);
  if (path?.[0] !== 'URL') return undefined;
  if (path.length > 1) return path[1] === BLOB_MEMBER ? BLOB_INPUT : undefined;
  return urlNamespaceInput(node);
}
