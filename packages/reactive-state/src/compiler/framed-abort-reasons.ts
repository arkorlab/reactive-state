import {
  type CallExpression,
  type Expression,
  type IfStatement,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type NewExpression,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedAbortCondition } from './framed-abort-conditions.ts';
import { framedAbortUndefinedReason, framedAbortDefaultRead } from './framed-abort-undefined.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { writtenArrayFunction, writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A fresh native controller retains its first source-written abort reason. */

const CONTROLLERS = new Set(['AbortController']);
const QUIET_ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
const AGGREGATES = new Set(['AggregateError']);
const DOM_ERRORS = new Set(['DOMException']);
const NATIVE_ABORTS = new Set(['AbortController.prototype.abort']);

interface Origin {
  readonly binding: FrameBinding;
  readonly keys: readonly string[];
  readonly read: Expression;
}
interface AbortCall {
  readonly call: CallExpression;
  readonly args: readonly Expression[] | undefined;
  readonly borrowed: boolean;
}
interface Reason {
  readonly quiet?: boolean;
  readonly inferredDefault?: boolean;
  readonly value: Expression | undefined;
}

/** Literal reasons keep data; supplied errors and native default reasons retain their identity. */
export function framedAbortReason(
  value: Expression,
  selection: { readonly made: boolean; readonly keys: readonly string[] },
  error: (value: Expression, made: boolean, keys: readonly string[]) => boolean,
): boolean | undefined {
  const origin = controllerOrigin(value, selection.keys);
  if (origin?.keys[0] !== 'signal' || origin.keys[1] !== 'reason') return undefined;
  const keys = origin.keys.slice(2);
  if (
    conditionalAbortReasons(origin).some((reason) => {
      return reason.value === undefined
        ? keys.length === 0 && framedAbortDefaultRead(reason, origin.read)
        : error(reason.value, selection.made, keys);
    })
  )
    return true;
  const reason = firstAbort(origin);
  if (reason === undefined) return undefined;
  if (reason.value === undefined)
    return keys.length === 0 && framedAbortDefaultRead(reason, origin.read) ? true : undefined;
  if (error(reason.value, selection.made, keys)) return true;
  return !selection.made &&
    reason.quiet !== false &&
    keys.length === 0 &&
    error(reason.value, true, [])
    ? false
    : undefined;
}

/** Whole const aliases and signal views retain their original reason-read position. */
function controllerOrigin(node: Expression, keys: readonly string[] = []): Origin | undefined {
  let value = unwrapped(node);
  let path = [...keys];
  let read = node;
  let binding: FrameBinding | undefined;
  const seen = new Set<Node>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = frameMemberName(value);
      if (key === undefined) return undefined;
      if (key === 'reason') read = value;
      path.unshift(key);
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) break;
    const selected = constantOrigin(value);
    if (selected === undefined) return undefined;
    binding = selected.binding;
    path = [...selected.keys, ...path];
    value = unwrapped(selected.initializer);
  }
  return binding !== undefined &&
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, CONTROLLERS)
    ? { binding, keys: path, read }
    : undefined;
}

/** Only immutable written bindings carry a controller's native construction. */
function constantOrigin(value: Expression) {
  if (!isIdentifier(value)) return;
  const selected = frameBindingOf(value);
  if (selected === undefined || !isVariableDeclaration(selected.binding)) return;
  const { binding } = selected;
  return isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile())) &&
    binding.initializer !== undefined
    ? { ...selected, initializer: binding.initializer }
    : undefined;
}

/** Ordinary enclosing blocks retain prior calls without discarding the existing immediate proof. */
function prefixStatements(read: Node):
  | {
      readonly ordinary: readonly Statement[];
      readonly immediate: readonly Statement[];
    }
  | undefined {
  const owner = executionOwner(read);
  const prefix: Statement[] = [];
  let immediate: readonly Statement[] | undefined;
  let statement = read;
  while (statement !== owner) {
    const before = statementsBefore(statement);
    if (before !== undefined) {
      immediate ??= before;
      prefix.unshift(...before);
    } else if (isBlock(statement) && statement.parent !== owner) {
      // A conditional or repeated body keeps the existing immediate-block proof.
      return immediate === undefined ? undefined : { ordinary: immediate, immediate };
    }
    statement = statement.parent;
  }
  return immediate === undefined ? undefined : { ordinary: prefix, immediate };
}

