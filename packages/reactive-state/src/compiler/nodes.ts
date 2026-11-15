import {
  type EntityName,
  isArrayTypeNode,
  isIdentifier,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isStringLiteral,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import type { ImportBinding } from './imports.ts';

/**
 * The props a component is given nodes by — what the element that renders it holds between its
 * tags, `children`, or an element another prop is given — which the authority renders, as it renders
 * the component's own JSX. The server part reads one as it reads any prop; the browser's JSX shows
 * one where it stands, in a slot (`slots.ts`), and reads it nowhere else: the browser holds none of
 * what the authority renders but what a slot shows. A page renders a root without them.
 */

/** The prop React gives an element what it holds between its tags. */
const CHILDREN = 'children';

/** React's types of what it renders, by the name `react` exports each by. */
const NODE_TYPES: ReadonlySet<string> = new Set(['ReactElement', 'ReactNode', 'ReactPortal']);

/** The type of an element JSX makes, the global one or React's. */
const JSX_ELEMENT = 'JSX.Element';

/** The module React's types are imported from. */
const REACT = 'react';

/** The namespace React's types declare globally, which a type may name them by unimported. */
const GLOBAL_REACT = 'React';

/** The types of a list of what it holds: `Array<T>`, `ReadonlyArray<T>`. */
const LISTS: ReadonlySet<string> = new Set(['Array', 'ReadonlyArray']);

/**
 * Whether the prop `name` holds nodes: `children`, whatever name the component reads it by, or a
 * prop its annotation — a type literal — types as React's node, element or portal, or as
 * `JSX.Element`: alone, with `null` or `undefined`, or a list of them. `imports` are the component's
 * imports, by the name it reads each by.
 */
export function isNodeProp(
  name: string,
  annotation: TypeNode | undefined,
  imports: ReadonlyMap<string, ImportBinding>,
): boolean {
  if (name === CHILDREN) {
    return true;
  }
  if (annotation === undefined || !isTypeLiteralNode(annotation)) {
    return false;
  }
  const member = annotation.members.find((each) => {
    return (
      isPropertySignatureDeclaration(each) &&
      (isIdentifier(each.name) || isStringLiteral(each.name)) &&
      each.name.text === name
    );
  });
  return (
    member !== undefined &&
    isPropertySignatureDeclaration(member) &&
    isNodeType(member.type, imports)
  );
}

/** Whether `type` is React's node, alone, with `null` or `undefined`, or a list of them. */
function isNodeType(
  written: TypeNode | undefined,
  imports: ReadonlyMap<string, ImportBinding>,
): boolean {
  const type = itemOf(written, imports);
  if (type === undefined) {
    return false;
  }
  if (isUnionTypeNode(type)) {
    const held = type.types.filter((each) => !isNothing(each));
    return held.length > 0 && held.every((each) => isNodeType(each, imports));
  }
  if (!isTypeReferenceNode(type)) {
    return false;
  }
  const path = namesOf(type.typeName);
  const [first = '', ...rest] = path;
  return isNodeName(path, imports.get(first), rest);
}

/**
 * The type of what `type` holds, where it is a list — `T[]`, `readonly T[]`, `Array<T>`,
 * `ReadonlyArray<T>` — or in parentheses, at any depth; `type` itself otherwise.
 */
function itemOf(
  type: TypeNode | undefined,
  imports: ReadonlyMap<string, ImportBinding>,
): TypeNode | undefined {
  let item = type;
  let inner = item === undefined ? undefined : innerOf(item, imports);
  while (inner !== undefined) {
    item = inner;
    inner = innerOf(item, imports);
  }
  return item;
}

/** What `type` holds, where it is a list or in parentheses; none where it is neither. */
function innerOf(
  type: TypeNode,
  imports: ReadonlyMap<string, ImportBinding>,
): TypeNode | undefined {
  if (isParenthesizedTypeNode(type)) {
    return type.type;
  }
  if (isArrayTypeNode(type)) {
    return type.elementType;
  }
  if (isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword) {
    return type.type;
  }
  return isListReference(type, imports) ? type.typeArguments?.[0] : undefined;
}

/** Whether a type is `Array<T>` or `ReadonlyArray<T>`, the language's own. */
function isListReference(
  type: TypeNode,
  imports: ReadonlyMap<string, ImportBinding>,
): type is TypeReferenceNode {
  return (
    isTypeReferenceNode(type) &&
    isIdentifier(type.typeName) &&
    LISTS.has(type.typeName.text) &&
    !imports.has(type.typeName.text) &&
    type.typeArguments?.length === 1
  );
}

/** Whether a type of a union says there is nothing there: `null`, `undefined`. */
function isNothing(type: TypeNode): boolean {
  return (
    type.kind === SyntaxKind.UndefinedKeyword ||
    (isLiteralTypeNode(type) && type.literal.kind === SyntaxKind.NullKeyword)
  );
}

/**
 * Whether a type's name, as its parts (`React.ReactNode`), names React's node: one of its types
 * imported by name, or through `react` imported whole or the global namespace its types declare,
 * or `JSX.Element` — the global one, or React's.
 */
function isNodeName(
  path: readonly string[],
  binding: ImportBinding | undefined,
  rest: readonly string[],
): boolean {
  if (binding === undefined) {
    const unimported = path[0] === GLOBAL_REACT;
    const name = (unimported ? rest : path).join('.');
    return name === JSX_ELEMENT || (unimported && NODE_TYPES.has(name));
  }
  if (binding.module.specifier !== REACT) {
    return false;
  }
  const name = (binding.form === 'named' ? [binding.exported, ...rest] : rest).join('.');
  return NODE_TYPES.has(name) || name === JSX_ELEMENT;
}

/** The names a type's name is made of, leftmost first: `React`, `ReactNode` of `React.ReactNode`. */
function namesOf(name: EntityName): readonly string[] {
  return isQualifiedName(name) ? [...namesOf(name.left), name.right.text] : [name.text];
}
