import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { declarationOf } from './framed.ts';
import { writesThis } from './held-methods.ts';
import { isKept, runsPerCall } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { bindsTarget, peelPlatform, wrappedBy } from './platform-uses.ts';
import { bindingIdentifiers, isTypeOnly } from './scope.ts';
import {
  type CallArgumentSlot,
  calleeMutatesThis,
  type LocalInvocable,
  type ResolvedInvocation,
  resolveInvocation,
} from './settled-calls.ts';
import {
  keptRootOf,
  keptTargetsOf,
  methodsAtExpressionPath,
  receiverMemberPath,
} from './settled-receivers.ts';
import { methodOf, writtenArgumentBy, writtenBy } from './written.ts';

/** Binary operators that evaluate to one of their operand expressions. */
const VALUE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Context carried while checking whether a parameter is mutated inside `callee`. */
interface ParameterMutationCheck {
  readonly argExpr: Expression;
  readonly callee: LocalInvocable;
  readonly isTracked: (node: Node) => node is Identifier;
  readonly seenParams: Set<ParameterDeclaration>;
}

/** Reports a kept module identifier when `node` passes kept mutable state into a mutating helper. */
export function keptCallParameterWrite(node: Node): Identifier | undefined {
  if ((!isCallExpression(node) && !isNewExpression(node)) || !runsPerCall(node)) {
    return undefined;
  }
  const resolved = resolveInvocation(node);
  if (resolved === undefined) {
    return undefined;
  }
  if (resolved.thisArg !== undefined) {
    const receiverHit = keptReceiverMutation(resolved.thisArg, resolved.callees);
    if (receiverHit !== undefined) {
      return receiverHit;
    }
  }
  for (const [argIndex, slot] of resolved.args.entries()) {
    const mutated = keptSlotMutation(slot, argIndex, resolved);
    if (mutated !== undefined) {
      return mutated;
    }
  }
  return undefined;
}

/** Reports a kept receiver identifier when `thisArg` is mutated via `this` inside `callees`. */
function keptReceiverMutation(
  thisArg: Expression,
  callees: readonly LocalInvocable[],
): Identifier | undefined {
  const candidates = keptArgumentCandidates(thisArg);
  return candidates.length > 0 && callees.some((callee) => calleeMutatesThis(callee))
    ? candidates[0]?.root
    : undefined;
}

/** Reports a kept argument identifier when `slot` at `argIndex` is mutated by `resolved.callees`. */
function keptSlotMutation(
  slot: CallArgumentSlot,
  argIndex: number,
  resolved: ResolvedInvocation,
): Identifier | undefined {
  const candidates = keptArgumentCandidates(slot.expr);
  const mutated = candidates.find((candidate) => {
    return resolved.callees.some((callee) => {
      return matchingParameters(callee, resolved.args, argIndex).some((param) =>
        parameterMutatedIn(callee, param, candidate.expr, new Set()),
      );
    });
  });
  return mutated?.root;
}

/** Extracts kept non-primitive root candidates from an argument expression. */
function keptArgumentCandidates(
  expr: Expression,
): readonly { readonly expr: Expression; readonly root: Identifier }[] {
  const found: { readonly expr: Expression; readonly root: Identifier }[] = [];
  const pending: Expression[] = [expr];
  const seen = new Set<Expression>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const clean = peelPlatform(current);
    if (seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    if (pushArgumentBranches(clean, pending)) {
      continue;
    }
    const root = keptRootOf(clean);
    if (
      root !== undefined &&
      isKept(root, writtenBy) &&
      !isImmutablePrimitiveBinding(clean, root)
    ) {
      found.push({ expr: clean, root });
    }
  }
  return found;
}

/** Expands ternary, logical, and comma branches of an argument expression. */
function pushArgumentBranches(clean: Expression, pending: Expression[]): boolean {
  if (isConditionalExpression(clean)) {
    pending.push(clean.whenTrue, clean.whenFalse);
    return true;
  }
  if (isBinaryExpression(clean)) {
    const kind = clean.operatorToken.kind;
    if (kind === SyntaxKind.CommaToken) {
      pending.push(clean.right);
      return true;
    }
    if (VALUE_OPERATORS.has(kind)) {
      pending.push(clean.left, clean.right);
      return true;
    }
  }
  return false;
}

