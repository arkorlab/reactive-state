import {
  type CallExpression,
  type Expression,
  type Identifier,
  type NewExpression,
  type Node,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
} from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { reachedLoopRead } from './framed-writes.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native parameter readers and parameter, header and form mutators convert their consumed inputs. */

const HEADERS = new Set(['Headers']);
const PARAMS = new Set(['URLSearchParams']);
const FORMS = new Set(['FormData']);
const BLOBS = new Set(['Blob', 'File']);
const FORM_DELETE = 'FormData.prototype.delete';
const FORM_METHODS = new Set([FORM_DELETE, 'FormData.prototype.append', 'FormData.prototype.set']);
const INPUT = { filename: 3 } as const;
const METHODS = new Set(['append', 'delete', 'set']);
const PARAM_READERS = new Set(['get', 'getAll', 'has']);
const NAME_READERS = new Set(['get', 'getAll']);
const NATIVE_READERS = new Set(
  [...PARAM_READERS].map((method) => `URLSearchParams.prototype.${method}`),
);
for (const method of PARAM_READERS) {
  const reader = `FormData.prototype.${method}`;
  NATIVE_READERS.add(reader);
  FORM_METHODS.add(reader);
}
const QUIET_READERS = new Set(NATIVE_READERS);
for (const name of PARAMS) QUIET_READERS.add(name);
for (const name of FORMS) QUIET_READERS.add(name);
const NATIVE_METHODS = new Set([
  FORM_DELETE,
  'FormData.prototype.append',
  'FormData.prototype.get',
  'FormData.prototype.getAll',
  'FormData.prototype.has',
  'FormData.prototype.set',
  'Headers.prototype.append',
  'Headers.prototype.delete',
  'Headers.prototype.set',
  'URLSearchParams.prototype.append',
  'URLSearchParams.prototype.delete',
  'URLSearchParams.prototype.get',
  'URLSearchParams.prototype.getAll',
  'URLSearchParams.prototype.has',
  'URLSearchParams.prototype.set',
]);
const HEADER_METHODS = new Set([...METHODS].map((method) => `Headers.prototype.${method}`));
const NAME_ONLY = new Set([
  FORM_DELETE,
  'FormData.prototype.get',
  'FormData.prototype.getAll',
  'FormData.prototype.has',
  'Headers.prototype.delete',
  'URLSearchParams.prototype.get',
  'URLSearchParams.prototype.getAll',
]);

interface ParameterWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

interface ParameterSource {
  readonly construction: NewExpression;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly headers: boolean;
  readonly form: boolean;
}

interface MethodInput {
  readonly reader: boolean;
  readonly args: readonly Expression[] | undefined;
  readonly applied: Expression | undefined;
  readonly limit: number;
}

/** Source-known native instances and explicit native borrowing preserve the converted input slots. */
export function framedParamMethodText(call: CallExpression, words: ParameterWords): boolean {
  const selected = methodInput(call);
  if (selected === undefined) return false;
  if (selected.args === undefined)
    return selected.applied !== undefined && arrayError(selected.applied, words, call);
  return framedConsumedArguments(call, selected.args, selected.limit).some((argument) => {
    const spread = isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    return (
      (!spread &&
        (!selected.reader || framedNativeErrorInput(value, call, undefined, false)) &&
        words.error(value)) ||
      ((!selected.reader || framedQuietArrayWords(value, words.error, call)) &&
        arrayError(value, words, call))
    );
  });
}

/** Header delete consumes only its name; parameter delete may also convert its selected value. */
function methodInput(call: CallExpression): MethodInput | undefined {
  const borrowed = borrowedInput(call);
  if (borrowed !== undefined) return borrowed;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  if (method === undefined || sourceArrayFunction(member)) return undefined;
  const reader = PARAM_READERS.has(method);
  if (!reader && !METHODS.has(method)) return undefined;
  const source = parameterSource(member.expression);
  if (source === undefined || ownMethod(call, source, member.expression, method)) return undefined;
  if (
    reader &&
    ((isElementAccessExpression(member) &&
      !framedQuietInputs([member.argumentExpression], QUIET_READERS)) ||
      source.headers ||
      readerReceiverExposed(call, member.expression, source) ||
      !quietReaderInputs(call, source.construction, call.arguments))
  )
    return undefined;
  return {
    reader,
    args: call.arguments,
    applied: undefined,
    limit: directMethodLimit(call, source, method),
  };
}

