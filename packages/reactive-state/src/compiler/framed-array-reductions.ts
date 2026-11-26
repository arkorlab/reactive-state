import {
  type CallExpression,
  type Expression,
  type ParameterDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isOmittedExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { selectedError } from './framed-array-selections.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { framedAtMethod } from './framed-at-methods.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedMemberAdmitted } from './framed-error-admission.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { quietMapperFunction } from './framed-mapper-quiet.ts';
import { mapperReplacementViews } from './framed-mapper-replacements.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedReductionAlias, framedReductionAliasesQuiet } from './framed-reduction-aliases.ts';
import { reductionDefaults } from './framed-reduction-defaults.ts';
import { framedSourceValues } from './framed-sources.ts';

/** Native reductions retain initial accumulators, uncalled sole elements and written callback results. */

interface Reduction {
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[];
  readonly borrowed: boolean;
  readonly expanded: boolean;
  /** An unresolved spread supplies the reducer or the initial value: neither can be read. */
  readonly unknown: boolean;
}

type ElementProof = Parameters<typeof selectedError>[2];

/** The native reduction's possible final accumulator, preserving own method implementations. */
export function framedArrayReduction(
  call: CallExpression,
  proof: ElementProof,
): boolean | undefined {
  const selected = reduction(call);
  if (selected === undefined) return undefined;
  const settled = settledReduction(selected, call);
  if (settled !== undefined) return settled.answer;
  const carried = reductionProof(selected, call, proof);
  if (carried === undefined) return undefined;
  const initial = selected.given[1];
  const positions = literalPositions(selected.receiver);
  const length = positions?.length;
  const first =
    selected.method === 'reduceRight' ? (positions?.at(-1) ?? -1) : (positions?.[0] ?? 0);
  const accumulator = () => {
    return initial === undefined
      ? selectedError(selected.receiver, first, carried, call)
      : carried.error(initial);
  };
  const omitted = initial === undefined ? 1 : 0;
  const count = length === undefined ? undefined : Math.max(0, length - omitted);
  if (count === 0) return accumulator();
  if (count === undefined && accumulator()) return true;
  const callback = selected.given[0];
  if (callback === undefined) return undefined;
  const fn = unwrapped(callback);
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  const parameters = runtimeParameters(fn);
  const aliases = framedReductionAliasesQuiet(fn, call, selected.receiver);
  return framedAtMethod(fn, (value) => {
    const outputs = callbackOutputs(value, aliases);
    const carries =
      returnsParameter(outputs, parameters[0]) && returnsParameter(outputs, parameters[1]);
    const defaulted = (candidate: Expression, incoming: readonly Expression[] | undefined) => {
      if (!isIdentifier(candidate)) return false;
      const declaration = frameBindingOf(candidate)?.binding;
      if (declaration === undefined || !isParameterDeclaration(declaration)) return false;
      const read = { call, receiver: selected.receiver, incoming };
      const replaced = mapperReplacementViews(
        candidate,
        declaration,
        { receiver: selected.receiver, capture: call },
        true,
      );
      return [...reductionDefaults(candidate, declaration, read), ...replaced].some((each) =>
        carried.error(each.value, each.keys),
      );
    };
    return callbackError(outputs, {
      parameter: (candidate) => {
        const declaration = isIdentifier(candidate) ? frameDeclarationOf(candidate) : undefined;
        if (declaration === undefined || !isParameterDeclaration(declaration)) return;
        if (declaration === parameters[0])
          return (
            accumulator() ||
            (carries && selectedError(selected.receiver, undefined, carried, call)) ||
            defaulted(candidate, incomingAccumulators(selected, first, outputs, fn))
          );
        if (declaration !== parameters[1]) return;
        const last =
          selected.method === 'reduceRight' ? (positions?.[0] ?? 0) : (positions?.at(-1) ?? -1);
        return (
          selectedError(selected.receiver, carries ? undefined : last, carried, call) ||
          defaulted(
            candidate,
            literalElements(selected.receiver)?.filter((each) => each !== undefined),
          )
        );
      },
      error: carried.error,
    });
  });
}

/**
 * What a reduction answers before the native's own reading: anything where the file may give the
 * array a method of that name of its own (`arrayMethodMayBeOverridden`), as it is then no native
 * reduction; or, where an unresolved spread supplies the reducer or the initial value, an Error the
 * declared result type, the call's type argument, admits. None where the native reads on.
 */
function settledReduction(
  selected: Reduction,
  call: CallExpression,
): { readonly answer: boolean | undefined } | undefined {
  if (!selected.borrowed && arrayMethodMayBeOverridden(call, selected.method))
    return { answer: true };
  if (!selected.unknown) return undefined;
  return { answer: framedMemberAdmitted(call.typeArguments?.[0], []) ? true : undefined };
}

/** TypeScript's leading this declaration consumes no runtime accumulator or current-value slot. */
function runtimeParameters(fn: {
  readonly parameters: readonly ParameterDeclaration[];
}): readonly ParameterDeclaration[] {
  const parameters = fn.parameters;
  const [first, ...rest] = parameters;
  return first !== undefined && isIdentifier(first.name) && first.name.text === 'this'
    ? rest
    : parameters;
}