/** Earlier application work remains a barrier to a newly inferred reason across ordinary blocks. */
function statementsBefore(statement: Node): readonly Statement[] | undefined {
  const parent = statement.parent;
  if (!isBlock(parent) && !isSourceFile(parent)) return undefined;
  const statements: Statement[] = [];
  for (const before of parent.statements) {
    if (before === statement) return statements;
    statements.push(before);
  }
  return undefined;
}

interface AbortPath {
  readonly statements: readonly Statement[];
  readonly custom: boolean;
}

/** Simple source-written if arms retain possible first reasons without replacing a data exemption. */
function conditionalAbortReasons(origin: Origin): readonly Reason[] {
  const prefix = prefixStatements(origin.read)?.ordinary;
  if (prefix === undefined) return [];
  if (!prefix.includes(origin.binding.parent.parent as Statement)) return [];
  const pending: AbortPath[] = [{ statements: prefix, custom: false }];
  const native = new Set<Statement>();
  const custom = new Set<Statement>();
  const reasons: Reason[] = [];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const statement = path.statements[0];
    if (statement === undefined) continue;
    const seen = path.custom ? custom : native;
    if (seen.has(statement)) continue;
    seen.add(statement);
    conditionalAbortStep(origin, path, reasons, pending);
  }
  return reasons;
}

/** Each arm follows existing native/own-method proofs, stopping before unknown application work. */
function conditionalAbortStep(
  origin: Origin,
  path: AbortPath,
  reasons: Reason[],
  pending: AbortPath[],
): void {
  const statement = path.statements[0];
  if (statement === undefined) return;
  const rest = path.statements.slice(1);
  const call = abortCall(statement, origin.binding);
  if (call !== undefined) {
    if (path.custom && !call.borrowed) return;
    const reason = abortArgument(call, origin.binding);
    if (reason !== undefined && quietArguments(call, origin.binding))
      reasons.push({
        ...reason,
        quiet:
          reason.inferredDefault !== true ||
          remainingPrefixQuiet(rest, origin.binding, path.custom),
      });
    return;
  }
  const own = abortAssignment(statement, origin.binding);
  if (own !== undefined) {
    pending.push({ ...path, statements: rest, custom: own });
    return;
  }
  if (isIfStatement(statement)) {
    conditionalAbortArms(statement, origin.binding, path, pending);
    return;
  }
  if (
    (isVariableStatement(statement) || isExpressionStatement(statement)) &&
    !unknownControllerUse(statement, origin.binding)
  )
    pending.push({ ...path, statements: rest });
}

/** Literal/binding conditions cannot run application code; unsupported control stays opaque. */
function conditionalAbortArms(
  statement: IfStatement,
  binding: FrameBinding,
  path: AbortPath,
  pending: AbortPath[],
): void {
  const condition = framedAbortCondition(statement.expression);
  if (condition === undefined || mentionsController(statement.expression, binding)) return;
  const { selected } = condition;
  const arms =
    selected === undefined
      ? [statement.thenStatement, statement.elseStatement]
      : [selected ? statement.thenStatement : statement.elseStatement];
  for (const arm of arms) {
    let statements: readonly Statement[] = [];
    if (arm !== undefined) statements = isBlock(arm) ? arm.statements : [arm];
    pending.push({
      custom: path.custom,
      statements: [...statements, ...path.statements.slice(1)],
    });
  }
}

/** The first definite native call wins; unknown earlier uses cannot establish a later reason. */
function firstAbort(origin: Origin): Reason | undefined {
  if (executionOwner(origin.read) !== executionOwner(origin.binding)) return undefined;
  const prefix = prefixStatements(origin.read);
  if (prefix === undefined) return undefined;
  return firstAbortWithin(origin, prefix.ordinary) ?? firstAbortWithin(origin, prefix.immediate);
}

