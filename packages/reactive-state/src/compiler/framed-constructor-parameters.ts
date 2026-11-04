import {
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isTypeOfExpression,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  type FrameBinding,
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
} from './framed-bindings.ts';
import { framedConstructorDefaultEvaluation } from './framed-constructor-default-evaluation.ts';
import { framedDefaultTaken } from './framed-constructor-defaults.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';

/** What a constructor's `super` arguments read of its parameters, by a construction's arguments. */

/**
 * A value a constructor slot may hold: an expression read along a member path, or, where a key on
 * the way is one the compile cannot read, any member it holds there.
 */
export interface ForwardedValue {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly any?: boolean;
  readonly continued?: boolean;
}

/** The values each argument position may hold. */
export type Slots = readonly (readonly ForwardedValue[])[];

/** What a parameter read was given, and the defaults it may take instead. */
interface DefaultValue extends ForwardedValue {
  readonly selected: boolean;
}

/** The inputs and defaults for one parameter read. */
interface ParameterRead {
  readonly values: readonly ForwardedValue[];
  readonly defaults: readonly DefaultValue[];
}

/** The member path a read selects, and whether a key after it is one the compile cannot read. */
interface ReadPath {
  readonly keys: readonly string[];
  readonly any: boolean;
}

/** Expressions that pass on the value they wrap. */
const WRAPPERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** Strict equality never converts either operand to native Error words. */
const STRICT_COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Loose equality avoids operand conversion only for a shown nullish counterpart. */
const NULLISH_COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * A written `super` argument, what the parameters it reads were given, and the defaults they may
 * take instead, whose own parameter reads count whole. `undefined` where `arguments` or a pattern
 * the compile cannot follow hides which argument a read takes.
 */
export function framedSlotValues(
  argument: Expression,
  parameters: readonly ParameterDeclaration[],
  slots: Slots,
  evaluated: readonly Expression[] = [argument],
): readonly ForwardedValue[] | undefined {
  const values: ForwardedValue[] = [];
  const scanned = new Set<string>();
  const pending: DefaultValue[] = [
    {
      keys: [],
      value: argument,
      selected: framedConstructorDefaultEvaluation(parameters, slots, evaluated),
    },
  ];
  for (let scan = pending.pop(); scan !== undefined; scan = pending.pop()) {
    const seen = JSON.stringify([
      scan.value.pos,
      scan.keys,
      scan.any === true,
      scan.selected,
      scan.continued === true,
    ]);
    if (scanned.has(seen)) continue;
    scanned.add(seen);
    values.push(scan);
    const reads = parameterReads(scan, parameters, slots);
    if (reads === undefined) return undefined;
    values.push(...reads.values);
    pending.push(...reads.defaults);
  }
  return values;
}

/** The position of the rest parameter a spread passes on whole. */
export function framedRestIndex(
  expression: Expression,
  parameters: readonly ParameterDeclaration[],
): number | undefined {
  const value = unwrapped(expression);
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  const index = parameterIndex(selected?.binding, parameters);
  const parameter = parameters[index];
  return parameter?.dotDotDotToken !== undefined && selected?.keys.length === 0 ? index : undefined;
}

/** What the parameters an expression reads were given, and the defaults they may take instead. */
function parameterReads(
  root: DefaultValue,
  parameters: readonly ParameterDeclaration[],
  slots: Slots,
): ParameterRead | undefined {
  const values: ForwardedValue[] = [];
  const defaults: DefaultValue[] = [];
  const source = forwardedRoot(root.value);
  const pending: Node[] = [root.value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    // A bare typeof operand is inspected without copying its words into the native argument.
    if (isTypeOfExpression(node) && isIdentifier(unwrapped(node.expression))) continue;
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (!isIdentifier(node) || !readsBinding(node) || noncoercingComparison(node)) continue;
    const read = parameterValues(node, parameters, slots);
    if (read === undefined) return undefined;
    if (node === source && root.selected) {
      values.push(...read.values.map((each) => continuedValue(each, root)));
      defaults.push(
        ...read.defaults.map((each) => {
          return {
            ...continuedValue(each, root),
            selected: each.selected,
          };
        }),
      );
    } else {
      values.push(...read.values);
      defaults.push(
        ...read.defaults.map((each) => ({ ...each, selected: root.selected && each.selected })),
      );
    }
  }
  return { defaults, values };
}

