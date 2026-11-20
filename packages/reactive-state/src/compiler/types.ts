import {
  type Expression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isStringLiteral,
  isTypeLiteralNode,
  isTypeQueryNode,
  isTypeReferenceNode,
  type Node,
  type PropertySignatureDeclaration,
  type SourceFile,
  SyntaxKind,
  type TypeLiteralNode,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { literal, textOf } from './splice.ts';
import type { StateDeclaration } from './statements.ts';

/**
 * The types the authority's program writes for what an update reads — the state's value, what the
 * call captured — read off the source alone: an annotation, the type a literal starts a state with,
 * or the program's own `States`. A type the source names by an import is written as an import type,
 * `import("@/navigation").TodoFilter`, so that it means the same in any program that writes it.
 */

/** What a type is written against: the file it is in, and the names that file declares. */
export interface TypeScope {
  readonly sourceFile: SourceFile;
  readonly names: ReadonlyMap<string, TopLevel>;
  /** The type parameters in scope — a generic hook's — which no program has a name for. */
  readonly local?: ReadonlySet<string>;
}

/**
 * The type TypeScript infers for a state started from a literal — `number` of `1`, as `useState(1)`
 * widens it — or none for anything else.
 */
function literalType(expression: Expression): string | undefined {
  let node = expression;
  while (isParenthesizedExpression(node)) {
    node = node.expression;
  }
  if (
    isNumericLiteral(node) ||
    (isPrefixUnaryExpression(node) &&
      (node.operator === SyntaxKind.MinusToken || node.operator === SyntaxKind.PlusToken) &&
      isNumericLiteral(node.operand))
  ) {
    return 'number';
  }
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return 'string';
  }
  return node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword
    ? 'boolean'
    : undefined;
}

/**
 * `type` as a program elsewhere writes it: each name the file imports as `import("…").name`. None
 * where it names a type the file declares itself, a type parameter, or a value's (`typeof`), which
 * have no such name.
 */
export function rewrittenType(type: TypeNode, scope: TypeScope): string | undefined {
  const { local, names, sourceFile } = scope;
  const found = { representable: true };
  const text = textOf(type, sourceFile, (node) => {
    if (isTypeQueryNode(node)) {
      found.representable = false;
      return;
    }
    if (!isTypeReferenceNode(node)) {
      return;
    }
    let leftmost: Node = node.typeName;
    while (isQualifiedName(leftmost)) {
      leftmost = leftmost.left;
    }
    if (isIdentifier(leftmost) && local?.has(leftmost.text) === true) {
      found.representable = false;
      return;
    }
    const entry = isIdentifier(leftmost) ? names.get(leftmost.text) : undefined;
    if (entry === undefined) {
      return;
    }
    if (entry.kind !== 'import') {
      found.representable = false;
      return;
    }
    const { binding } = entry;
    const from = `import(${binding.module.written})`;
    const head = binding.form === 'namespace' ? from : `${from}.${binding.exported}`;
    const qualified = node.typeName.getText(sourceFile).slice(leftmost.getText(sourceFile).length);
    // `Box<TodoFilter>`: what it is given, written as a program elsewhere writes it too.
    const given = (node.typeArguments ?? []).map((each) => rewrittenType(each, scope));
    if (given.includes(undefined)) {
      found.representable = false;
      return;
    }
    return node.typeArguments === undefined
      ? `${head}${qualified}`
      : `${head}${qualified}<${given.join(', ')}>`;
  });
  return found.representable ? text : undefined;
}

/**
 * The type of the prop `name`, as the component's annotation of its props says: the member's type
 * of a type literal — with `undefined` where it is optional — or the annotation's own, indexed.
 */
export function propType(
  annotation: TypeNode | undefined,
  name: string,
  scope: TypeScope,
): string | undefined {
  if (annotation === undefined) {
    return undefined;
  }
  if (isTypeLiteralNode(annotation)) {
    const member = propMember(annotation, name);
    if (member === undefined) {
      return undefined;
    }
    const type = rewrittenType(member.type, scope);
    const optional = member.postfixToken?.kind === SyntaxKind.QuestionToken;
    return type === undefined || !optional ? type : `${type} | undefined`;
  }
  const whole = rewrittenType(annotation, scope);
  return whole === undefined ? undefined : `(${whole})[${literal(name)}]`;
}

/** The member of the type literal of a component's props that types the prop `name`. */
function propMember(
  annotation: TypeLiteralNode,
  name: string,
): PropertySignatureDeclaration | undefined {
  const member = annotation.members.find((each) => {
    return (
      isPropertySignatureDeclaration(each) &&
      (isIdentifier(each.name) || isStringLiteral(each.name)) &&
      each.name.text === name
    );
  });
  return member !== undefined && isPropertySignatureDeclaration(member) ? member : undefined;
}

/** The type of a constant: its annotation's, or the literal it is initialized with's. */
export function constantType(
  declaration: VariableDeclaration,
  scope: TypeScope,
): string | undefined {
  if (declaration.type !== undefined) {
    return rewrittenType(declaration.type, scope);
  }
  return declaration.initializer === undefined ? undefined : literalType(declaration.initializer);
}

/** The type of a state the browser starts: its type argument's, or the literal it starts from's. */
export function startedType(state: StateDeclaration, scope: TypeScope): string | undefined {
  const [argument] = state.call.typeArguments ?? [];
  return argument === undefined ? literalType(state.input) : rewrittenType(argument, scope);
}

/**
 * The type `declaration`, a constant's, is annotated with, as a program elsewhere writes it; none
 * where it has none, or one the program cannot name (`rewrittenType`).
 */
export function annotationOf(
  declaration: { readonly type?: TypeNode | undefined },
  scope: TypeScope,
): string | undefined {
  return declaration.type === undefined ? undefined : rewrittenType(declaration.type, scope);
}