/** A known enclosing reason wins; opaque enclosing work retains the original immediate proof. */
function firstAbortWithin(origin: Origin, prefix: readonly Statement[]): Reason | undefined {
  let custom = false;
  for (const [index, statement] of prefix.entries()) {
    const call = abortCall(statement, origin.binding);
    if (call !== undefined) {
      if (custom && !call.borrowed) return undefined;
      return retainedReason(call, origin.binding, prefix.slice(index + 1), custom);
    }
    const own = abortAssignment(statement, origin.binding);
    if (own !== undefined) {
      custom = own;
      continue;
    }
    if (unknownControllerUse(statement, origin.binding)) return undefined;
  }
  return undefined;
}

/** The first reason keeps its positive identity while later work can remove its own-word exemption. */
function retainedReason(
  call: AbortCall,
  binding: FrameBinding,
  prefix: readonly Statement[],
  custom: boolean,
): Reason | undefined {
  const reason = abortArgument(call, binding);
  return reason === undefined
    ? undefined
    : {
        ...reason,
        quiet: quietArguments(call, binding) && remainingPrefixQuiet(prefix, binding, custom),
      };
}

/** Later native aborts keep the reason; other work can replace the signal view before it is read. */
function remainingPrefixQuiet(
  prefix: readonly Statement[],
  binding: FrameBinding,
  initiallyCustom: boolean,
): boolean {
  let custom = initiallyCustom;
  for (const statement of prefix) {
    const call = abortCall(statement, binding);
    if (call !== undefined) {
      if ((custom && !call.borrowed) || !quietArguments(call, binding)) return false;
      continue;
    }
    const own = abortAssignment(statement, binding);
    if (own !== undefined) {
      custom = own;
      continue;
    }
    if (unknownControllerUse(statement, binding)) return false;
  }
  return true;
}

/** Unknown source work can change a fresh controller; its own birth and constant aliases cannot. */
function unknownControllerUse(statement: Statement, binding: FrameBinding): boolean {
  return (
    !aliasStatement(statement, binding) &&
    (mentionsController(statement, binding) || applicationWork(statement))
  );
}

/** Every argument is evaluated before abort runs, including arguments the native method ignores. */
function quietArguments(call: AbortCall, binding: FrameBinding): boolean {
  if (call.args === undefined) return false;
  const prefix = framedArgumentPrefix(call.call, call.args, Infinity);
  return (
    !prefix.unknown &&
    prefix.alternatives === undefined &&
    prefix.values.every((each) => quietArgument(each, binding))
  );
}