/** FormData readers consume only their name; parameter has retains its optional comparison value. */
function directMethodLimit(call: CallExpression, source: ParameterSource, method: string): number {
  if (NAME_READERS.has(method) || (source.form && PARAM_READERS.has(method))) return 1;
  return mutationLimit(
    call,
    call.arguments,
    source.form,
    (source.headers || source.form) && method === 'delete',
  );
}

/** Explicit native borrowing fixes its receiver and ignores instance own-method replacements. */
function borrowedInput(call: CallExpression): MethodInput | undefined {
  const native = framedNativeArguments(call, NATIVE_METHODS, true);
  if (native === undefined || native.constructed) return undefined;
  const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
  const receiver = framedArgumentPrefix(call, call.arguments).values[reflected ? 1 : 0];
  if (receiver === undefined) return undefined;
  const source = parameterSource(receiver);
  const headers = framedNativeConstructor(native.target, HEADER_METHODS);
  const form = framedNativeConstructor(native.target, FORM_METHODS);
  if (source?.headers !== headers || source.form !== form) return undefined;
  if (
    framedNativeConstructor(native.target, NATIVE_READERS) &&
    !quietReaderInputs(call, source.construction, native.args)
  )
    return undefined;
  return {
    reader: framedNativeConstructor(native.target, NATIVE_READERS),
    args: native.args,
    applied: native.applied,
    limit: mutationLimit(
      call,
      native.args,
      form,
      framedNativeConstructor(native.target, NAME_ONLY),
    ),
  };
}

/** Added parameter readers retain opacity when any earlier input evaluation can run application work. */
function quietReaderInputs(
  call: CallExpression,
  construction: NewExpression,
  args: readonly Expression[] | undefined,
): boolean {
  if (
    framedNativeConstructor(construction.expression, FORMS) &&
    (construction.arguments?.length ?? 0) > 0
  )
    return false;
  return (
    args !== undefined &&
    (construction.arguments ?? []).every((argument) => framedQuietData(argument)) &&
    framedQuietInputs(call.arguments, QUIET_READERS) &&
    framedQuietInputs(args, QUIET_READERS)
  );
}

/** Fresh FormData readers additionally retain closed primitive native mutator prefixes. */
function readerReceiverExposed(
  call: CallExpression,
  receiver: Expression,
  source: ParameterSource,
): boolean {
  const target = unwrapped(receiver);
  return source.form && isIdentifier(target)
    ? exposedBefore({
        call,
        receiver,
        target,
        bindings: source.bindings,
        formReader: true,
        reached: false,
      })
    : argumentArrayExposed(receiver, source.bindings, undefined, false);
}

/** Native mutator overloads retain each consumed input slot. */
function mutationLimit(
  call: CallExpression,
  args: readonly Expression[] | undefined,
  form: boolean,
  nameOnlyDelete: boolean,
): number {
  if (nameOnlyDelete) return 1;
  return form ? formLimit(call, args) : 2;
}

/** Whole immutable receiver aliases retain the fresh native construction's original lexical identity. */
function parameterSource(node: Expression): ParameterSource | undefined {
  const source = constantConstruction(node);
  if (source === undefined) return undefined;
  const headers = framedNativeConstructor(source.construction.expression, HEADERS);
  const form = framedNativeConstructor(source.construction.expression, FORMS);
  return headers || form || framedNativeConstructor(source.construction.expression, PARAMS)
    ? { ...source, headers, form }
    : undefined;
}

/** Blob-only filename overloads convert the third slot; primitive string values cannot reach it. */
function formLimit(call: CallExpression, args: readonly Expression[] | undefined): number {
  if (args === undefined) return 2;
  const prefix = framedArgumentPrefix(call, args, INPUT.filename);
  const value = prefix.values[1];
  if (value !== undefined && blobInput(value)) return INPUT.filename;
  return prefix.values[2] === undefined ? 2 : 1;
}

