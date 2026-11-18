import {
  type ArrayBindingPattern,
  type BindingName,
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectBindingPattern,
  type ObjectLiteralElementLike,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
import { type FrameDeclaration } from './framed-bindings.ts';
import { branchOperands } from './written-arguments.ts';
import {
  ALIAS_ASSIGNMENT_OPERATORS,
  type AliasLinks,
  type ArrayHolder,
  arrayHolderOf,
  directArrayIdentifier,
  internArrayHolder,
  isPrototypeSetterProperty,
  rootHoldersOf,
} from './written-array-aliases.ts';

/**
 * Destructuring-declaration, assignment-pattern, and `for..of`/`for..in` target walking and direct
 * array-holder alias linking across object, tuple, default, and branch patterns.
 */

export interface PatternTarget {
  readonly arrayRest: boolean;
  readonly expression: Expression;
}

/** Maps initializers, destructuring patterns and `for..of` targets to underlying array holders. */
export function collectDirectAliases(file: SourceFile): AliasLinks {
  const aliases = new Map<ArrayHolder, Set<ArrayHolder>>();
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    recordAliasNode(current, aliases);
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return aliases;
}

/** Collects leaf target expressions inside an assignment or `for..in`/`for..of` LHS pattern. */
export function collectPatternTargets(root: Expression): readonly PatternTarget[] {
  const targets: PatternTarget[] = [];
  const pending: PatternTarget[] = [{ arrayRest: false, expression: root }];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = unwrapped(current.expression);
    if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
      pending.push({ arrayRest: current.arrayRest, expression: target.left });
    } else if (isArrayLiteralExpression(target)) {
      pushArrayPatternTargets(target.elements, pending);
    } else if (isObjectLiteralExpression(target)) {
      pushObjectPatternTargets(target.properties, pending);
    } else {
      targets.push({ arrayRest: current.arrayRest, expression: target });
    }
  }
  return targets;
}

/** Pushes non-omitted array assignment-pattern elements onto `pending`. */
function pushArrayPatternTargets(elements: readonly Expression[], pending: PatternTarget[]): void {
  for (const element of elements) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      pending.push({ arrayRest: true, expression: element.expression });
    } else {
      pending.push({ arrayRest: false, expression: element });
    }
  }
}

/** Pushes bound target expressions from object assignment-pattern properties onto `pending`. */
function pushObjectPatternTargets(
  properties: readonly ObjectLiteralElementLike[],
  pending: PatternTarget[],
): void {
  for (const property of properties) {
    if (isPropertyAssignment(property)) {
      pending.push({ arrayRest: false, expression: property.initializer });
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      pending.push({ arrayRest: false, expression: property.name });
    } else if (isSpreadAssignment(property)) {
      pending.push({ arrayRest: false, expression: property.expression });
    }
  }
}

/** Links variable declarations, destructuring assignments and `for..of` targets onto `aliases`. */
function recordAliasNode(node: Node, aliases: Map<ArrayHolder, Set<ArrayHolder>>): void {
  if (isVariableDeclaration(node) && node.initializer !== undefined) {
    linkBindingPatternAliases(node, node.name, [node.initializer], aliases);
    return;
  }
  if (
    isBinaryExpression(node) &&
    ALIAS_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  ) {
    linkAssignmentPatternAliases(node.left, [node.right], aliases);
    return;
  }
  if (isForOfStatement(node)) {
    const iterated = projectArrayElements(node.expression);
    if (isVariableDeclarationList(node.initializer)) {
      const decl = node.initializer.declarations[0];
      if (decl !== undefined) {
        linkBindingPatternAliases(decl, decl.name, iterated, aliases);
      }
    } else if (isExpression(node.initializer)) {
      linkAssignmentPatternAliases(node.initializer, iterated, aliases);
    }
  }
}

/** Links a `VariableDeclaration` binding name or destructuring pattern against `sources`. */
function linkBindingPatternAliases(
  declared: FrameDeclaration,
  name: BindingName,
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  if (isIdentifier(name)) {
    const holder = internArrayHolder(declared, name.text);
    for (const source of sources) {
      linkAliasSource(holder, source, aliases);
    }
    return;
  }
  if (isArrayBindingPattern(name)) {
    linkArrayBindingElements(declared, name, sources, aliases);
    return;
  }
  if (isObjectBindingPattern(name)) {
    linkObjectBindingElements(declared, name, sources, aliases);
  }
}

/** Links elements of an `ArrayBindingPattern` against projected positional `sources` and defaults. */
function linkArrayBindingElements(
  declared: FrameDeclaration,
  pattern: ArrayBindingPattern,
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  for (const [idx, element] of pattern.elements.entries()) {
    if (isOmittedExpression(element) || element.name === undefined) {
      continue;
    }
    const projected =
      element.dotDotDotToken === undefined
        ? sources.flatMap((source) => projectTupleIndex(source, idx))
        : [];
    const nextSources =
      element.initializer === undefined ? projected : [...projected, element.initializer];
    linkBindingPatternAliases(declared, element.name, nextSources, aliases);
  }
}

