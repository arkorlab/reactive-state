import {
  type CallExpression,
  type Identifier,
  isBindingElement,
  isClassDeclaration,
  isClassExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportSpecifier,
  isHeritageClause,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
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
import { bindingIdentifiers, readsBinding } from './scope.ts';

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
 * The call's own work before it reads `read`'s entries: its callee's — the keys and the base past
 * the member path that selects its function, and that member's own read (`calleeReads`) — and its
 * arguments' — every one, as a call reads a list it is given once it runs, or those before a spread,
 * which reads its entries where it stands. A use of the tuple there exposes it; other work runs the
 * application's code, which reaches the tuple only through a function of the module's that names it
 * (`namedElsewhere`).
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
  let work = calleeReads(call.expression);
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
 * Whether the callee's own member read can run the application's code, as a getter of the holder it
 * reads from does: any member read but one `builtInRead` finds the language's.
 */
function calleeReads(callee: Expression): boolean {
  const read = unwrapped(callee);
  return (
    (isPropertyAccessExpression(read) || isElementAccessExpression(read)) && !builtInRead(read)
  );
}

/**
 * Whether `read` selects a member of one of the language's own globals, `Reflect.get.apply`, or of
 * a constant that names one or a member of one, `const get = Reflect.get; get.apply`.
 */
function builtInRead(read: Expression): boolean {
  const seen = new Set<FrameBinding>();
  for (
    let each: Expression | undefined = read;
    each !== undefined;
    each = constantOrigin(each, seen)
  )
    if (BUILT_INS.has(globalPathOf(each)?.[0] ?? '')) return true;
  return false;
}

/** The initializer of the constant a member path starts from, `seen` once each. */
function constantOrigin(read: Expression, seen: Set<FrameBinding>): Expression | undefined {
  let root = unwrapped(read);
  while (isPropertyAccessExpression(root) || isElementAccessExpression(root))
    root = unwrapped(root.expression);
  if (!isIdentifier(root)) return undefined;
  const selected = frameBindingOf(root);
  if (selected === undefined || seen.has(selected.binding)) return undefined;
  seen.add(selected.binding);
  const { binding } = selected;
  return isVariableDeclarationList(binding.parent) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile())) &&
    !defaulted(binding, root)
    ? binding.initializer
    : undefined;
}

/**
 * Whether a pattern of `binding` gives `name`, or a pattern that holds it, a default: a member the
 * initializer lacks is the default's, which the initializer does not name.
 */
function defaulted(binding: FrameBinding, name: Identifier): boolean {
  const bound = bindingIdentifiers(binding.name).find((each) => each.text === name.text);
  for (let at = bound?.parent; at !== undefined && isBindingElement(at); at = at.parent.parent)
    if (at.initializer !== undefined) return true;
  return false;
}

/**
 * Whether `node` is a class's `extends` clause, which reads the superclass's `prototype` where the
 * class is defined — a proxy answers that read with a `get` trap of the application's own — as no
 * `implements` clause or interface's `extends`, which are types, does.
 */
export function extendsWork(node: Node): boolean {
  return (
    isHeritageClause(node) &&
    node.token === SyntaxKind.ExtendsKeyword &&
    (isClassDeclaration(node.parent) || isClassExpression(node.parent))
  );
}

/**
 * Evaluation that can run the application's code: a call, a construction, a conversion, a wait, a
 * member read — but a member of the language's own globals, such as the native function an argument
 * names.
 */
function applicationWork(node: Node): boolean {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
    return !BUILT_INS.has(globalPathOf(node)?.[0] ?? '');
  return APPLICATION_WORK.has(node.kind) || extendsWork(node);
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
