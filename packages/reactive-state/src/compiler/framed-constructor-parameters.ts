import {
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
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
  /** Whether the default is the value in use: the argument it stands for is left `undefined`. */
  readonly selected: boolean;
}

/** A default, and the defaults the reads that led to it passed through, outermost first. */
interface EnteredValue extends DefaultValue {
  readonly entered: readonly string[];
}

/** The inputs and defaults of the parameter reads of an expression. */
interface Reads {
  readonly values: readonly ForwardedValue[];
  readonly defaults: readonly DefaultValue[];
}

/**
 * The inputs and defaults for one parameter read, and `whole`: what the member the read selects is
 * a member of, each given value read up to the key before the last, or up to the keys read where a
 * later one is not.
 */
interface ParameterRead extends Reads {
  readonly whole: readonly ForwardedValue[];
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
 * the compile cannot follow hides which argument a read takes. The member path a read selects is
 * followed through each default the construction leaves taken, whatever else the constructor's
 * code holds: a call, an operator or a member read there does not show that the path selects
 * nothing the native base converts. What a default selects the path of is forwarded whole beside
 * it, for the path may stop at a value the compile cannot read into, and so is what a read of a
 * parameter selects a member of, up to the key before the last (`receivers`): the `message` of an
 * `Error` the construction gives is the words each engine writes, as a direct read of it is.
 *
 * Defaults that read one another in a circle (`a = b.x, b = a.y`, a read of a parameter before it
 * is initialized, which throws where it runs) make a path that grows without end where each
 * default is taken: a taken default entered again, in a state not scanned yet, is such a circle,
 * and the program is read as one the compile cannot follow, so `undefined`, which keeps every
 * argument possible. A circle that adds no key, or of defaults the construction replaces (which
 * drop the path), meets a state it scanned and ends of itself.
 */
export function framedSlotValues(
  argument: Expression,
  parameters: readonly ParameterDeclaration[],
  slots: Slots,
): readonly ForwardedValue[] | undefined {
  const values: ForwardedValue[] = [];
  const scanned = new Set<string>();
  const pending: EnteredValue[] = [{ entered: [], keys: [], value: argument, selected: true }];
  for (let scan = pending.pop(); scan !== undefined; scan = pending.pop()) {
    const seen = scanState(scan);
    if (scanned.has(seen)) continue;
    scanned.add(seen);
    values.push(scan);
    const reads = parameterReads(scan, parameters, slots);
    if (reads === undefined) return undefined;
    values.push(...reads.values);
    for (const each of reads.defaults) {
      const at = `${each.value.pos}:${each.value.end}`;
      if (each.selected && scan.entered.includes(at) && !scanned.has(scanState(each)))
        return undefined;
      pending.push({ ...each, entered: [...scan.entered, at] });
    }
  }
  return values;
}

/** What a scan of a default stands for: the same state is scanned once. */
function scanState(scan: DefaultValue): string {
  return JSON.stringify([
    scan.value.pos,
    scan.keys,
    scan.any === true,
    scan.selected,
    scan.continued === true,
  ]);
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
): Reads | undefined {
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
    values.push(...read.whole);
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
      // The path may stop at a value the compile cannot read into, an Error's own `message`, or
      // meet a member another default writes: what the default selects it of stays whole too.
      if (root.keys.length > 0 || root.any === true) {
        values.push(...read.values);
        defaults.push(...read.defaults.map((each) => ({ ...each, selected: false })));
      }
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
  const declared = bindingIdentifiers(parameter.name).find((each) => each.text === name.text);
  if (parameter.dotDotDotToken !== undefined) {
    const rest = slots.slice(index);
    return {
      defaults: declared === undefined ? [] : restDefaults(declared),
      values: restValues(rest, keys, path.any),
      whole: restReceivers(rest, keys, path.any),
    };
  }
  const given = slots[index] ?? [];
  const takesDefault = framedDefaultTaken(given);
  const effective =
    takesDefault && parameter.initializer !== undefined
      ? [{ keys: [], value: parameter.initializer }]
      : given;
  const defaults =
    declared === undefined ? [] : elementDefaults(declared, selected.keys, path, effective);
  if (parameter.initializer !== undefined)
    defaults.push({ any: path.any, keys, value: parameter.initializer, selected: takesDefault });
  return {
    defaults,
    values: given.map((each) => selectedValue(each, keys, path.any)),
    whole: receivers(given, keys, path.any),
  };
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
    return name.text === 'arguments' ? undefined : { defaults: [], values: [], whole: [] };
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
  return {
    defaults,
    values: given.map((each) => selectedValue(each, keys, selection.any)),
    whole: receivers(given, keys, selection.any),
  };
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
 * The defaults of the binding elements from a name in a rest parameter's pattern up to the
 * parameter: whether the rest holds an argument where the name stands is not told, so each default
 * may be taken, and any member of it may be what the name holds.
 */
function restDefaults(name: Identifier): DefaultValue[] {
  const defaults: DefaultValue[] = [];
  for (let at: Node = name.parent; isBindingElement(at); at = at.parent.parent) {
    if (at.initializer !== undefined)
      defaults.push({ any: true, keys: [], value: at.initializer, selected: false });
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

/**
 * The rest positions a read selects: one by a written index, otherwise every position whole — and
 * any member after the path where a key on it is one the compile cannot read (`any`).
 */
function restValues(rest: Slots, keys: readonly string[], any: boolean): readonly ForwardedValue[] {
  const [first, ...remaining] = keys;
  const position = first === undefined ? undefined : restPosition(first);
  if (position === undefined) return rest.flat().map((each) => selectedValue(each, [], any));
  const given = rest[position] ?? [];
  return given.map((each) => selectedValue(each, remaining, any));
}

/**
 * What a read selects a member of: each given value read up to the key before the last, or up to
 * the keys read where a later one is not. A member of a value the compile cannot read into, an
 * `Error`'s own `message`, is the words each engine writes, which the path alone does not show. A
 * literal read by one key is read into by the path, which resolves the member it holds.
 */
function receivers(
  given: readonly ForwardedValue[],
  keys: readonly string[],
  any: boolean,
): readonly ForwardedValue[] {
  if (!any && keys.length === 0) return [];
  const read = any ? keys : keys.slice(0, -1);
  return given
    .filter((each) => any || keys.length > 1 || each.keys.length > 0 || !isLiteral(each.value))
    .map((each) => selectedValue(each, read, false));
}

/** What a read of a rest parameter selects a member of: the argument at a position, as `receivers`. */
function restReceivers(
  rest: Slots,
  keys: readonly string[],
  any: boolean,
): readonly ForwardedValue[] {
  if (keys.length < 2 && !(any && keys.length === 1)) return [];
  return restValues(rest, any ? keys : keys.slice(0, -1), false).filter(
    (each) => any || keys.length > 2 || each.keys.length > 0 || !isLiteral(each.value),
  );
}

/** An object or an array written as a literal, which a path of one key is resolved in. */
function isLiteral(value: Expression): boolean {
  const written = unwrapped(value);
  return isObjectLiteralExpression(written) || isArrayLiteralExpression(written);
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
