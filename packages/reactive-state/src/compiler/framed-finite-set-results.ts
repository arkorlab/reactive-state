import {
  type CallExpression,
  type Expression,
  type Identifier,
  type NewExpression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isOmittedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { iteratorPrefixQuiet, iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { finiteSetPositions } from './framed-set-positions.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Quiet fresh native Set construction and add chains retain finite yielded source elements. */

const SETS = new Set(['Set']);
const ADDERS = new Set(['Set.prototype.add']);
const TAIL = { reflect: 3 } as const;

type Invocation = CallExpression | NewExpression;

interface FiniteSetRead {
  readonly capture: Invocation;
  readonly consumer: Expression;
  readonly index: number;
}

interface SetSource {
  readonly construction: NewExpression;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly added: readonly (Expression | undefined)[];
  readonly roots: readonly Expression[];
}

interface AddSource {
  readonly receiver: Expression;
  readonly args: readonly Expression[];
}

/** Only immediately consumed results add origins; saved result aliases retain their old opacity. */
export function finiteSetSelection(
  expression: Expression,
  read: FiniteSetRead,
): { readonly values: readonly Expression[]; readonly roots: readonly Expression[] } | undefined {
  if (!immediateSetMember(read.consumer)) return undefined;
  const source = setSource(expression, read.capture);
  if (
    source === undefined ||
    !framedOriginPrefix(source.construction) ||
    argumentArrayExposed(expression, source.bindings, undefined, false)
  )
    return undefined;
  const args = argumentsOf(source.construction, source.construction.arguments ?? []);
  if (args === undefined || !quietSetValues(args.slice(1))) return undefined;
  const input = args[0];
  const initial = initialValues(input, read.capture);
  if (initial === undefined) return undefined;
  const values = finiteSetPositions([...initial, ...source.added], read.index, read.capture);
  if (values === undefined) return undefined;
  if (values.some((value) => !framedOriginCoowned(value, read.capture))) return undefined;
  const roots = [...args, ...initial, ...source.roots];
  return { values, roots };
}

/** A direct source-written member consumes its value without an intervening saved-result mutation. */
function immediateSetMember(value: Expression): boolean {
  const { at, parent } = useOf(value);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}

/** Whole const aliases and native add links keep their original construction and insertion order. */
function setSource(expression: Expression, read: Invocation): SetSource | undefined {
  let value = framedQuietOperand(expression);
  const bindings = new Set<FrameBinding>();
  const added: (Expression | undefined)[] = [];
  const roots: Expression[] = [];
  const seen = new Set<Expression>();
  const outer = value;
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (isIdentifier(value)) {
      const next = constantValue(value, bindings);
      if (next === undefined) return undefined;
      value = next;
      continue;
    }
    if (!isCallExpression(value)) break;
    const add = addedSource(value);
    if (add === undefined || !quietSetValues(add.args)) return undefined;
    added.unshift(add.args[0]);
    roots.push(...add.args);
    value = unwrapped(add.receiver);
  }
  if (
    !isNewExpression(value) ||
    !framedNativeConstructor(value.expression, SETS) ||
    executionOwner(value) !== executionOwner(read) ||
    !iteratorPrefixQuiet(value, outer) ||
    !iteratorPrefixQuiet(outer, read)
  )
    return undefined;
  return { construction: value, bindings, added, roots };
}

/** Only immutable whole bindings preserve one written Set or literal input source. */
function constantValue(name: Identifier, bindings: Set<FrameBinding>): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    bindings.has(binding) ||
    !isVariableDeclaration(binding) ||
    !isIdentifier(binding.name) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return undefined;
  bindings.add(binding);
  return framedQuietOperand(binding.initializer);
}

/** The native Set constructor consumes a finite unchanged literal array, including materialized holes. */
function initialValues(
  input: Expression | undefined,
  read: Invocation,
): readonly Expression[] | undefined {
  if (input === undefined) return [];
  const key = framedMapKey(input);
  if (key === 'null' || key === 'undefined') return [];
  let value = framedQuietOperand(input);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const next = constantValue(value, bindings);
    if (next === undefined) return undefined;
    value = next;
  }
  if (!isArrayLiteralExpression(value) || argumentArrayExposed(input, bindings, undefined, false))
    return undefined;
  const values = argumentsOf(read, value.elements);
  return values !== undefined && quietSetValues(values) ? values : undefined;
}

/** Native borrowing preserves the actual add receiver and all evaluated ignored wrapper tails. */
function addedSource(call: CallExpression): AddSource | undefined {
  const callee = unwrapped(call.expression);
  const native = framedNativeArguments(call, ADDERS);
  if (native === undefined) return directAdd(call, callee);
  if (native.constructed || native.args === undefined) return undefined;
  const consumed = argumentsOf(call, native.args);
  const original = argumentsOf(call, call.arguments);
  if (consumed === undefined || original === undefined) return undefined;
  const reflect = globalPathOf(callee)?.join('.') === 'Reflect.apply';
  const receiver = original[reflect ? 1 : 0];
  if (receiver === undefined) return undefined;
  const apply = !reflect && frameMemberName(callee) === 'apply';
  const offset = apply ? 2 : 1;
  return { receiver, args: [...consumed, ...original.slice(reflect ? TAIL.reflect : offset)] };
}

/** Direct add requires the native member spelling rather than an effectful computed key. */
function directAdd(call: CallExpression, callee: Expression): AddSource | undefined {
  if (
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) ||
    frameMemberName(callee) !== 'add'
  )
    return undefined;
  if (isElementAccessExpression(callee) && framedMapKey(callee.argumentExpression) !== 'text:add')
    return undefined;
  const args = argumentsOf(call, call.arguments);
  return args === undefined ? undefined : { receiver: callee.expression, args };
}

/** Quiet native Error construction adds no options getter or message-conversion work. */
function quietSetValues(values: readonly Expression[]): boolean {
  return values.every((given) => {
    const value = unwrapped(given);
    if (isOmittedExpression(value) || iteratorQuietValues([value])) return true;
    if (!isNewExpression(value) || !framedNativeConstructor(value.expression, STANDARD_ERRORS))
      return false;
    const args = value.arguments ?? [];
    if (args.length === 0) return true;
    if (args.length !== 1 || args[0] === undefined) return false;
    const message = unwrapped(args[0]);
    return isStringLiteral(message) || isNoSubstitutionTemplateLiteral(message);
  });
}

/** Unknown argument spreads keep the established opaque boundary. */
function argumentsOf(
  call: Invocation,
  args: readonly Expression[],
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, args, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}
