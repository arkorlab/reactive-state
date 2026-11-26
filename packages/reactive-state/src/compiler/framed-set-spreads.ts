import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type SpreadElement,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedIterationInstalled } from './framed-collection-prototypes.ts';
import { immediateSelection } from './framed-copy-guards.ts';
import { framedDeclaredAdmitted } from './framed-declared-collections.ts';
import { finiteSetSelection } from './framed-finite-set-results.ts';
import { framedIterationWritten } from './framed-iteration-writes.ts';
import { DEFAULT_ITERATOR, iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedAliasBindings, framedReplacedIteration } from './framed-own-iterations.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedUnreadInput } from './framed-unread-inputs.ts';

/** A native Set spread into an array literal yields its finite source values in insertion order. */

const SETS = new Set(['Set']);

interface SetSpread {
  readonly spread: SpreadElement;
  readonly array: ArrayLiteralExpression;
  readonly position: number | undefined;
  readonly keys: readonly string[];
}

/**
 * The values a fresh native Set spread supplies at a known result position of an immediately
 * selected array literal whose other elements are quiet; none before the spread's offset. A Set
 * given an input the compile cannot read may hold an Error at any position, known or not
 * (`unreadViews`).
 */
export function setSpreadViews(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  position: number | undefined,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const construction = setConstruction(spread.expression);
  if (construction === undefined) return undefined;
  const at = { spread, array, position, keys };
  return (
    replacedViews(at) ??
    rewrittenViews(at, construction) ??
    writtenViews(at, construction) ??
    unreadViews(construction, spread, keys)
  );
}

/**
 * What the spread yields where the statement right before it replaces the default iterator on a
 * name the Set is read through, as the replacement reads (`framedReplacedIteration`).
 */
function replacedViews(at: SetSpread): readonly ArrayElementView[] | undefined {
  const { spread, array, position, keys } = at;
  const bindings = framedAliasBindings(spread.expression);
  if (bindings.size === 0) return undefined;
  const offset = array.elements.indexOf(spread);
  const shifted = array.elements.slice(0, offset).some((each) => isSpreadElement(each));
  const index = position === undefined || shifted ? undefined : position - offset;
  return framedReplacedIteration(bindings, DEFAULT_ITERATOR, spread, { index, keys });
}

/**
 * A native Set whose iteration something may replace before the spread, on it
 * (`framedIterationWritten`) or on its prototype (`framedIterationInstalled`), yields what may be
 * an Error where its declared element type admits one at the read keys (`elementAdmitted`),
 * beside what its native values may yield, which a replacement never takes away.
 */
function rewrittenViews(
  at: SetSpread,
  construction: NewExpression,
): readonly ArrayElementView[] | undefined {
  const { spread, keys } = at;
  if (
    !framedNativeConstructor(construction.expression, SETS) ||
    !(
      framedIterationWritten(framedAliasBindings(spread.expression), spread) ||
      framedIterationInstalled(spread.getSourceFile(), 'Set')
    )
  )
    return undefined;
  // The native values stay possible: what a replacement may yield only adds to them.
  const native = writtenViews(at, construction) ?? unreadViews(construction, spread, keys) ?? [];
  return elementAdmitted(construction, spread.expression, keys)
    ? [...native, { value: spread.expression, index: undefined, element: true, keys, unread: true }]
    : native;
}

/**
 * A native Set given an input the compile cannot read (`framedUnreadInput`) yields what may be an
 * Error where its declared element type admits one at the read keys (`elementAdmitted`).
 */
function unreadViews(
  construction: NewExpression,
  spread: SpreadElement,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const input = construction.arguments?.[0];
  return input !== undefined &&
    framedNativeConstructor(construction.expression, SETS) &&
    framedUnreadInput(input) &&
    elementAdmitted(construction, spread.expression, keys)
    ? [{ value: spread.expression, index: undefined, element: true, keys, unread: true }]
    : undefined;
}

/** The values a Set made of written values in the reader's owner supplies at the position. */
function writtenViews(
  at: SetSpread,
  construction: NewExpression,
): readonly ArrayElementView[] | undefined {
  const { spread, array, position, keys } = at;
  const offset = array.elements.indexOf(spread);
  const others = array.elements.filter((each) => each !== spread && !isOmittedExpression(each));
  if (
    position === undefined ||
    offset === -1 ||
    others.some((each) => isSpreadElement(each)) ||
    !iteratorQuietValues(others) ||
    !immediateSelection(array)
  )
    return undefined;
  if (position < offset) return [];
  if (executionOwner(construction) !== executionOwner(array)) return undefined;
  const selected = finiteSetSelection(spread.expression, {
    capture: construction,
    consumer: array,
    index: position - offset,
  });
  return selected !== undefined &&
    setCarriedUnexposed(
      selected.roots,
      selected.values.map((value) => ({ value })),
      array,
    )
    ? selected.values.map((value) => ({ value, index: undefined, element: true, keys }))
    : undefined;
}

/**
 * Whether a Set's declared element type admits an Error at the read keys
 * (`framedDeclaredAdmitted`): the construction's own argument, else the annotation of the name the
 * spread reads it through, past local aliases.
 */
function elementAdmitted(
  construction: NewExpression,
  read: Expression,
  keys: readonly string[],
): boolean {
  return framedDeclaredAdmitted(
    { written: construction.typeArguments, annotation: setAnnotation(read) },
    'Set',
    0,
    keys,
  );
}

/**
 * The construction a whole const alias or a direct add chain holds, read past quiet commas; the
 * full proof checks each step. A binding that may change, as a `let` or a parameter's default
 * may, holds none: its initializer need not be what the spread reads.
 */
/**
 * The annotation of a name a Set is read through: the nearest along the whole const aliases and
 * the direct add chain `setConstruction` follows, as an unannotated alias holds the annotated
 * name's Set.
 */
function setAnnotation(expression: Expression): TypeNode | undefined {
  let value = framedQuietOperand(expression);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isIdentifier(value)) {
      const annotation = frameBindingOf(value)?.binding.type;
      if (annotation !== undefined) return annotation;
      const initializer = constantInitializer(value);
      if (initializer === undefined) return undefined;
      value = framedQuietOperand(initializer);
      continue;
    }
    const receiver = addReceiver(value);
    if (receiver === undefined) return undefined;
    value = receiver;
  }
  return undefined;
}

/** The receiver of a direct `add` call, `set.add(value)`; none of anything else. */
function addReceiver(value: Expression): Expression | undefined {
  if (!isCallExpression(value)) return undefined;
  const callee = unwrapped(value.expression);
  return (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    frameMemberName(callee) === 'add'
    ? unwrapped(callee.expression)
    : undefined;
}

function setConstruction(expression: Expression): NewExpression | undefined {
  let value = framedQuietOperand(expression);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isNewExpression(value)) return value;
    if (isIdentifier(value)) {
      const initializer = constantInitializer(value);
      if (initializer === undefined) return undefined;
      value = framedQuietOperand(initializer);
      continue;
    }
    const receiver = addReceiver(value);
    if (receiver === undefined) return undefined;
    value = receiver;
  }
  return undefined;
}

/** What a whole `const` binding a name reads is initialized with: what it holds unchanged. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  return binding !== undefined &&
    selected?.keys.length === 0 &&
    isVariableDeclaration(binding) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}