/** Bare noncoercing comparison operands supply only their boolean result to the message. */
function noncoercingComparison(name: Identifier): boolean {
  let at: Node = name;
  while (WRAPPERS.has(at.parent.kind)) at = at.parent;
  const parent = at.parent;
  if (!isBinaryExpression(parent)) return false;
  const kind = parent.operatorToken.kind;
  if (STRICT_COMPARISONS.has(kind)) return true;
  if (!NULLISH_COMPARISONS.has(kind)) return false;
  const other = unwrapped(parent.left === at ? parent.right : parent.left);
  return (
    other.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(other) ||
    (isIdentifier(other) && other.text === 'undefined' && frameDeclarationOf(other) === undefined)
  );
}

/**
 * What a parameter a `super` argument reads was given, along the member path the read selects: its
 * argument, a rest position or the whole rest; and the defaults the parameter or a binding element
 * on the way to the name takes where that is `undefined`, each with the rest of the path.
 */
function parameterValues(
  name: Identifier,
  parameters: readonly ParameterDeclaration[],
  slots: Slots,
): ParameterRead | undefined {
  const selected = frameBindingOf(name);
  const index = parameterIndex(selected?.binding, parameters);
  const parameter = parameters[index];
  if (selected === undefined || parameter === undefined) return restRead(name, parameters, slots);
  const path = readPath(name);
  const keys = [...selected.keys, ...path.keys];
  if (parameter.dotDotDotToken !== undefined)
    return { defaults: [], values: restValues(slots.slice(index), keys) };
  const given = slots[index] ?? [];
  const declared = bindingIdentifiers(parameter.name).find((each) => each.text === name.text);
  const takesDefault = framedDefaultTaken(given);
  const effective =
    takesDefault && parameter.initializer !== undefined
      ? [{ keys: [], value: parameter.initializer }]
      : given;
  const defaults =
    declared === undefined ? [] : elementDefaults(declared, selected.keys, path, effective);
  if (parameter.initializer !== undefined)
    defaults.push({ any: path.any, keys, value: parameter.initializer, selected: takesDefault });
  return { defaults, values: given.map((each) => selectedValue(each, keys, path.any)) };
}

/**
 * A name a rest element of a parameter's pattern binds: an object rest keeps the member names it
 * copies, an array rest's written index counts from its own position, and another read may be any
 * member of what the pattern destructures. `undefined` where the pattern cannot be followed.
 */
function restRead(
  name: Identifier,
  parameters: readonly ParameterDeclaration[],
  slots: Slots,
): ParameterRead | undefined {
  const declared = frameDeclarationOf(name);
  const index = parameterIndex(declared, parameters);
  const parameter = parameters[index];
  if (parameter === undefined)
    return name.text === 'arguments' ? undefined : { defaults: [], values: [] };
  const element = bindingIdentifiers(parameter.name).find((each) => each.text === name.text);
  const rest = element?.parent;
  if (rest === undefined || !isBindingElement(rest) || rest.dotDotDotToken === undefined)
    return undefined;
  const pattern = rest.parent;
  const outer = patternPath(pattern);
  if (outer === undefined || parameter.dotDotDotToken !== undefined) return undefined;
  const path = readPath(name);
  const selection = isArrayBindingPattern(pattern)
    ? arrayRestPath(pattern.elements.indexOf(rest), path)
    : path;
  const keys = [...outer, ...selection.keys];
  const given = slots[index] ?? [];
  const defaults =
    parameter.initializer === undefined
      ? []
      : [{ any: true, keys: outer, value: parameter.initializer, selected: false }];
  return { defaults, values: given.map((each) => selectedValue(each, keys, selection.any)) };
}

/** An array rest's written index, counted from the rest's position; another read, any element. */
function arrayRestPath(offset: number, path: ReadPath): ReadPath {
  const [first, ...remaining] = path.keys;
  const position = first === undefined ? undefined : restPosition(first);
  return position === undefined
    ? { any: true, keys: [] }
    : { any: path.any, keys: [String(offset + position), ...remaining] };
}

