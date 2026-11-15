import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isCatchClause,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedArrayCallbackError } from './framed-array-callback-errors.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedPatternDefaults } from './framed-pattern-defaults.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { bindingIdentifiers, freeReads, isBlockScoped, isTypeOnly, readsBinding } from './scope.ts';
import { useOf } from './uses.ts';

/**
 * Unmutated local variable bindings whose initializer is positively proven to construct an error
 * with source-written words keep that word proof even when annotated `: Error`, while `.stack`
 * (`made === true`), catch bindings, parameters, reassignments, and object mutators remain flagged.
 */

const CAUGHT_READS = new WeakMap<Node, ReadonlySet<Identifier>>();

const TARGET_MUTATORS: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

type ErrorCheck = (value: Expression, made: boolean) => boolean;

/** Whether `name` is what an enclosing `catch` clause binds. */
function isCaughtBinding(name: Identifier): boolean {
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    if (!isCatchClause(at) || at.variableDeclaration === undefined) continue;
    const caught = bindingIdentifiers(at.variableDeclaration.name);
    if (!caught.some((each) => each.text === name.text)) continue;
    let reads = CAUGHT_READS.get(at.block);
    if (reads === undefined) {
      reads = new Set(freeReads(at.block));
      CAUGHT_READS.set(at.block, reads);
    }
    return reads.has(name);
  }
  return false;
}

/** Whether `initializer` constructs a local error whose words are written by the source. */
export function framedWrittenErrorInitializer(initializer: Expression, check: ErrorCheck): boolean {
  return !check(initializer, false) && check(initializer, true);
}

/** Whether `value` reads an unmutated local variable initialized to source-written error words. */
export function framedWrittenErrorVariable(
  value: Expression,
  selection: { readonly keys: readonly string[]; readonly made: boolean },
  check: ErrorCheck,
): boolean {
  if (selection.made || selection.keys.length > 0 || !isIdentifier(value)) return false;
  if (isCaughtBinding(value)) return false;
  const declared = frameDeclarationOf(value);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    isCatchClause(declared.parent) ||
    declared.initializer === undefined ||
    !unmutatedVariableBinding(declared, value)
  ) {
    return false;
  }
  return framedWrittenErrorInitializer(declared.initializer, check);
}

/** Resolves a lexical error binding after explicit receiver syntax and written-word proofs. */
export function framedNamedError(
  value: Identifier,
  context: { readonly errors: ReadonlySet<string>; readonly made: boolean },
  check: {
    readonly branch: (value: Expression, made: boolean, keys?: readonly string[]) => boolean;
    readonly chain: (value: Expression, made: boolean, keys?: readonly string[]) => boolean;
  },
): boolean {
  if (isCaughtBinding(value)) return true;
  const declared = frameDeclarationOf(value);
  if (declared === undefined) return false;
  if (!isVariableDeclaration(declared) && !isParameterDeclaration(declared)) return false;
  const defaults = framedPatternDefaults(value, declared);
  const keys = defaults === undefined ? [] : (frameBindingOf(value)?.keys ?? []);
  const { errors, made } = context;
  return (
    framedArrayCallbackError(value, made, errors, check.branch) ||
    namesLocalMemberType(declared.type, keys, errors) ||
    framedAssignedSources(value).some((each) => check.branch(each.value, made, each.keys)) ||
    defaults?.some((each) => check.branch(each, made)) === true ||
    (declared.initializer !== undefined && check.chain(declared.initializer, made, keys))
  );
}

/** Ensures the lexical variable is never reassigned, redeclared, or targeted by member mutators. */
function unmutatedVariableBinding(declared: VariableDeclaration, read: Identifier): boolean {
  if (!isVariableDeclarationList(declared.parent)) return false;
  const blockScoped = isBlockScoped(declared.parent);
  if (!blockScoped && declared.end > read.pos) return false;
  const name = isIdentifier(declared.name) ? declared.name.text : undefined;
  if (name === undefined) return false;
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      !blockScoped &&
      isVariableDeclaration(node) &&
      node !== declared &&
      bindingIdentifiers(node.name).some((bound) => bound.text === name)
    ) {
      return false;
    }
    if (
      isIdentifier(node) &&
      node !== declared.name &&
      node.text === name &&
      readsBinding(node) &&
      frameDeclarationOf(node) === declared &&
      mutatesBindingOrTarget(node)
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Direct reassignments, member writes/deletes, and `Object`/`Reflect` target mutators. */
function mutatesBindingOrTarget(name: Identifier): boolean {
  if (reassignedIdentifier(name)) return true;
  const { at, parent } = useOf(name);
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    const outer = useOf(parent);
    if (isDeleteExpression(outer.parent)) return true;
    return isAssignmentLeft(outer.at, outer.parent);
  }
  if (!isCallExpression(parent) || parent.arguments[0] !== at) return false;
  const path = globalPathOf(unwrapped(parent.expression))?.join('.');
  return path !== undefined && TARGET_MUTATORS.has(path);
}

/** Checks whether `target` sits on the left-hand side of an assignment or update operator. */
function isAssignmentLeft(target: Node, parent: Node): boolean {
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Walks through transparent wrappers and destructuring patterns to detect binding writes. */
function reassignedIdentifier(name: Identifier): boolean {
  let target: Node = name;
  while (assignmentWrapper(target)) target = target.parent;
  return isAssignmentLeft(target, target.parent);
}

/** Transparent expressions and assignment patterns propagate writes to their bound target. */
function assignmentWrapper(target: Node): boolean {
  const parent = target.parent;
  return (
    (transparentExpression(parent) && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Parentheses, type assertions, non-null markers and satisfies preserve the target reference. */
function transparentExpression(
  node: Node,
): node is Expression & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}
