import {
  type CallExpression,
  type Identifier,
  isElementAccessExpression,
  isExportAssignment,
  isExportSpecifier,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Expression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { BUILT_INS } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { readsBinding } from './scope.ts';

/** What a native call's own work reaches of a tuple it reads: its callee's, its arguments'. */

/**
 * Evaluation, besides a member read, that can run the application's code or let it run: a call, a
 * conversion, a computed key, a wait, and the getters and iteration of a spread, a pattern or a loop.
 */
export const APPLICATION_WORK: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.AwaitExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.ComputedPropertyName,
  SyntaxKind.Decorator,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.JsxSpreadAttribute,
  SyntaxKind.NewExpression,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.YieldExpression,
]);

/**
 * The call's own work before it reads `read`'s entries: its callee's, past the member path that
 * selects its function, and its arguments' — every one, as a call reads a list it is given once it
 * runs, or those before a spread, which reads its entries where it stands. A use of the tuple there
 * exposes it; other work runs the application's code, which reaches the tuple only through a
 * function of the module's that names it (`namedElsewhere`).
 */
export function callWorkExposure(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
  read: Expression,
): boolean {
  const { parent } = read;
  const spread = isSpreadElement(parent) && within(parent, call) ? parent : undefined;
  const pending: Node[] = [...calleeWork(call.expression), ...(call.arguments ?? [])];
  let work = false;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === read || isTypeNode(node) || (spread !== undefined && node.pos >= spread.pos))
      continue;
    if (tupleBindingExposure(node, binding, aliases)) return true;
    work ||= applicationWork(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return work && namedElsewhere(binding, call);
}

/** What a callee evaluates past the member path that selects its function: keys, a base not a name. */
function calleeWork(callee: Expression): readonly Node[] {
  const work: Node[] = [];
  let each = unwrapped(callee);
  while (isPropertyAccessExpression(each) || isElementAccessExpression(each)) {
    if (isElementAccessExpression(each)) work.push(each.argumentExpression);
    each = unwrapped(each.expression);
  }
  if (!isIdentifier(each)) work.push(each);
  return work;
}

/**
 * Evaluation that can run the application's code: a call, a construction, a conversion, a wait, a
 * member read — but a member of the language's own globals, such as the native function an argument
 * names.
 */
function applicationWork(node: Node): boolean {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
    return !BUILT_INS.has(globalPathOf(node)?.[0] ?? '');
  return APPLICATION_WORK.has(node.kind);
}

/**
 * Whether code that work may run reaches the tuple: a function of the module's that names it outside
 * the call, or another module's, where the module exports it.
 */
export function namedElsewhere(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
): boolean {
  const statement = binding.parent.parent;
  if (
    isVariableStatement(statement) &&
    statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true
  )
    return true;
  const owner = executionOwner(call);
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === call || isTypeNode(node)) continue;
    if (
      isIdentifier(node) &&
      node !== binding.name &&
      readsBinding(node) &&
      frameBindingOf(node)?.binding === binding &&
      (executionOwner(node) !== owner || exportedName(node))
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether `name` is exported where it stands: `export { name }`, `export default name`. */
function exportedName(name: Identifier): boolean {
  return isExportSpecifier(name.parent) || isExportAssignment(name.parent);
}

/** Whether `node` is written within `call`. */
function within(node: Node, call: CallExpression | NewExpression): boolean {
  return node.pos >= call.pos && node.end <= call.end;
}

/** Only a whole constant alias can retain a tuple without exposing its mutable entries. */
export function tupleBindingExposure(
  node: Node,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (
    !isIdentifier(node) ||
    node === binding.name ||
    !readsBinding(node) ||
    frameBindingOf(node)?.binding !== binding
  )
    return false;
  const owner = node.parent;
  return !isVariableDeclaration(owner) || owner.initializer !== node || !aliases.has(owner);
}