/** Whether `expr` is a direct read of a `const` binding initialized to a primitive literal. */
function isImmutablePrimitiveBinding(expr: Expression, root: Identifier): boolean {
  if (expr !== root) {
    return false;
  }
  const declared = declarationOf(root);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined ||
    !isVariableDeclarationList(declared.parent) ||
    !/^const\s/u.test(declared.parent.getText())
  ) {
    return false;
  }
  const init = peelPlatform(declared.initializer);
  return (
    constantValue(init) !== undefined ||
    init.kind === SyntaxKind.NullKeyword ||
    isBigIntLiteral(init) ||
    isVoidExpression(init) ||
    isTemplateExpression(init)
  );
}

/** Maps a normalized argument slot at `argIndex` to formal parameters on `callee`. */
function matchingParameters(
  callee: LocalInvocable,
  args: readonly CallArgumentSlot[],
  argIndex: number,
): readonly ParameterDeclaration[] {
  const params = callee.parameters;
  const slot = args[argIndex];
  const prefix = args.slice(0, argIndex);
  const hasPriorSpread = prefix.some((each) => each.spread);
  const fixedBefore = prefix.filter((each) => !each.spread).length;
  if (slot?.spread === true) {
    return params.slice(fixedBefore);
  }
  return params.filter((param, paramIndex) => {
    if (param.dotDotDotToken !== undefined) {
      return hasPriorSpread || fixedBefore >= paramIndex;
    }
    return hasPriorSpread ? paramIndex >= fixedBefore : paramIndex === fixedBefore;
  });
}

/** Checks whether `callee` mutates `param` (or a local alias derived from `param`). */
function parameterMutatedIn(
  callee: LocalInvocable,
  param: ParameterDeclaration,
  argExpr: Expression,
  seenParams: Set<ParameterDeclaration>,
): boolean {
  if (seenParams.has(param)) {
    return false;
  }
  const nextSeen = new Set([...seenParams, param]);
  const isTracked = buildTrackedParameterPredicate(callee, param);
  const check: ParameterMutationCheck = { argExpr, callee, isTracked, seenParams: nextSeen };
  return (
    callee.parameters.some((each) => subtreeMutatesTracked(each, check)) ||
    (callee.body !== undefined && subtreeMutatesTracked(callee.body, check))
  );
}

/** Builds a predicate recognizing reads of `param`'s bindings and local aliases initialized from them. */
function buildTrackedParameterPredicate(
  callee: LocalInvocable,
  param: ParameterDeclaration,
): (node: Node) => node is Identifier {
  const trackedDecls = new Set<Identifier>(bindingIdentifiers(param.name));
  let predicates = [...trackedDecls].map((id) => readsOf(id, callee));
  const matchesAny = (node: Node): node is Identifier => predicates.some((fn) => fn(node));
  let added = true;
  while (added) {
    added = collectDerivedAliases(callee, trackedDecls, matchesAny);
    if (added) {
      predicates = [...trackedDecls].map((id) => readsOf(id, callee));
    }
  }
  return matchesAny;
}

/** Adds local variable declarations in `callee` initialized or assigned from `matchesAny`. */
function collectDerivedAliases(
  callee: LocalInvocable,
  trackedDecls: Set<Identifier>,
  matchesAny: (node: Node) => node is Identifier,
): boolean {
  let changed = false;
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (
      isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      referencesTracked(node.initializer, matchesAny)
    ) {
      for (const id of bindingIdentifiers(node.name)) {
        if (!trackedDecls.has(id)) {
          trackedDecls.add(id);
          changed = true;
        }
      }
    } else if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      referencesTracked(node.right, matchesAny)
    ) {
      changed = addAssignedAliasTargets(node.left, callee, trackedDecls) || changed;
    }
    node.forEachChild(visit);
  };
  callee.forEachChild(visit);
  return changed;
}

/** Records local variable declarations assigned from a tracked parameter expression. */
function addAssignedAliasTargets(
  left: Expression,
  callee: LocalInvocable,
  trackedDecls: Set<Identifier>,
): boolean {
  let changed = false;
  for (const leaf of keptTargetsOf(left)) {
    const clean = peelPlatform(leaf as Expression);
    const decl = isIdentifier(clean) ? declarationOf(clean) : undefined;
    if (
      decl !== undefined &&
      isVariableDeclaration(decl) &&
      isIdentifier(decl.name) &&
      decl.pos >= callee.pos &&
      decl.end <= callee.end &&
      !trackedDecls.has(decl.name)
    ) {
      trackedDecls.add(decl.name);
      changed = true;
    }
  }
  return changed;
}