/** Links elements of an `ObjectBindingPattern` against projected field `sources` and defaults. */
function linkObjectBindingElements(
  declared: FrameDeclaration,
  pattern: ObjectBindingPattern,
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  for (const element of pattern.elements) {
    if (element.name === undefined) {
      continue;
    }
    const keyNode = element.propertyName ?? element.name;
    const key =
      isIdentifier(keyNode) || isStringLiteral(keyNode) || isNumericLiteral(keyNode)
        ? keyNode.text
        : undefined;
    const projected =
      key === undefined || element.dotDotDotToken !== undefined
        ? []
        : sources.flatMap((source) => projectObjectProperty(source, key));
    const nextSources =
      element.initializer === undefined ? projected : [...projected, element.initializer];
    linkBindingPatternAliases(declared, element.name, nextSources, aliases);
  }
}

/** Links an LHS assignment expression or destructuring pattern against projected `sources`. */
function linkAssignmentPatternAliases(
  lhs: Expression,
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  const target = unwrapped(lhs);
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    linkAssignmentPatternAliases(target.left, [...sources, target.right], aliases);
    return;
  }
  const ident = directArrayIdentifier(target);
  if (ident !== undefined) {
    const holder = arrayHolderOf(ident);
    if (holder !== undefined) {
      for (const source of sources) {
        linkAliasSource(holder, source, aliases);
      }
    }
    return;
  }
  if (isArrayLiteralExpression(target)) {
    linkArrayAssignmentElements(target.elements, sources, aliases);
    return;
  }
  if (isObjectLiteralExpression(target)) {
    linkObjectAssignmentProperties(target.properties, sources, aliases);
  }
}

/** Links positional elements of an array assignment pattern up to any rest spread element. */
function linkArrayAssignmentElements(
  elements: readonly Expression[],
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  for (const [idx, elem] of elements.entries()) {
    if (isSpreadElement(elem)) {
      return;
    }
    if (!isOmittedExpression(elem)) {
      const projected = sources.flatMap((source) => projectTupleIndex(source, idx));
      linkAssignmentPatternAliases(elem, projected, aliases);
    }
  }
}

/** Links properties of an object assignment pattern against projected `sources` and defaults. */
function linkObjectAssignmentProperties(
  properties: readonly ObjectLiteralElementLike[],
  sources: readonly Expression[],
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  for (const prop of properties) {
    if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
      const key = prop.name.text;
      const projected = sources.flatMap((source) => projectObjectProperty(source, key));
      const next =
        prop.objectAssignmentInitializer === undefined
          ? projected
          : [...projected, prop.objectAssignmentInitializer];
      linkAssignmentPatternAliases(prop.name, next, aliases);
    } else if (isPropertyAssignment(prop)) {
      const key =
        isIdentifier(prop.name) || isStringLiteral(prop.name) || isNumericLiteral(prop.name)
          ? prop.name.text
          : undefined;
      const projected =
        key === undefined ? [] : sources.flatMap((source) => projectObjectProperty(source, key));
      linkAssignmentPatternAliases(prop.initializer, projected, aliases);
    }
  }
}

/** Projects positional element `idx` out of inline array literals across branch operands. */
function projectTupleIndex(source: Expression, idx: number): readonly Expression[] {
  const plain = unwrapped(source);
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    return branches.flatMap((branch) => projectTupleIndex(branch, idx));
  }
  if (!isArrayLiteralExpression(plain)) {
    return [];
  }
  const elem = plain.elements[idx];
  if (elem === undefined || isOmittedExpression(elem) || isSpreadElement(elem)) {
    return [];
  }
  return [elem];
}

/** Projects all direct elements out of inline array literals across branch operands. */
function projectArrayElements(source: Expression): readonly Expression[] {
  const plain = unwrapped(source);
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    return branches.flatMap((branch) => projectArrayElements(branch));
  }
  if (!isArrayLiteralExpression(plain)) {
    return [];
  }
  return plain.elements.filter(
    (elem): elem is Expression => !isOmittedExpression(elem) && !isSpreadElement(elem),
  );
}

/** Projects static property `key` out of inline object literals across branch operands. */
function projectObjectProperty(source: Expression, key: string): readonly Expression[] {
  const plain = unwrapped(source);
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    return branches.flatMap((branch) => projectObjectProperty(branch, key));
  }
  if (!isObjectLiteralExpression(plain)) {
    return [];
  }
  const matches: Expression[] = [];
  for (const prop of plain.properties) {
    if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name) && prop.name.text === key) {
      matches.push(prop.name);
    } else if (
      isPropertyAssignment(prop) &&
      !isPrototypeSetterProperty(prop) &&
      (isIdentifier(prop.name) || isStringLiteral(prop.name) || isNumericLiteral(prop.name)) &&
      prop.name.text === key
    ) {
      matches.push(prop.initializer);
    }
  }
  return matches;
}

/** Adds `rhs` holder targets across logical and conditional branches to `holder`'s aliases. */
function linkAliasSource(
  holder: ArrayHolder,
  rhs: Expression,
  aliases: Map<ArrayHolder, Set<ArrayHolder>>,
): void {
  for (const target of rootHoldersOf(rhs)) {
    if (target === holder) {
      continue;
    }
    let linked = aliases.get(holder);
    if (linked === undefined) {
      linked = new Set();
      aliases.set(holder, linked);
    }
    linked.add(target);
  }
}
