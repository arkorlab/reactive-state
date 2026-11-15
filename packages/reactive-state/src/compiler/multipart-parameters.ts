import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedArgumentPrefix, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import { framedAssignedSources, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly } from './scope.ts';

/** Request options and body tracking across reassigned and mutated parameters. */

export interface BodyReading {
  readonly bodies: readonly Expression[];
  readonly overwrites: boolean;
}

export interface ParameterResolution {
  readonly cut?: BinaryExpression | undefined;
  readonly replaced: boolean;
  readonly values: readonly Expression[];
}

interface ParameterBodyWrite {
  readonly assignSources?: readonly Expression[];
  readonly exactBody: boolean;
  readonly node: Node;
  readonly values: readonly Expression[];
}

interface CutContext {
  readonly cut: Node | undefined;
  readonly name: Identifier;
  readonly parameter: ParameterDeclaration;
  readonly point: Node;
}

const BODY_KEY = 'body';
const DEFINE_PROPERTY = 'Object.defineProperty';
const DELETE_PROPERTY = 'Reflect.deleteProperty';
const OBJECT_ASSIGN = 'Object.assign';
const DEFINED = { slots: 3 } as const;

const MEMBER_WRITE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Possible request bodies carried by a reassigned, defaulted, or member-mutated options parameter. */
export function parameterBodies(
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
  readOptions: (value: Expression, at: Node) => BodyReading,
): BodyReading {
  const resolved = parameterValues(name, parameter);
  const baseContext: CutContext = { cut: resolved.cut, name, parameter, point };
  const writes = collectParameterBodyWrites(parameter, baseContext);
  const memberCut = definiteBodyMemberCut(resolved, writes, point, readOptions);
  if (memberCut !== undefined) {
    const afterCut = writes.filter(
      (each) => each === memberCut || !supersededBefore(each.node, memberCut.node, point),
    );
    const deleted = hasReachableBodyDelete(parameter, { ...baseContext, cut: memberCut.node });
    return {
      bodies: afterCut.flatMap((each) => writeBodies(each, readOptions)),
      overwrites: !deleted,
    };
  }
  const wholeValues =
    resolved.replaced || parameter.initializer === undefined
      ? resolved.values
      : [parameter.initializer, ...resolved.values];
  const wholeReadings = wholeValues.map((each) => readOptions(each, each));
  const memberBodies = writes.flatMap((each) => writeBodies(each, readOptions));
  const deleted = resolved.replaced && hasReachableBodyDelete(parameter, baseContext);
  return {
    bodies: [...wholeReadings.flatMap((each) => each.bodies), ...memberBodies],
    overwrites:
      resolved.replaced &&
      !deleted &&
      wholeReadings.length > 0 &&
      wholeReadings.every((each) => each.overwrites),
  };
}

/** Values assigned to a parameter before `name`, noting whether a definite write replaced the initial binding. */
export function parameterValues(
  name: Identifier,
  parameter: ParameterDeclaration,
): ParameterResolution {
  const owner = executionOwner(name);
  const cut = lastDefiniteParameterWrite(name, parameter, owner);
  const assigned = framedAssignedSources(name)
    .filter((each) => each.keys.length === 0)
    .map((each) => each.value);
  if (cut === undefined) {
    return { replaced: false, values: assigned };
  }
  const later = assigned.filter(
    (each) => each !== cut.right && (each.pos > cut.pos || executionOwner(each) !== owner),
  );
  return { cut, replaced: true, values: [cut.right, ...later] };
}

/** Body expressions contributed by one parameter member write or `Object.assign` call. */
function writeBodies(
  write: ParameterBodyWrite,
  readOptions: (value: Expression, at: Node) => BodyReading,
): readonly Expression[] {
  if (write.assignSources === undefined) {
    return write.values;
  }
  return write.assignSources.flatMap((source) => readOptions(source, write.node).bodies);
}

/** Finds the latest definite exact-`body` member write after a fresh whole-parameter replacement. */
function definiteBodyMemberCut(
  resolved: ParameterResolution,
  writes: readonly ParameterBodyWrite[],
  point: Node,
  readOptions: (value: Expression, at: Node) => BodyReading,
): ParameterBodyWrite | undefined {
  if (
    resolved.cut === undefined ||
    resolved.values.length !== 1 ||
    !freshBodyObject(resolved.cut.right)
  ) {
    return undefined;
  }
  let latest: ParameterBodyWrite | undefined;
  for (const write of writes) {
    if (
      definitelyOverwritesBody(write, readOptions) &&
      definitelyBefore(write.node, point) &&
      (latest === undefined || write.node.pos > latest.node.pos)
    ) {
      latest = write;
    }
  }
  return latest;
}