/** Whether `expr` reads or projects from a tracked parameter binding (excluding call results). */
function referencesTracked(
  expr: Expression,
  matchesAny: (node: Node) => node is Identifier,
): boolean {
  const pending: Expression[] = [expr];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const clean = peelPlatform(item);
    if (isIdentifier(clean) && matchesAny(clean)) {
      return true;
    }
    if (isPropertyAccessExpression(clean) || isElementAccessExpression(clean)) {
      pending.push(clean.expression);
    } else if (isConditionalExpression(clean)) {
      pending.push(clean.whenTrue, clean.whenFalse);
    } else if (isBinaryExpression(clean) && VALUE_OPERATORS.has(clean.operatorToken.kind)) {
      pending.push(clean.left, clean.right);
    }
  }
  return false;
}

/** Walks `root` to detect member writes, mutator calls, `this` method writes, or mutating forwards. */
function subtreeMutatesTracked(root: Node, check: ParameterMutationCheck): boolean {
  let mutated = false;
  const visit = (node: Node): void => {
    if (mutated || isTypeOnly(node)) {
      return;
    }
    if (nodeMutatesTracked(node, check)) {
      mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return mutated;
}

/** Tests a single AST `node` for any mutation of a tracked parameter binding. */
function nodeMutatesTracked(node: Node, check: ParameterMutationCheck): boolean {
  const written = writtenBy(node);
  if (written !== undefined && writtenTargetsTracked(node, written, check.isTracked)) {
    return true;
  }
  for (const arg of writtenArgumentBy(node)) {
    const hasTrackedTarget = keptTargetsOf(arg).some((target) => {
      const root = keptRootOf(target);
      return root !== undefined && check.isTracked(root);
    });
    if (hasTrackedTarget) {
      return true;
    }
  }
  return callMutatesTracked(node, check);
}

/** Whether `written` mutates an object reachable from `isTracked` rather than reassigning a local variable. */
function writtenTargetsTracked(
  node: Node,
  written: Node,
  isTracked: (node: Node) => node is Identifier,
): boolean {
  const mutatesObjectInPlace = isCallExpression(node) || isNewExpression(node);
  return keptTargetsOf(written).some((target) => {
    if (mutatesObjectInPlace) {
      const root = keptRootOf(target);
      return root !== undefined && isTracked(root);
    }
    return hasMemberProjectionOf(target, isTracked);
  });
}

/** Whether `target` accesses at least one property or element on a binding matched by `isTracked`. */
function hasMemberProjectionOf(
  target: Node,
  isTracked: (node: Node) => node is Identifier,
): boolean {
  let current = target;
  let sawMember = false;
  for (;;) {
    if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
      sawMember = true;
      current = current.expression;
    } else if (wrappedBy(current)) {
      current = (current as Expression & { readonly expression: Expression }).expression;
    } else {
      break;
    }
  }
  return sawMember && isIdentifier(current) && isTracked(current);
}

/** Checks method `this` mutations and forwarded helper calls on a tracked parameter binding. */
function callMutatesTracked(node: Node, check: ParameterMutationCheck): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) {
    return false;
  }
  if (isCallExpression(node) && trackedReceiverWritesThis(node, check)) {
    return true;
  }
  const resolved = resolveInvocation(node);
  if (resolved === undefined) {
    return false;
  }
  if (
    resolved.thisArg !== undefined &&
    referencesTracked(resolved.thisArg, check.isTracked) &&
    resolved.callees.some((callee) => calleeMutatesThis(callee))
  ) {
    return true;
  }
  return resolved.args.some((slot, argIndex) => {
    if (
      !referencesTracked(slot.expr, check.isTracked) &&
      !bindsTarget(slot.expr, check.isTracked, true)
    ) {
      return false;
    }
    return resolved.callees.some((inner) => {
      return matchingParameters(inner, resolved.args, argIndex).some((innerParam) =>
        parameterMutatedIn(inner, innerParam, check.argExpr, check.seenParams),
      );
    });
  });
}

/** Checks whether `call` invokes a `this`-mutating method on a tracked parameter receiver. */
function trackedReceiverWritesThis(call: CallExpression, check: ParameterMutationCheck): boolean {
  const method = methodOf(call);
  const callee = peelPlatform(call.expression);
  if (
    method === undefined ||
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee))
  ) {
    return false;
  }
  const resolved = receiverMemberPath(callee.expression);
  if (resolved === undefined || !check.isTracked(resolved.root)) {
    return false;
  }
  const maps = methodsAtExpressionPath(check.argExpr, resolved.steps);
  return maps.some((methods) => writesThis(methods, method, writtenBy, { call, seen: new Set() }));
}