/** The keys from a parameter to a pattern inside it; `undefined` through a rest or an unread key. */
function patternPath(pattern: Node): readonly string[] | undefined {
  const keys: string[] = [];
  let at = pattern.parent;
  while (isBindingElement(at)) {
    if (at.dotDotDotToken !== undefined) return undefined;
    const owner = at.parent;
    const key = isArrayBindingPattern(owner)
      ? String(owner.elements.indexOf(at))
      : frameMemberName(at);
    if (key === undefined) return undefined;
    keys.unshift(key);
    at = owner.parent;
  }
  return isParameterDeclaration(at) ? keys : undefined;
}

/** The defaults of the binding elements from a destructured name's declaration up to its parameter. */
function elementDefaults(
  name: Identifier,
  keys: readonly string[],
  path: ReadPath,
  given: readonly ForwardedValue[],
): DefaultValue[] {
  const defaults: DefaultValue[] = [];
  let depth = keys.length;
  for (let at: Node = name.parent; isBindingElement(at); at = at.parent.parent) {
    if (at.initializer !== undefined)
      defaults.push({
        any: path.any,
        keys: [...keys.slice(depth), ...path.keys],
        value: at.initializer,
        selected: framedDefaultTaken(given, keys.slice(0, depth)),
      });
    depth -= 1;
  }
  return defaults;
}

/**
 * The written member path a read of a name selects, `options.message` or `list[0]`, through
 * parentheses and assertions; a method it calls reads the receiver whole, and a key the compile
 * cannot read leaves any member possible after the path.
 */
function readPath(name: Identifier): ReadPath {
  const keys: string[] = [];
  let at: Node = name;
  for (;;) {
    let { parent } = at;
    while (WRAPPERS.has(parent.kind)) {
      at = parent;
      parent = parent.parent;
    }
    if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent))
      return { any: false, keys };
    if (parent.expression !== at) return { any: false, keys };
    if (isCallExpression(parent.parent) && parent.parent.expression === parent)
      return { any: false, keys };
    const key = frameMemberName(parent);
    if (key === undefined) return { any: true, keys };
    keys.push(key);
    at = parent;
  }
}

/** The rest positions a read selects: one by a written index, otherwise every position whole. */
function restValues(rest: Slots, keys: readonly string[]): readonly ForwardedValue[] {
  const [first, ...remaining] = keys;
  const position = first === undefined ? undefined : restPosition(first);
  if (position === undefined) return rest.flat();
  const given = rest[position] ?? [];
  return given.map((each) => selectedValue(each, remaining, false));
}

/** A canonical array index, as a written key spells it. */
function restPosition(key: string): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? index : undefined;
}

/**
 * A given value, read further along the member path a destructured parameter selects; one already
 * read up to an unread key keeps its own path, any member there standing for the rest.
 */
function selectedValue(
  given: ForwardedValue,
  keys: readonly string[],
  any: boolean,
): ForwardedValue {
  if (given.any === true) return given;
  return { ...given, any, keys: [...given.keys, ...keys] };
}

/** The position of the constructor parameter a binding is, or -1 for any other binding. */
function parameterIndex(
  binding: FrameBinding | FrameDeclaration | undefined,
  parameters: readonly ParameterDeclaration[],
): number {
  return binding !== undefined && isParameterDeclaration(binding)
    ? parameters.indexOf(binding)
    : -1;
}

type FrameDeclaration = NonNullable<ReturnType<typeof frameDeclarationOf>>;

/** The one original binding whose value a default passes through a selected member chain. */
function forwardedRoot(expression: Expression): Identifier | undefined {
  let value = unwrapped(expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value))
    value = unwrapped(value.expression);
  return isIdentifier(value) ? value : undefined;
}

/** Only newly substituted remaining paths need the added native conversion-input boundary. */
function continuedValue(value: ForwardedValue, root: DefaultValue): ForwardedValue {
  return {
    ...selectedValue(value, root.keys, root.any === true),
    continued:
      value.continued === true ||
      root.continued === true ||
      root.keys.length > 0 ||
      root.any === true,
  };
}
