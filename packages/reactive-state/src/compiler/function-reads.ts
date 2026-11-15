import {
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isConstructorTypeNode,
  isElementAccessExpression,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { declarationOf, namesType, parameterOf, takenApartOf } from './framed.ts';

/**
 * What of a shared module's code reads what each side's bundle writes otherwise of a function of its
 * (`settled.ts`): its source, which a bundle's transforms and its minifier write anew, and its name,
 * which a minifier may shorten — `pick.toString()`, `String(pick)`, `pick.name`.
 */

/** Whether a function's runtime `.name` comes from an unminified entry key or a minifiable binding. */
type FunctionKind = 'entry' | 'renamed';

/** Resolved object literal together with whether its binding chain is immutable (`const`). */
interface ResolvedObject {
  readonly constant: boolean;
  readonly object: ObjectLiteralExpression;
}

/** The members of a function each side's bundle writes otherwise: its source, its name. */
const BUNDLED: ReadonlySet<string> = new Set(['name', 'toString']);

/** The types a parameter is said to be a function of by their names: `Function`, and its kin. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'CallableFunction',
  'Function',
  'NewableFunction',
]);

/** The operators that make text of a function beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/**
 * What of `node` reads what each side's bundle writes otherwise of a function the code shows it
 * writes (`functionKind`): its source — `toString` of it, `String(pick)`, a template, `pick + ''` —
 * or a `.name` that comes from a declaration, variable or named expression rather than a static
 * object entry key.
 */
export function functionRead(node: Node): string | undefined {
  const read = memberRead(node);
  if (read !== undefined) {
    if (!BUNDLED.has(read.name)) {
      return undefined;
    }
    const kind = functionKind(unwrapped(read.of), new Set());
    return kind === undefined || (read.name === 'name' && kind === 'entry')
      ? undefined
      : `reads \`${read.name}\` of a function, which each side's bundle writes otherwise`;
  }
  const written = textOf(node);
  return written !== undefined && functionKind(unwrapped(written), new Set()) !== undefined
    ? "writes a function as text, which each side's bundle writes otherwise"
    : undefined;
}

/**
 * What `node` reads a member of, by the member's name: `pick.name`, `pick['toString']`, `const {
 * name } = pick`; none of another node.
 */
function memberRead(node: Node): { readonly name: string; readonly of: Expression } | undefined {
  if (isPropertyAccessExpression(node)) {
    return { name: node.name.text, of: node.expression };
  }
  if (isElementAccessExpression(node)) {
    const name = literalName(node);
    return name === undefined ? undefined : { name, of: node.expression };
  }
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) {
    return undefined;
  }
  const declaration = node.parent.parent;
  const name = patternKey(node);
  return name !== undefined &&
    isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
    ? { name, of: declaration.initializer }
    : undefined;
}

/** What `node` writes as text where it writes it so: `String`'s argument, a template's, an operand of `+`. */
function textOf(node: Node): Expression | undefined {
  if (isCallExpression(node) && globalPathOf(unwrapped(node.expression))?.join('.') === 'String') {
    return node.arguments[0];
  }
  if (isTemplateExpression(node)) {
    return node.templateSpans.find(
      (span) => functionKind(unwrapped(span.expression), new Set()) !== undefined,
    )?.expression;
  }
  if (!isBinaryExpression(node) || !ADDING.has(node.operatorToken.kind)) {
    return undefined;
  }
  return functionKind(unwrapped(node.left), new Set()) === undefined ? node.right : node.left;
}

/** Classifies `node` as an object-entry-named function, a minifiable function, or neither. */
function functionKind(node: Expression, seen: Set<Node>): FunctionKind | undefined {
  if (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)) {
    return 'renamed';
  }
  if (isPropertyAccessExpression(node)) {
    return entryFunctionKind(unwrapped(node.expression), node.name.text, seen);
  }
  if (isElementAccessExpression(node)) {
    return elementEntryKind(node, seen);
  }
  return isIdentifier(node) ? identifierKind(node, seen) : undefined;
}

/** Resolves an identifier through declarations, destructured object entries, and function parameters. */
function identifierKind(node: Identifier, seen: Set<Node>): FunctionKind | undefined {
  const declared = declarationOf(node);
  if (declared === undefined) {
    return undeclaredKind(node, seen);
  }
  if (seen.has(declared)) {
    return undefined;
  }
  seen.add(declared);
  return isVariableDeclaration(declared) ? variableKind(declared, seen) : 'renamed';
}

/** Resolves destructured object bindings (`const { pick } = helpers`) or typed function parameters. */
function undeclaredKind(node: Identifier, seen: Set<Node>): FunctionKind | undefined {
  const taken = takenApartOf(node);
  if (taken === undefined || seen.has(taken.of)) {
    return isFunctionType(parameterOf(node)?.type) ? 'renamed' : undefined;
  }
  seen.add(taken.of);
  const kind = entryFunctionKind(unwrapped(taken.of), taken.key, seen);
  return kind === 'entry' && !isConstInitializer(taken.of) ? 'renamed' : kind;
}

/** Preserves `'entry'` across `const` aliases while degrading mutable `let` bindings to `'renamed'`. */
function variableKind(declared: VariableDeclaration, seen: Set<Node>): FunctionKind | undefined {
  const fromInit =
    declared.initializer === undefined
      ? undefined
      : functionKind(unwrapped(declared.initializer), seen);
  if (fromInit !== undefined) {
    return isConstDeclaration(declared) ? fromInit : 'renamed';
  }
  return isFunctionType(declared.type) ? 'renamed' : undefined;
}