/** Added spread origins retain original argument effects, callback work and selected input owners. */
function reductionProof(
  selected: Reduction,
  call: CallExpression,
  proof: ElementProof,
): ElementProof | undefined {
  if (!selected.expanded) return proof;
  const callback = selected.given[0];
  if (callback === undefined) return undefined;
  const fn = unwrapped(callback);
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  const evaluated = framedArgumentPrefix(call, call.arguments, Infinity, false);
  if (
    evaluated.unknown ||
    !framedOriginCoowned(selected.receiver, call) ||
    !quietMapperFunction(fn, call, selected.receiver, {
      direct: true,
      evaluated: evaluated.values,
    })
  )
    return undefined;
  return {
    ...proof,
    error: (value, keys) => framedOriginCoowned(value, call) && proof.error(value, keys),
  };
}

/**
 * The accumulators a reducer may receive: the initial value, or the first element without one,
 * and each returned value other than a parameter of the reducer.
 */
function incomingAccumulators(
  selected: Reduction,
  first: number,
  outputs: readonly Expression[],
  fn: { readonly parameters: readonly ParameterDeclaration[] },
): readonly Expression[] | undefined {
  const initial = selected.given[1];
  const start = initial ?? literalElements(selected.receiver)?.[first];
  if (start === undefined) return undefined;
  const returned = outputs.filter((each) => {
    const actual = unwrapped(each);
    const declared = isIdentifier(actual) ? frameBindingOf(actual)?.binding : undefined;
    return declared === undefined || fn.parameters.every((parameter) => parameter !== declared);
  });
  return [start, ...returned];
}

/** A written receiver's elements by position, which a reduction reads in turn, skipping holes. */
function literalElements(receiver: Expression): readonly (Expression | undefined)[] | undefined {
  const value = unwrapped(receiver);
  return isArrayLiteralExpression(value) && !value.elements.some((each) => isSpreadElement(each))
    ? value.elements.map((each) => (isOmittedExpression(each) ? undefined : each))
    : undefined;
}

/** Branch-valued callback expressions retain the original parameter bindings at each returned node. */
function callbackError(
  values: readonly Expression[],
  proof: {
    readonly parameter: (value: Expression) => boolean | undefined;
    readonly error: (value: Expression) => boolean;
  },
): boolean {
  return values.some((value) => {
    const parameter = proof.parameter(unwrapped(value));
    return parameter ?? proof.error(value);
  });
}

/** Existing branch selection retains the original returned nodes and stops lexical alias cycles. */
function callbackOutputs(value: Expression, aliases: boolean): readonly Expression[] {
  const pending = [value];
  const seen = new Set<Expression>();
  const values: Expression[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const actual = unwrapped(next);
    if (seen.has(actual)) continue;
    seen.add(actual);
    const alias = aliases ? framedReductionAlias(actual) : undefined;
    const sources = alias === undefined ? framedSourceValues(actual) : [alias];
    if (sources === undefined) values.push(next);
    else pending.push(...sources);
  }
  return values;
}

/** Only callbacks that may retain both accumulator and current can carry a middle element onward. */
function returnsParameter(
  values: readonly Expression[],
  parameter: ParameterDeclaration | undefined,
): boolean {
  if (parameter === undefined) return false;
  return values.some((value) => {
    const actual = unwrapped(value);
    const declared = isIdentifier(actual) ? frameDeclarationOf(actual) : undefined;
    return declared !== undefined && isParameterDeclaration(declared) && declared === parameter;
  });
}

/** Present literal positions determine uncalled accumulators and direction-aware callback endpoints. */
function literalPositions(receiver: Expression): readonly number[] | undefined {
  const value = unwrapped(receiver);
  if (!isArrayLiteralExpression(value) || value.elements.some((each) => isSpreadElement(each)))
    return undefined;
  return value.elements.flatMap((each, index) => (isOmittedExpression(each) ? [] : [index]));
}

/** Direct and borrowed native reductions retain only callback and initial accumulator positions. */
function reduction(call: CallExpression): Reduction | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.slice(0, -1).join('.') === 'Array.prototype') {
    const method = borrowed.path.at(-1) ?? '';
    if (method !== 'reduce' && method !== 'reduceRight') return undefined;
    const given =
      borrowed.applied === undefined
        ? borrowed.given
        : framedAppliedArguments(call, borrowed.applied);
    if (given === undefined) return undefined;
    const expanded = framedArgumentPrefix(call, given);
    if (expanded.alternatives !== undefined) return undefined;
    return {
      receiver: borrowed.receiver,
      method,
      given: expanded.values,
      borrowed: true,
      expanded: given.slice(0, 2).some((each) => isSpreadElement(each)),
      unknown: expanded.unknown,
    };
  }
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  if (method !== 'reduce' && method !== 'reduceRight') return undefined;
  const expanded = framedArgumentPrefix(call, call.arguments, 2, false);
  if (expanded.alternatives !== undefined) return undefined;
  return {
    receiver: member.expression,
    method,
    given: expanded.values,
    borrowed: false,
    expanded: call.arguments.slice(0, 2).some((each) => isSpreadElement(each)),
    unknown: expanded.unknown,
  };
}