/** Native constructions and a supplied parameter's written native type select the Blob overload. */
function blobInput(node: Expression): boolean {
  const source = constantSource(node);
  if (source === undefined) return false;
  const value = source.value;
  if (isNewExpression(value)) return framedNativeConstructor(value.expression, BLOBS);
  if (!isIdentifier(value)) return false;
  const selected = frameBindingOf(value);
  return (
    selected !== undefined &&
    isParameterDeclaration(selected.binding) &&
    namesLocalMemberType(selected.binding.type, selected.keys, BLOBS)
  );
}

/** Whole constant aliases retain an original construction without adding a type or brand guess. */
function constantConstruction(
  node: Expression,
):
  | { readonly construction: NewExpression; readonly bindings: ReadonlySet<FrameBinding> }
  | undefined {
  const source = constantSource(node);
  return source !== undefined && isNewExpression(source.value)
    ? { construction: source.value, bindings: source.bindings }
    : undefined;
}

/** Written constant initializers take precedence over annotations at each lexical alias step. */
function constantSource(
  node: Expression,
): { readonly value: Expression; readonly bindings: ReadonlySet<FrameBinding> } | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return { value, bindings };
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return { value, bindings };
}

/** A directly preceding callable write on an unexposed fresh receiver replaces this native method. */
function ownMethod(
  call: CallExpression,
  source: ParameterSource,
  receiver: Expression,
  method: string,
): boolean {
  let statement: Node = call;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  if (!isStatement(statement)) return false;
  const statements = statement.parent.statements;
  const previous = statements[statements.indexOf(statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const target = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) ||
    frameMemberName(target) !== method ||
    !sourceArrayFunction(assignment.right)
  )
    return false;
  const name = unwrapped(target.expression);
  const selected = isIdentifier(name) ? parameterSource(name) : undefined;
  if (selected?.construction !== source.construction || !isIdentifier(name)) return false;
  const bindings = new Set([...source.bindings, ...selected.bindings]);
  return !exposedBefore({ call, receiver, target: name, bindings });
}

interface OwnContext {
  readonly formReader?: boolean;
  /** A reader whose proof an exposure drops passes false, to count only a loop body's uses. */
  readonly reached?: boolean;
  readonly call: CallExpression;
  readonly receiver: Expression;
  readonly target: Identifier;
  readonly bindings: ReadonlySet<FrameBinding>;
}

/** Prior receiver uses or possible other-owner reads may install accessors or change method identity. */
function exposedBefore(context: OwnContext): boolean {
  const pending: Node[] = [context.call.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (isIdentifier(at) && exposedRead(at, context)) return true;
    at.forEachChild((each) => {
      pending.push(each);
    });
  }
  return false;
}

/** Declarations, whole aliases and this selected write/read preserve the fresh receiver identity. */
function exposedRead(name: Identifier, context: OwnContext): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || !context.bindings.has(selected.binding)) return false;
  if (
    name === selected.binding.name ||
    name === context.target ||
    name === unwrapped(context.receiver)
  )
    return false;
  const owner = executionOwner(context.call);
  if (executionOwner(name) !== owner) return true;
  if (
    (name.pos > context.call.end || destructuredFirst(context.call, name)) &&
    !reachedLoopRead(context.reached !== false)(name, context.call, selected.binding, owner)
  )
    return false;
  if (context.formReader === true && quietFormPrefix(name)) return false;
  const { parent, at } = useOf(name);
  return !(
    isExpression(at) &&
    isVariableDeclaration(parent) &&
    parent.initializer === at &&
    isIdentifier(parent.name) &&
    context.bindings.has(parent)
  );
}

/** Native append/set/delete of literal primitive inputs cannot replace a fresh form's reader methods. */
function quietFormPrefix(name: Identifier): boolean {
  const { parent, at } = useOf(name);
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at
  )
    return false;
  const method = frameMemberName(parent);
  const call = parent.parent;
  if (
    method === undefined ||
    !METHODS.has(method) ||
    !isCallExpression(call) ||
    call.expression !== parent ||
    (isElementAccessExpression(parent) && !framedQuietPrimitive(parent.argumentExpression))
  )
    return false;
  const count = method === 'delete' ? 1 : 2;
  return (
    call.arguments.length === count && call.arguments.every((value) => framedQuietPrimitive(value))
  );
}