/** Classifies a bracket entry read on a written object literal, with static or dynamic key. */
function elementEntryKind(
  node: ElementAccessExpression,
  seen: Set<Node>,
): FunctionKind | undefined {
  const holder = unwrapped(node.expression);
  const key = elementKey(node);
  if (key !== undefined) {
    return entryFunctionKind(holder, key, seen);
  }
  const resolved = holderObject(holder, seen);
  return resolved === undefined ? undefined : tableFunctionKind(resolved, seen);
}

/** Classifies entry `name` of `holder` when `holder` resolves to a written object literal. */
function entryFunctionKind(
  holder: Expression,
  name: string,
  seen: Set<Node>,
): FunctionKind | undefined {
  const resolved = holderObject(holder, seen);
  if (resolved === undefined) {
    return undefined;
  }
  let kind: FunctionKind | undefined;
  for (const property of resolved.object.properties) {
    kind = nextEntryKind(property, name, kind, seen);
  }
  return kind === 'entry' && !resolved.constant ? 'renamed' : kind;
}

/** Updates the classification of entry `name` as each object-literal element is visited in order. */
function nextEntryKind(
  property: ObjectLiteralElementLike,
  name: string,
  current: FunctionKind | undefined,
  seen: Set<Node>,
): FunctionKind | undefined {
  if (isSpreadAssignment(property)) {
    return current === 'entry' ? 'renamed' : current;
  }
  const key = propertyKey(property);
  if (key === undefined) {
    return current === 'entry' && propertyFunctionKind(property, key, seen) !== undefined
      ? 'renamed'
      : current;
  }
  return key === name ? propertyFunctionKind(property, key, seen) : current;
}

/** Classifies a dynamic lookup across all entries of a written object literal. */
function tableFunctionKind(resolved: ResolvedObject, seen: Set<Node>): FunctionKind | undefined {
  let kind: FunctionKind | undefined;
  for (const property of resolved.object.properties) {
    if (isSpreadAssignment(property)) {
      if (kind === 'entry') {
        kind = 'renamed';
      }
      continue;
    }
    const each = propertyFunctionKind(property, propertyKey(property), seen);
    if (each === 'renamed') {
      return 'renamed';
    }
    if (each === 'entry') {
      kind = 'entry';
    }
  }
  return kind === 'entry' && !resolved.constant ? 'renamed' : kind;
}

/** Resolves an inline or lexically bound object literal expression. */
function holderObject(holder: Expression, seen: Set<Node>): ResolvedObject | undefined {
  if (isObjectLiteralExpression(holder)) {
    return { constant: true, object: holder };
  }
  const declared = isIdentifier(holder) ? declarationOf(holder) : undefined;
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined ||
    seen.has(declared)
  ) {
    return undefined;
  }
  seen.add(declared);
  const inner = holderObject(unwrapped(declared.initializer), seen);
  return inner === undefined
    ? undefined
    : { constant: inner.constant && isConstDeclaration(declared), object: inner.object };
}

/** Classifies a single object-literal property as `'entry'`, `'renamed'`, or non-function. */
function propertyFunctionKind(
  property: ObjectLiteralElementLike,
  key: string | undefined,
  seen: Set<Node>,
): FunctionKind | undefined {
  if (isMethodDeclaration(property)) {
    return 'entry';
  }
  if (isPropertyAssignment(property)) {
    const value = unwrapped(property.initializer);
    if (key !== undefined && key !== '__proto__' && isAnonymousDefinition(value)) {
      return 'entry';
    }
    return functionKind(value, seen);
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? functionKind(property.name, seen)
    : undefined;
}

/** Whether `node` receives its `.name` from an enclosing property assignment via `NamedEvaluation`. */
function isAnonymousDefinition(node: Expression): boolean {
  if (isArrowFunction(node)) {
    return true;
  }
  return (isFunctionExpression(node) || isClassExpression(node)) && node.name === undefined;
}

/** Whether `declared` belongs to a `const` declaration list. */
function isConstDeclaration(declared: VariableDeclaration): boolean {
  return /^const\s/u.test(declared.parent.getText(declared.getSourceFile()));
}

/** Whether `initializer` is the RHS of a `const` variable declaration. */
function isConstInitializer(initializer: Expression): boolean {
  return isVariableDeclaration(initializer.parent) && isConstDeclaration(initializer.parent);
}

/** Static property key of an object literal element. */
function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return 'name' in property && property.name !== undefined ? keyOf(property.name) : undefined;
}

/** Static key of an element access expression, including string, template and numeric literals. */
function elementKey(node: ElementAccessExpression): string | undefined {
  const name = literalName(node);
  if (name !== undefined) {
    return name;
  }
  const argument = unwrapped(node.argumentExpression);
  return isNumericLiteral(argument) ? String(Number(argument.text)) : undefined;
}

/** The name of an entry the code writes: of a name, text, or a number; none of another. */
function keyOf(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    const value = unwrapped(name.expression);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    return isNumericLiteral(value) ? String(Number(value.text)) : undefined;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/**
 * Whether `type`, written, says a function: a function's type, `() => string`, a class's,
 * `new () => object`, or `Function`'s and its kin's (`FUNCTION_TYPES`), in a union too.
 */
function isFunctionType(type: TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    (isFunctionTypeNode(type) || isConstructorTypeNode(type) || namesType(type, FUNCTION_TYPES))
  );
}
