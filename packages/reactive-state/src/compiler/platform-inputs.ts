import {
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isCallExpression,
  isElementAccessExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isTemplateExpression,
  isVariableDeclaration,
  isWhileStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** Local initializers that still describe a platform input when the construction reads it. */
interface Binding {
  readonly name: Identifier;
  readonly held: Expression | undefined;
  readonly owner: Node;
  readonly before: Node | undefined;
  readonly preserves: PlatformWrite | undefined;
}

/** A narrow proof that a particular write retains the platform property being checked. */
type PlatformWrite = (write: Node, target: Node, held: Expression | undefined) => boolean;

/** A variable's initializer only where binding and mutable-value writes cannot have changed it. */
export function platformInitializer(
  name: Identifier,
  before: Node,
  preserves?: PlatformWrite,
): Expression | undefined {
  const declaration = declarationOf(name);
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    !isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  const pending: Binding[] = [
    { ...bindingOf(declaration.name, declaration.initializer, before), preserves },
  ];
  const seen = new Set<Identifier>();
  for (let binding = pending.pop(); binding !== undefined; binding = pending.pop()) {
    if (seen.has(binding.name)) {
      continue;
    }
    seen.add(binding.name);
    if (changedBinding(binding, pending)) {
      return undefined;
    }
  }
  return declaration.initializer;
}

/** The function or module holding a declaration, with a cutoff only inside that same execution. */
function bindingOf(name: Identifier, held: Expression | undefined, before?: Node): Binding {
  let owner: Node = name.parent;
  while (!isSourceFile(owner) && !isAnswering(owner)) {
    owner = owner.parent;
  }
  return { before, held, name, owner, preserves: undefined };
}

/** Whether a lexical binding or what it holds was written or handed where writes cannot be read. */
function changedBinding(binding: Binding, pending: Binding[]): boolean {
  const { name, held, owner, before } = binding;
  const isRead = readsOf(name, owner);
  const points = before === undefined ? undefined : readPoints(before, owner);
  const relevant = (read: Node): boolean => {
    return (
      points === undefined ||
      isSourceFile(owner) ||
      points.some((point) => read.pos < point.end || repeatsBefore(read, point, binding)) ||
      withinFunction(read, owner)
    );
  };
  const mutable =
    held === undefined ||
    (constantValue(held) === undefined && !isTemplateExpression(unwrapped(held)));
  const visit = (node: Node): boolean => {
    const eligible = relevant(node);
    const target = eligible ? writtenBy(node) : undefined;
    if (
      target !== undefined &&
      bindsTarget(target, isRead, mutable) &&
      binding.preserves?.(node, target, held) !== true
    ) {
      return true;
    }
    if (mutable && eligible && isRead(node) && handedUnknown(node, binding, pending)) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return owner.forEachChild((child) => (visit(child) ? true : undefined)) === true;
}

/** A nested source body reads captured inputs when its known direct callers execute. */
function readPoints(before: Node, owner: Node): readonly Node[] | undefined {
  if (!contains(owner, before)) {
    return undefined;
  }
  for (let child = before; child !== owner && !isSourceFile(child); child = child.parent) {
    const fn = child.parent;
    const body: Node | undefined = isAnswering(fn) ? fn.body : undefined;
    if (fn !== owner && body === child && isAnswering(fn)) {
      return invocationPoints(fn, owner);
    }
  }
  return [before];
}

/** Immediate calls and unchanged lexical callable bindings, without following callbacks or escapes. */
function invocationPoints(fn: Answering, owner: Node): readonly Node[] | undefined {
  let value: Node = fn;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const immediate = directCall(value, owner);
  if (immediate !== undefined) {
    return answersLater(fn) ? undefined : [immediate];
  }
  const declaration = isVariableDeclaration(value.parent) ? value.parent : fn;
  if (!isVariableDeclaration(declaration) && !isFunctionDeclaration(declaration)) {
    return undefined;
  }
  const { name } = declaration;
  if (name === undefined || !isIdentifier(name)) {
    return undefined;
  }
  const state = { unknown: false, points: [] as Node[] };
  const visit = (node: Node): void => {
    if (state.unknown || isTypeOnly(node)) {
      return;
    }
    if (node !== name && isIdentifier(node) && declarationOf(node) === declaration) {
      const call = directCall(node, owner);
      if (call === undefined || sourceFunction(call.expression) !== fn || answersLater(fn)) {
        state.unknown = true;
      } else {
        state.points.push(call);
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.unknown ? undefined : state.points;
}

/** A direct invocation in the binding owner's execution, excluding deferred caller bodies. */
function directCall(node: Node, owner: Node): CallExpression | NewExpression | undefined {
  let value = node;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const call = value.parent;
  return (isCallExpression(call) || isNewExpression(call)) &&
    call.expression === value &&
    !withinFunction(call, owner)
    ? call
    : undefined;
}

/** A later write can precede the next read when an enclosing loop carries that binding around. */
function repeatsBefore(write: Node, read: Node, binding: Binding): boolean {
  for (let each = read; each !== binding.owner; each = each.parent) {
    const parent = each.parent;
    if (
      !(
        isForStatement(parent) ||
        isForOfStatement(parent) ||
        isForInStatement(parent) ||
        isWhileStatement(parent) ||
        isDoStatement(parent)
      ) ||
      !contains(parent, write)
    ) {
      continue;
    }
    const initializer: Node | undefined = isForStatement(parent) ? parent.initializer : undefined;
    const once =
      initializer === each ||
      ((isForOfStatement(parent) || isForInStatement(parent)) && parent.expression === each);
    const reset = contains(parent.statement, binding.name) && binding.name.end < read.pos;
    if (!once && !reset) {
      return true;
    }
  }
  return false;
}

/** Source ranges of nodes in one syntax tree preserve ancestry for the loop's work. */
function contains(outer: Node, inner: Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    outer.pos <= inner.pos &&
    inner.end <= outer.end
  );
}

/** A binding or mutable member assignment, including destructuring targets. */
function bindsTarget(
  node: Node,
  isRead: (node: Node) => node is Identifier,
  mutable: boolean,
): boolean {
  let target = node;
  for (;;) {
    if (wrappedBy(target)) {
      target = (target as Expression & { readonly expression: Expression }).expression;
    } else if (isPropertyAssignment(target)) {
      target = target.initializer;
    } else if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      if (!mutable) {
        return false;
      }
      target = target.expression;
    } else {
      break;
    }
  }
  if (isIdentifier(target)) {
    return isRead(target);
  }
  if (isShorthandPropertyAssignment(target)) {
    return isRead(target.name);
  }
  return (
    target.forEachChild((child) => (bindsTarget(child, isRead, mutable) ? true : undefined)) ===
    true
  );
}

/** Mutable aliases and source parameters retain their lexical identity during unknown handoffs. */
function handedUnknown(name: Identifier, binding: Binding, pending: Binding[]): boolean {
  let node: Expression = name;
  while (wrappedBy(node.parent)) {
    node = node.parent as Expression;
  }
  const parent = node.parent;
  if (isVariableDeclaration(parent) && parent.initializer === node) {
    if (!isIdentifier(parent.name)) {
      return true;
    }
    pending.push(bindingOf(parent.name, node, binding.before));
    return false;
  }
  if (!isCallExpression(parent) && !isNewExpression(parent)) {
    return false;
  }
  const index = parent.arguments?.indexOf(node) ?? -1;
  if (index < 0 || globalPathOf(unwrapped(parent.expression)) !== undefined) {
    return false;
  }
  const fn = sourceFunction(parent.expression);
  if (fn === undefined) {
    return true;
  }
  const parameter = parametersOf(fn)[index];
  if (parameter !== undefined) {
    if (!isIdentifier(parameter.name)) {
      return true;
    }
    pending.push(bindingOf(parameter.name, undefined));
  }
  return false;
}

/** A source-backed local callable, without assuming what an unknown or imported callback does. */
function sourceFunction(callee: Expression): Answering | undefined {
  const fn = metadataCallee(callee);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** Wrappers that preserve a reference's identity. */
function wrappedBy(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}