/** Whether a member write unconditionally replaces the `body` property when executed. */
function definitelyOverwritesBody(
  write: ParameterBodyWrite,
  readOptions: (value: Expression, at: Node) => BodyReading,
): boolean {
  if (write.assignSources !== undefined) {
    return write.assignSources.some((source) => readOptions(source, write.node).overwrites);
  }
  return write.exactBody;
}

/** Whether `node` is a fresh object literal without an accessor intercepting `body`. */
function freshBodyObject(node: Expression): boolean {
  const value = unwrapped(node);
  return isObjectLiteralExpression(value) && !framedLiteralAccessor(value, BODY_KEY);
}

/** Collects reachable member writes to `body` on `parameter` (or whole `const` aliases) after `cut`. */
function collectParameterBodyWrites(
  parameter: ParameterDeclaration,
  context: CutContext,
): readonly ParameterBodyWrite[] {
  const found: ParameterBodyWrite[] = [];
  const pending: Node[] = [parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    const write = parameterBodyWriteAt(node, parameter);
    if (write !== undefined && activeAtRead(write.node, context)) {
      found.push(write);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** Extracts a `body`-affecting write on `parameter` from an assignment or `Object` mutator call. */
function parameterBodyWriteAt(
  node: Node,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  if (isBinaryExpression(node) && MEMBER_WRITE_OPERATORS.has(node.operatorToken.kind)) {
    return binaryParameterBodyWrite(node, parameter);
  }
  return isCallExpression(node) ? callParameterBodyWrite(node, parameter) : undefined;
}

/** Extracts `options.body = rhs`, `options[key] = rhs`, or logical member assignments on `parameter`. */
function binaryParameterBodyWrite(
  node: BinaryExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const target = unwrapped(node.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return undefined;
  }
  if (!holdsParameter(target.expression, parameter)) {
    return undefined;
  }
  const names = framedMemberNames(target);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return undefined;
  }
  const exactBody =
    node.operatorToken.kind === SyntaxKind.EqualsToken &&
    names?.length === 1 &&
    names[0] === BODY_KEY;
  return { exactBody, node, values: [node.right] };
}

/** Extracts `Object.assign(options, ...)` and `Object.defineProperty(options, 'body', ...)` writes. */
function callParameterBodyWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path === OBJECT_ASSIGN) {
    const [target, ...sources] = framedArgumentPrefix(node, node.arguments, Infinity).values;
    return target !== undefined && holdsParameter(target, parameter) && sources.length > 0
      ? { assignSources: sources, exactBody: false, node, values: [] }
      : undefined;
  }
  return path === DEFINE_PROPERTY ? definePropertyBodyWrite(node, parameter) : undefined;
}

/** Extracts `Object.defineProperty(options, key, { value })` when `key` may name `body`. */
function definePropertyBodyWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const [target, key, descriptor] = framedArgumentPrefix(
    node,
    node.arguments,
    DEFINED.slots,
  ).values;
  if (
    target === undefined ||
    key === undefined ||
    descriptor === undefined ||
    !holdsParameter(target, parameter)
  ) {
    return undefined;
  }
  const names = framedKeyNames(key);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return undefined;
  }
  const values = framedDescriptorEntries(descriptor, ['value']) ?? [];
  const exactBody = names?.length === 1 && names[0] === BODY_KEY && values.length === 1;
  return values.length === 0 ? undefined : { exactBody, node, values };
}