/** Literal evaluations and known native Error constructions do not invoke application work. */
function quietArgument(value: Expression, binding: FrameBinding): boolean {
  if (mentionsController(value, binding)) return false;
  const pending: Node[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isCallExpression(node) || isNewExpression(node)) {
      if (!quietError(node, binding)) return false;
      continue;
    }
    if (
      isPropertyAccessExpression(node) ||
      isElementAccessExpression(node) ||
      isSpreadElement(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Native Error operands keep their own conversion and option reads quiet before construction. */
function quietError(node: CallExpression | NewExpression, binding: FrameBinding): boolean {
  if (!framedNativeConstructor(node.expression, QUIET_ERRORS)) return false;
  const prefix = framedArgumentPrefix(node, node.arguments ?? [], Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const args = prefix.values;
  const aggregate = framedNativeConstructor(node.expression, AGGREGATES);
  const message = aggregate ? 1 : 0;
  if (aggregate && !quietIterable(args[0], binding)) return false;
  if (!quietPrimitive(args[message])) return false;
  const dom = framedNativeConstructor(node.expression, DOM_ERRORS);
  if (dom ? !quietPrimitive(args[1]) : !quietOptions(args[message + 1], binding)) return false;
  return args.every((each) => quietArgument(each, binding));
}

/** Only fresh literal iterables prove that AggregateError will not run an unknown iterator. */
function quietIterable(value: Expression | undefined, binding: FrameBinding): boolean {
  if (value === undefined) return false;
  const array = unwrapped(value);
  return (
    isArrayLiteralExpression(array) && array.elements.every((each) => quietArgument(each, binding))
  );
}

/** Written primitive messages do not call an application's coercion methods. */
function quietPrimitive(node: Expression | undefined): boolean {
  if (node === undefined) return true;
  const value = unwrapped(node);
  return (
    constantValue(value, (name) => {
      const origin = constantOrigin(name);
      return origin?.keys.length === 0 ? origin.initializer : undefined;
    }) !== undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.BigIntLiteral ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** Fresh own data options cannot invoke a cause getter or an inherited application property. */
function quietOptions(node: Expression | undefined, binding: FrameBinding): boolean {
  if (node === undefined || quietPrimitive(node)) return true;
  const value = unwrapped(node);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((each) => {
      return (
        isPropertyAssignment(each) &&
        writtenArrayKey(each.name) !== undefined &&
        writtenArrayKey(each.name) !== '__proto__' &&
        quietArgument(each.initializer, binding)
      );
    })
  );
}

/** Direct calls and native borrowing share the same controller identity and first reason slot. */
function abortCall(statement: Statement, binding: FrameBinding): AbortCall | undefined {
  if (!isExpressionStatement(statement) || !isCallExpression(statement.expression))
    return undefined;
  const call = statement.expression;
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.join('.') === 'AbortController.prototype.abort')
    return sameController(borrowed.receiver, binding)
      ? {
          call,
          args:
            borrowed.applied === undefined
              ? borrowed.given
              : framedAppliedArguments(call, borrowed.applied),
          borrowed: true,
        }
      : undefined;
  const member = unwrapped(call.expression);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'abort' &&
    sameController(member.expression, binding)
    ? { call, args: call.arguments, borrowed: false }
    : undefined;
}

/** A source-known prefix fixes omitted reasons; payload evaluation cannot use the controller. */
function abortArgument(selected: AbortCall, binding: FrameBinding): Reason | undefined {
  if (selected.args === undefined) return undefined;
  const prefix = framedArgumentPrefix(selected.call, selected.args, 1);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const first = prefix.values[0];
  if (first !== undefined && mentionsController(first, binding)) return undefined;
  if (first === undefined || globalPathOf(unwrapped(first))?.join('.') === 'undefined')
    return { value: undefined };
  return framedAbortUndefinedReason(first, selected.call)
    ? { value: undefined, inferredDefault: true }
    : { value: first };
}

/** Direct own abort functions intercept calls; explicit native restoration keeps native semantics. */
function abortAssignment(statement: Statement, binding: FrameBinding): boolean | undefined {
  if (!isExpressionStatement(statement) || !isBinaryExpression(statement.expression))
    return undefined;
  const assignment = statement.expression;
  if (assignment.operatorToken.kind !== SyntaxKind.EqualsToken) return undefined;
  const member = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'abort' ||
    !sameController(member.expression, binding)
  )
    return undefined;
  if (framedNativeConstructor(assignment.right, NATIVE_ABORTS)) return false;
  return writtenArrayFunction(assignment.right) ? true : undefined;
}

/** Native object aliases and readonly signal captures cannot abort or expose a fresh controller. */
function aliasStatement(statement: Statement, binding: FrameBinding): boolean {
  return (
    isVariableStatement(statement) &&
    /^const\b/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    statement.declarationList.declarations.every((declaration) => {
      if (declaration === binding || declaration.initializer === undefined) return true;
      const origin = controllerOrigin(declaration.initializer);
      return (
        origin !== undefined &&
        (origin.keys.length === 0 || (origin.keys.length === 1 && origin.keys[0] === 'signal'))
      );
    })
  );
}

/** Earlier calls and member evaluations can run a later-declared capture before this direct abort. */
function applicationWork(statement: Node): boolean {
  const owner = executionOwner(statement);
  const pending: Node[] = [statement];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || executionOwner(node) !== owner) continue;
    if (
      isCallExpression(node) ||
      isNewExpression(node) ||
      isPropertyAccessExpression(node) ||
      isElementAccessExpression(node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Receiver aliases must denote this fresh controller itself, not its signal or selected reason. */
function sameController(value: Expression, binding: FrameBinding): boolean {
  const origin = controllerOrigin(value);
  return origin?.binding === binding && origin.keys.length === 0;
}

/** Unknown direct or captured uses make the straight-line first-call proof opaque. */
function mentionsController(node: Node, binding: FrameBinding): boolean {
  const pending: Node[] = [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (
      isIdentifier(at) &&
      at !== binding.name &&
      readsBinding(at) &&
      controllerOrigin(at)?.binding === binding
    )
      return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
