import {
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isConstructorTypeNode,
  isElementAccessExpression,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { declarationOf, namesType, parameterOf, takenApartOf } from './framed.ts';
import { elementEntryKey } from './function-entry-writes.ts';
import {
  type FunctionKind,
  hasScanKind,
  holderObject,
  isConstDeclaration,
  isConstInitializer,
  type ResolvedObject,
  type ScanContext,
  scanResolvedObject,
} from './function-table-entries.ts';

/**
 * What of a shared module's code reads what each side's bundle writes otherwise of a function of its
 * (`settled.ts`): its source, which a bundle's transforms and its minifier write anew, and its name,
 * which a minifier may shorten — `pick.toString()`, `String(pick)`, `pick.name`.
 */

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
    return kind === undefined || (kind === 'entry' && read.name === 'name')
      ? undefined
      : `reads \`${read.name}\` of a function, which each side's bundle writes otherwise`;
  }
  const written = textOf(node);
  return written === undefined || functionKind(unwrapped(written), new Set()) === undefined
    ? undefined
    : "writes a function as text, which each side's bundle writes otherwise";
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
  return functionKindInContext(node, {
    classifyFunction: functionKindInContext,
    hitCycle: false,
    seen,
  });
}

/** Cycle-aware worker classifying `node` as `'entry'`, `'renamed'`, or non-function/unknown. */
function functionKindInContext(node: Expression, context: ScanContext): FunctionKind | undefined {
  if (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)) {
    return 'renamed';
  }
  if (isPropertyAccessExpression(node)) {
    return entryFunctionKind(unwrapped(node.expression), node.name.text, context);
  }
  if (isElementAccessExpression(node)) {
    return elementEntryKind(node, context);
  }
  return isIdentifier(node) ? identifierKind(node, context) : undefined;
}

/** Resolves an identifier through declarations, destructured object entries, and function parameters. */
function identifierKind(node: Identifier, context: ScanContext): FunctionKind | undefined {
  const declared = declarationOf(node);
  if (declared === undefined) {
    return undeclaredKind(node, context);
  }
  if (context.seen.has(declared)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(declared);
  return isVariableDeclaration(declared) ? variableKind(declared, context) : 'renamed';
}

/** Resolves destructured object bindings (`const { pick } = helpers`) or typed function parameters. */
function undeclaredKind(node: Identifier, context: ScanContext): FunctionKind | undefined {
  const taken = takenApartOf(node);
  if (taken === undefined) {
    return isFunctionType(parameterOf(node)?.type) ? 'renamed' : undefined;
  }
  if (context.seen.has(taken.of)) {
    context.hitCycle = true;
    return isFunctionType(parameterOf(node)?.type) ? 'renamed' : undefined;
  }
  context.seen.add(taken.of);
  const kind = entryFunctionKind(unwrapped(taken.of), taken.key, context);
  return kind === 'entry' && !isConstInitializer(taken.of) ? 'renamed' : kind;
}

/** Preserves `'entry'` across `const` aliases while degrading mutable `let` bindings to `'renamed'`. */
function variableKind(
  declared: VariableDeclaration,
  context: ScanContext,
): FunctionKind | undefined {
  const fromInit =
    declared.initializer === undefined
      ? undefined
      : functionKindInContext(unwrapped(declared.initializer), context);
  if (fromInit !== undefined) {
    return isConstDeclaration(declared) ? fromInit : 'renamed';
  }
  return isFunctionType(declared.type) ? 'renamed' : undefined;
}

/** Classifies a bracket entry read on a written object literal, with static or dynamic key. */
function elementEntryKind(
  node: ElementAccessExpression,
  context: ScanContext,
): FunctionKind | undefined {
  const holder = unwrapped(node.expression);
  const key = elementEntryKey(node);
  if (key !== undefined) {
    return entryFunctionKind(holder, key, context);
  }
  const resolved = holderObject(holder, context);
  return resolved === undefined ? undefined : tableFunctionKind(resolved, context);
}

/** Classifies static entry `name` of `holder` when `holder` resolves to a written object literal. */
function entryFunctionKind(
  holder: Expression,
  name: string,
  context: ScanContext,
): FunctionKind | undefined {
  const resolved = holderObject(holder, context);
  if (resolved === undefined) {
    return undefined;
  }
  const scan = scanResolvedObject(resolved, context);
  const entry = scan.entries.get(name);
  if (entry === 'entry' || entry === 'renamed') {
    return entry;
  }
  if (entry === 'non-function') {
    return undefined;
  }
  return scan.stickyRenamed ? 'renamed' : undefined;
}

/** Classifies a dynamic lookup across all entries of a written object literal. */
function tableFunctionKind(
  resolved: ResolvedObject,
  context: ScanContext,
): FunctionKind | undefined {
  const scan = scanResolvedObject(resolved, context);
  if (scan.stickyRenamed || hasScanKind(scan.entries, 'renamed')) {
    return 'renamed';
  }
  if (scan.dynamicEntry || hasScanKind(scan.entries, 'entry')) {
    return scan.unverified || hasScanKind(scan.entries, 'unknown') ? 'renamed' : 'entry';
  }
  return undefined;
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