/** Checks whether any reachable deletion or non-global hand-off can remove `body` on `parameter`. */
function hasReachableBodyDelete(parameter: ParameterDeclaration, context: CutContext): boolean {
  const pending: Node[] = [parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (removesParameterBody(node, parameter) && activeAtRead(node, context)) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether `node` deletes `body` (or an unknown key) on `parameter` or hands `parameter` to unknown code. */
function removesParameterBody(node: Node, parameter: ParameterDeclaration): boolean {
  if (isCallExpression(node) || isNewExpression(node)) {
    return callRemovesParameterBody(node, parameter);
  }
  if (!isDeleteExpression(node)) {
    return false;
  }
  const target = unwrapped(node.expression);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return false;
  }
  const names = framedMemberNames(target);
  return holdsParameter(target.expression, parameter) && names?.includes(BODY_KEY) !== false;
}

/** Checks `Reflect.deleteProperty(options, key)` and non-global calls receiving `options`. */
function callRemovesParameterBody(
  node: CallExpression | NewExpression,
  parameter: ParameterDeclaration,
): boolean {
  const callee = unwrapped(node.expression);
  const native = globalPathOf(callee)?.join('.');
  if (native === DELETE_PROPERTY && isCallExpression(node)) {
    const [target, key] = framedArgumentPrefix(node, node.arguments).values;
    const names = key === undefined ? undefined : framedKeyNames(key);
    return (
      target !== undefined &&
      holdsParameter(target, parameter) &&
      names?.includes(BODY_KEY) !== false
    );
  }
  if (native !== undefined) {
    return false;
  }
  const handed = [...(node.arguments ?? [])].map((arg) =>
    isSpreadElement(arg) ? arg.expression : arg,
  );
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    handed.push(callee.expression);
  }
  return handed.some((each) => holdsParameter(each, parameter));
}

/** Whether `node` evaluates directly to `parameter` or a whole `const` alias of `parameter`. */
function holdsParameter(node: Expression, parameter: ParameterDeclaration): boolean {
  let current: Expression | undefined = unwrapped(node);
  const seen = new Set<Node>();
  while (current !== undefined && isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const declared = frameDeclarationOf(current);
    if (declared === parameter) {
      return true;
    }
    current = constantAliasValue(declared);
  }
  return false;
}

/** Initializer unwrapped from a whole `const` variable declaration; undefined otherwise. */
function constantAliasValue(declared: Node | undefined): Expression | undefined {
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    !isVariableDeclarationList(declared.parent) ||
    !/^const\s/u.test(declared.parent.getText(declared.getSourceFile())) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  return unwrapped(declared.initializer);
}

/** Whether `change` reaches `point` and was not superseded before `cut` in the same owner. */
function activeAtRead(change: Node, context: CutContext): boolean {
  if (!reachesPoint(change, context.name, context.parameter, context.point)) {
    return false;
  }
  return context.cut === undefined || !supersededBefore(change, context.cut, context.name);
}

/** Whether a change may run before `point`: from another owner, earlier, or via an enclosing loop. */
function reachesPoint(
  change: Node,
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    executionOwner(change) !== owner ||
    change.pos < point.end ||
    destructuredFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, name, parameter, owner);
}

/** Whether `change` ran in the same execution owner strictly before `cut`. */
function supersededBefore(change: Node, cut: Node, anchor: Node): boolean {
  return change.pos < cut.pos && executionOwner(change) === executionOwner(anchor);
}

/** Whether `change` is an earlier statement of an enclosing block in the same execution owner as `point`. */
function definitelyBefore(change: Node, point: Node): boolean {
  if (executionOwner(change) !== executionOwner(point)) {
    return false;
  }
  const statement = change.parent;
  if (!isExpressionStatement(statement)) {
    return false;
  }
  const block = statement.parent;
  if (!isBlock(block) && !isSourceFile(block)) {
    return false;
  }
  for (let at: Node = point; !isSourceFile(at); at = at.parent) {
    if (at.parent === block) {
      return at.pos > statement.pos;
    }
  }
  return false;
}

/** Latest plain statement assignment to `parameter` in an enclosing block before `name`. */
function lastDefiniteParameterWrite(
  name: Identifier,
  parameter: ParameterDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  let latest: BinaryExpression | undefined;
  for (let at: Node = name; at !== owner && !isSourceFile(at); at = at.parent) {
    const parent = at.parent;
    if (!isBlock(parent) && !isSourceFile(parent)) {
      continue;
    }
    for (const statement of parent.statements) {
      if (statement === at) {
        break;
      }
      const write = directParameterWrite(statement, parameter, owner);
      if (write !== undefined && (latest === undefined || write.pos > latest.pos)) {
        latest = write;
      }
    }
  }
  return latest;
}

/** Plain `param = rhs` expression statement in the same execution owner. */
function directParameterWrite(
  statement: Node,
  parameter: ParameterDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  if (!isExpressionStatement(statement)) {
    return undefined;
  }
  const expression = unwrapped(statement.expression);
  if (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(expression.left) &&
    frameDeclarationOf(expression.left) === parameter &&
    executionOwner(expression) === owner
  ) {
    return expression;
  }
  return undefined;
}
