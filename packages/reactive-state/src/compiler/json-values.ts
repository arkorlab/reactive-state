import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isCallExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import {
  answeredParameters,
  type Answering,
  answersLater,
  defaultsOf,
  isAnswering,
  localsOf,
  overloadsOf,
  parameterNamed,
  returnedBy,
  standsIn,
} from './answers.ts';
import { firstLine, globalOf, unwrapped } from './bounded.ts';
import {
  componentScope,
  constantOf,
  importedOf,
  isServerFunction,
  moduleScope,
  patternCapturesNothing,
} from './component-values.ts';
import { coercedDateNumber } from './date-numbers.ts';
import { entriesNonJson, keysNonJson } from './entry-reads.ts';
import {
  isDeclaration,
  isModuleDeclaration,
  type MemberValue,
  memberPath,
  moduleValue,
} from './exported-values.ts';
import { baseOf } from './frozen.ts';
import { type Given, givenOf, type Through, throughOf } from './invocations.ts';
import { isIterator } from './iterators.ts';
import { conditionalNonJson, logicalNonJson } from './json-branches.ts';
import { knownCallNonJson } from './json-calls.ts';
import { partsNonJson } from './json-parts.ts';
import {
  ANSWERING,
  answersPresent,
  type CallScope,
  followedOf,
  holdsElement,
  holdsHoles,
  isChangedName,
  isFunctionValue,
  isMadeNonJson,
  isNonJsonName,
  type JsonReading,
  lacksElement,
  makesNonFinite,
  markChanged,
  reached,
  replacesWithin,
  whyNonJson,
} from './json-reading.ts';
import { nonJsonPart } from './json-types.ts';
import { type Calls, type Told, toldChanges } from './local-writes.ts';
import { heldNonJson, memberHeld } from './member-reads.ts';
import { constantNumber } from './numbers.ts';
import { changedParameters } from './parameter-json.ts';
import { replacedMember } from './parameter-members.ts';
import type { SideState } from './reads.ts';
import {
  type Held,
  heldBy,
  type HeldFunction,
  isPlatformMade,
  isTypedArray,
  isVoidingReceiver,
  ownsMethod,
} from './retained.ts';
import { callbackThrowsWithin, throwsAlways } from './throws-always.ts';
import { throwsWithin } from './throws.ts';
import { typeReading } from './type-names.ts';

/**
 * What no JSON holds, where the code shows it, of what the authority sends as JSON: a state's first
 * value (`checkJson`), what a site's element is given (`checkSiteValue`).
 */

/** The operators that answer no finite number of a zero on their right: `ratio / 0`, `count % 0`. */
const BY_ZERO: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PercentToken, SyntaxKind.SlashToken]);

/** The operators that make a number of what they are given: `+value`, `-value`. */
const SIGNS: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.MinusToken, SyntaxKind.PlusToken]);

/**
 * What of `node` no JSON holds where it stands — `undefined`, `NaN`, `Infinity`, what the code
 * computes of numbers alone that is not finite (`1 / 0`), what it divides by zero (`ratio / 0`), an
 * integer of `BigInt`, `void` of anything, a function, an object's method — though an entry may
 * hold `undefined` (`reading.entry`), or what throws as the code computes it, of what it writes
 * (`throwsWithin`): `new RegExp('[').test(text)`; none where the code shows nothing.
 */
function nonJsonOf(node: Expression, reading: JsonReading = {}): Node | undefined {
  const follow = followedOf(reading);
  const thrown =
    throwsWithin(node, follow) ??
    callbackThrowsWithin(node, follow, (callee) => reading.scope?.functionOf(callee, reading));
  if (thrown !== undefined) {
    return thrown;
  }
  // `+'x'` is a number the code computes, though `'x'` is text: read as written, then as reached —
  // of the constants it reads too, `+bad` of `const bad = 'x'`; a name alone, as what it holds.
  const written = isIdentifier(unwrapped(node))
    ? undefined
    : (constantNumber(node, follow) ?? coercedDateNumber(node, follow));
  if (written !== undefined) {
    return Number.isFinite(written) ? undefined : unwrapped(node);
  }
  const { at, value } = reached(node, reading);
  const held = constantNumber(value, follow) ?? coercedDateNumber(value, follow);
  if (held !== undefined) {
    return Number.isFinite(held) ? undefined : value;
  }
  return reachedNonJson(value, at);
}

/** Whether `node` holds what no JSON holds where it stands (`nonJsonOf`). */
function isNonJson(node: Expression, reading: JsonReading): boolean {
  return nonJsonOf(node, reading) !== undefined;
}

/** What of `value`, reached (`reached`), no JSON holds, as `nonJsonOf` reads it. */
function reachedNonJson(value: Expression, reading: JsonReading): Node | undefined {
  const entry = reading.entry === true;
  if (isNonJsonReference(value, reading)) {
    return value;
  }
  if (
    isFunctionValue(value) ||
    isMadeNonJson(value) ||
    value.kind === SyntaxKind.BigIntLiteral ||
    (!entry && isVoidExpression(value))
  ) {
    return value;
  }
  if (isConditionalExpression(value)) {
    return conditionalNonJson(value, reading, nonJsonOf);
  }
  if (isBinaryExpression(value) && ANSWERING.has(value.operatorToken.kind)) {
    return logicalNonJson(value, reading, nonJsonOf);
  }
  if (
    isBinaryExpression(value) &&
    BY_ZERO.has(value.operatorToken.kind) &&
    constantNumber(value.right, followedOf(reading)) === 0
  ) {
    return value;
  }
  // `+value`, `-value`: the number it makes of what it is given (`makesNonFinite`).
  if (isPrefixUnaryExpression(value) && SIGNS.has(value.operator)) {
    return makesNonFinite(value.operand, reading, isNonJson) ? value : undefined;
  }
  return partsNonJson(value, reading, nonJsonOf);
}

/**
 * Whether `value` reads, or calls, what no JSON holds, as `reading` tells it: a name, a member of an
 * import, a call of what answers a promise.
 */
function isNonJsonReference(value: Expression, reading: JsonReading): boolean {
  if (isIdentifier(value)) {
    // A constant the code changes since it declares it (`local-writes.ts`), told so when refused.
    if (isChangedName(value, reading)) {
      markChanged(value);
    }
    return isNonJsonName(value, reading);
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return (
      heldNonJson(memberHeld(value, reading), reading, isNonJson) ||
      reading.isNonJsonMember?.(value, reading.entry === true) === true
    );
  }
  return isCallExpression(value) && reading.isNonJsonCall?.(value, reading) === true;
}

/**
 * Refuses what no JSON holds where the code shows it — `NaN`, `Infinity`, what it divides by zero
 * (`ratio / 0`), a function — as what a site's element is given, a reactive component's props,
 * which are JSON: the page's first render would fail of it, and a view of it be refused. A constant
 * of the component's is read as what it holds; a prop may be `undefined`, which JSON leaves out.
 */
export function checkSiteValue(state: SideState, value: Expression): void {
  const found = nonJsonOf(value, { ...componentReading(state), entry: true });
  if (found !== undefined) {
    state.fail(
      `What a dynamic site's element is given is of \`${firstLine(found)}\` here, which ${whyNonJson(found)} — a reactive component is rendered with JSON props — so the page's first render would fail of it, and a view of it be refused. Give it a finite number, or \`null\`.`,
      value,
    );
  }
}

/**
 * Refuses what no JSON holds — `undefined`, `NaN`, a function, an object's method, arrays or
 * objects nested deeper than 64 — as what a state the authority starts is of, read through the
 * component's constants, as a site's element's values are.
 */
export function checkJson(state: SideState, input: Expression): void {
  const found = nonJsonOf(input, componentReading(state));
  if (found !== undefined) {
    state.fail(
      `A state the authority starts is of \`${firstLine(found)}\` here, which ${whyNonJson(found)}: the authority sends a state's first value to the browser as JSON. Start it from \`null\`, or from what JSON holds.`,
      found,
    );
  }
}

/**
 * How the component's code reads a value, of its names: its constants, as what they hold but where
 * the code changes them since (`told`); its server part's functions, its imports' values.
 */
function componentReading(state: SideState): JsonReading {
  const { component } = state;
  return told(state, {
    follow: (name) => constantOf(component, name),
    holdsNonJson: (name, entry) =>
      isServerFunction(component, name.text) || isImportedNonJson(state, name, entry),
    isNonJsonMember: (node, entry) => declaredNonJson(state, importedOf(state, node), entry),
    isNonJsonCall: (node, at) => callsNoJson(state, node, at),
    scope: componentScope(state),
  }).reading;
}

/**
 * `reading`, told the constants the code changes since it declares them (`local-writes.ts`), of
 * the calls where each is declared read as the component's code or its module's reads them.
 */
function told(state: SideState, reading: JsonReading): Told {
  const callsAt = (declaration: Node, at: JsonReading): Calls => {
    const isComponent = declaration.getSourceFile() === state.component.sourceFile;
    const scope = isComponent ? componentScope(state) : moduleScope(state.modules);
    return { functionOf: (callee) => scope.functionOf(callee, at) };
  };
  return toldChanges(reading, callsAt, isNonJson);
}

/**
 * Whether the name `name` imports what no JSON holds where it stands — `entry` where it is an
 * object's entry's value: a function or a class a `shared` module exports — declared, or a constant
 * of one, through what re-exports it (`exportedMember`) — or a module's namespace, an object of its
 * exports.
 */
function isImportedNonJson(state: SideState, name: Identifier, entry: boolean): boolean {
  const imported = state.component.names.get(name.text);
  if (imported?.kind !== 'import' || imported.binding.typeOnly) {
    return false;
  }
  return (
    imported.binding.form === 'namespace' || declaredNonJson(state, importedOf(state, name), entry)
  );
}

/**
 * Whether what a module declares holds what no JSON holds where it stands — `entry` where it is an
 * object's entry's value: a function's or a class's declaration, a method, or a constant of what no
 * JSON holds where its code shows it — a function, `Symbol('marker')` — its names read as its
 * module declares them (`declaredBy`).
 */
function declaredNonJson(
  state: SideState,
  value: MemberValue | undefined,
  entry: boolean,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (isDeclaration(value)) {
    return true;
  }
  // `payload.when` of `{ get when() { … } }`: what the getter answers.
  if (isGetAccessorDeclaration(value)) {
    return answersNoJson(state, value, { entry, gives: () => false });
  }
  const { changes, reading } = told(state, {
    entry,
    follow: (name) => moduleValue(state.modules, name),
    holdsNonJson: (name) => isModuleDeclaration(state.modules, name),
    isNonJsonCall: (node, at) => callsNoJson(state, node, at),
    scope: moduleScope(state.modules),
  });
  return changes(value) || nonJsonOf(value, reading) !== undefined;
}

/** What a call gives a function's parameters: whether it gives one what no JSON holds, where it stands. */
interface Giving {
  /** Whether the call is an object's entry's value, which may hold `undefined`. */
  readonly entry: boolean;
  /** Whether it gives the parameter at `index` what no JSON holds, as an entry's value where `entry`. */
  readonly gives: (index: number, entry?: boolean) => boolean;
  /**
   * Whether it may give the parameter at `index` nothing, or `undefined`, of which it takes the
   * default the code writes it (`Given.omits`); of none told, it may.
   */
  readonly omits?: ((index: number) => boolean) | undefined;
  /**
   * How the code around reads a name the function does not declare, of one the component writes —
   * its constants, its server part's functions, its imports; none of a module's, whose names its
   * module declares.
   */
  readonly outer?: JsonReading | undefined;
  /** The functions whose answers are read on the way to the call (`JsonReading.calling`). */
  readonly calling?: ReadonlySet<Node> | undefined;
}

/**
 * Whether `call` answers what no JSON holds: of a function the compile reads the code of — a shared
 * module's, one the code writes, one the server part declares (`functionOf`) — as it answers what
 * it is given (`answersCall`), called through `call`, `apply` or `bind` too (`throughOf`); of a
 * global's function or a value's method, what it holds of what it is handed (`retainsNonJson`); of
 * an import's the compile does not read, nothing it tells.
 */
function callsNoJson(state: SideState, call: CallExpression, reading: JsonReading): boolean {
  const callee = unwrapped(call.expression);
  const scope = reading.scope ?? componentScope(state);
  const fn = scope.functionOf(callee, reading);
  if (fn !== undefined) {
    return answersCall(state, fn, givenOf(call), reading);
  }
  const through = throughOf(call);
  if (through !== undefined) {
    return throughNonJson(state, { scope, through }, reading);
  }
  if (scope.isImport(callee)) {
    return false;
  }
  const known = knownCallNonJson(call, reading, { check: isNonJson, refers: isNonJsonReference });
  return known ?? retainsNonJson(state, call, reading);
}

/**
 * Whether what a call invokes through `call`, `apply`, `bind` or `Reflect.apply` (`Through`)
 * answers what no JSON holds: a function, of `bind` alone; of a function the compile reads, what it
 * answers given what the call gives it; of anything else, anything — but of an import's, of which
 * it tells nothing.
 */
function throughNonJson(
  state: SideState,
  { scope, through }: { readonly scope: CallScope; readonly through: Through },
  reading: JsonReading,
): boolean {
  if (through.kind !== 'invoked') {
    return true;
  }
  const target = unwrapped(through.target);
  const fn = scope.functionOf(target, reading);
  if (fn !== undefined) {
    return answersCall(state, fn, through.given, reading);
  }
  return !scope.isImport(target);
}

/**
 * Whether `fn`, called and given what `given` says, answers what no JSON holds (`answersNoJson`):
 * what a parameter of any declaration of it is given, a rest one's of one, read where it stands;
 * the names of one the component writes, as the code around reads them.
 */
function answersCall(state: SideState, fn: Answering, given: Given, reading: JsonReading): boolean {
  const overloads = overloadsOf(fn);
  return answersNoJson(state, fn, {
    calling: reading.calling,
    entry: reading.entry === true,
    gives: (index, entry = reading.entry === true) => {
      return overloads.some((each) => {
        return given(each, index).some(
          (value) => nonJsonOf(value, { ...reading, entry }) !== undefined,
        );
      });
    },
    omits: given.omits,
    outer: fn.getSourceFile() === state.component.sourceFile ? reading : undefined,
  });
}

/**
 * Whether `fn`, of a module's, answers what no JSON holds called as `giving` says: an `async` one,
 * which answers a promise, or a generator, which answers what iterates it; one typed to answer what
 * no JSON holds (`json-types.ts`) — `Date`, `unknown` — where its type parameters, which the call
 * gives, are not; one that returns what no JSON holds where its code shows it, `new Date(0)`, typed
 * or not — of a class a type of JSON's shape satisfies, `return new Payload()` of
 * `(): { id: string }`; and one that answers what the call gives it — a parameter its return type
 * types of a type parameter, `identity<T>(value: T): T`, or one it returns, `return value` — given
 * what no JSON holds there: `identity(() => 'x')`. Of a function declared over overloads, any
 * declaration may answer the call: each signature, as its type says, and the one that implements
 * them, as its code returns too (`overloadsOf`).
 */
function answersNoJson(state: SideState, fn: Answering, giving: Giving): boolean {
  // Of one whose answer is read on the way to the call, the call answers as it does: its other
  // returns tell.
  if (giving.calling?.has(fn) === true) {
    return false;
  }
  const overloads = overloadsOf(fn);
  const calling = new Set<Node>(giving.calling);
  for (const each of overloads) {
    calling.add(each);
  }
  return overloads.some((each) => declaredAnswersNoJson(state, each, { ...giving, calling }));
}

/** Whether the declaration `fn` answers what no JSON holds, as `answersNoJson` reads each. */
function declaredAnswersNoJson(state: SideState, fn: Answering, giving: Giving): boolean {
  if (answersLater(fn)) {
    return true;
  }
  const answered = fn.type;
  if (answered !== undefined) {
    const sourceFile = fn.getSourceFile();
    const at = { file: sourceFile.fileName, sourceFile };
    // `first<T>(items: readonly T[]): T`: what `T` is, the call gives; `Date` beside it, it does not.
    const given =
      fn.typeParameters === undefined
        ? undefined
        : { declarations: fn.typeParameters, file: at.file, given: true };
    if (
      nonJsonPart(answered, at, typeReading(state.modules, given)) !== undefined ||
      answeredParameters(fn).some((index) => giving.gives(index))
    ) {
      return true;
    }
  }
  // What it returns, as its code writes it, whatever its type says. A parameter it returns holds
  // what the call gives it, where it stands in what it returns; a constant it declares, what it
  // holds; a name of its module's, what the module declares it.
  const locals = localsOf(fn);
  const isLocal = (name: Identifier): boolean =>
    standsIn(name, fn) && locals.declared.has(name.text);
  const { outer } = giving;
  // The parameters whose defaults are read on the way, of which one that reads its own reads none.
  const defaulting = new Set<string>();
  const { reading } = told(state, {
    // What it calls, read as a call is, where its code stands: the component's, a module's.
    calling: giving.calling,
    entry: giving.entry,
    follow: (name) => {
      if (isLocal(name)) {
        return locals.constants.get(name.text);
      }
      return outer === undefined ? moduleValue(state.modules, name) : outer.follow?.(name);
    },
    holdsNonJson: (name, entry) => {
      if (!isLocal(name)) {
        return outer === undefined
          ? isModuleDeclaration(state.modules, name)
          : outer.holdsNonJson?.(name, entry) === true;
      }
      const index = parameterNamed(fn, name.text);
      return (
        index !== undefined &&
        (giving.gives(index, entry) || takesNonJson(name.text, entry) || changesParameter(name))
      );
    },
    isNonJsonCall: (node, at) => callsNoJson(state, node, at),
    // A member of a parameter: of what the call gives it, or a default it takes, of no JSON.
    isNonJsonMember: (node, entry) => {
      const base = baseOf(node);
      if (!isIdentifier(base) || !isLocal(base)) {
        return outer?.isNonJsonMember?.(node, entry) === true;
      }
      const index = parameterNamed(fn, base.text);
      return (
        index !== undefined &&
        (replacedMember(node, fn, { ...reading, entry }, isNonJson) ??
          (giving.gives(index, false) || takesNonJson(base.text, false)))
      );
    },
    scope: outer === undefined ? moduleScope(state.modules) : outer.scope,
  });
  const checksParameter = changedParameters(fn, reading, isNonJson);

  /** Whether a returned parameter is changed to hold what no JSON holds. */
  function changesParameter(name: Identifier): boolean {
    return checksParameter(name);
  }

  /** Whether a default the code writes that what a parameter binds as `name` may take holds no JSON. */
  function takesNonJson(name: string, entry: boolean): boolean {
    if (defaulting.has(name)) {
      return false;
    }
    defaulting.add(name);
    try {
      return defaultsOf(fn, name, giving.omits ?? (() => true)).some(
        (each) => nonJsonOf(each, { ...reading, entry }) !== undefined,
      );
    } finally {
      defaulting.delete(name);
    }
  }
  // A function that throws before it answers, each time it is called, faults what calls it.
  return (
    throwsAlways(fn, followedOf(reading)) ||
    returnedBy(fn).some((each) => nonJsonOf(each, reading) !== undefined)
  );
}

/**
 * Whether `call`, of a global's function or a value's method, answers what no JSON holds of what it
 * holds of what it is handed (`retained.ts`): an iterator, `items.values()`; what it is called on
 * or given, `Array.of(helper)`, `[helper].at(0)`; what the function it is given answers,
 * `[1].map(() => helper)` — written there, as its code returns it, or a module's.
 */
function retainsNonJson(state: SideState, call: CallExpression, reading: JsonReading): boolean {
  const held = heldBy(call);
  if (held === undefined) {
    return false;
  }
  const inner: JsonReading = { ...reading, entry: false };
  const scope = reading.scope ?? componentScope(state);
  // `items.values().map(…)`, `new Uint8Array(2).map(…)`: what it is called on, of its kind.
  const reach = (node: Expression): Expression => reached(node, reading).value;
  const iterates =
    held.iterates !== undefined &&
    (isTypedArray(held.iterates, reach) ||
      isIterator(
        held.iterates,
        reach,
        (made) =>
          scope.functionOf(unwrapped(made.expression), reading)?.asteriskToken !== undefined,
      ));
  // `params.delete('a')` of `new URLSearchParams()`: nothing, which an entry may hold alone.
  const voids =
    held.voidsOn !== undefined &&
    reading.entry !== true &&
    isVoidingReceiver(reached(held.voidsOn, reading).value);
  // `response.json()` of `new Response(text)`, a promise; `buffer.transfer()`, another buffer.
  const made = held.madeOf !== undefined && isPlatformMade(held.madeOf, reach);
  return (
    namedNonJson(held, reach) ||
    iterates ||
    voids ||
    made ||
    answersOtherwise(call, held, reading) ||
    held.values.some((each) => nonJsonOf(each, inner) !== undefined) ||
    // Of no function to answer in their place, the elements an array-like lacks are the answer's.
    (held.functions.length === 0 && held.likes.some((each) => lacksElement(each, reading))) ||
    held.entries.some((each) => entriesNonJson(each, reading, isNonJson)) ||
    held.keys.some((each) => keysNonJson(each, reading, isNonJson)) ||
    held.patterns.some((each) => patternCapturesNothing(scope, each, reading)) ||
    held.functions.some((each) => functionNonJson(state, each, inner))
  );
}

/**
 * Whether what `held` says of a call's answer by its method's name alone — an iterator, a promise
 * (`Held.nonJson`) — holds: not of an object the code writes of a method of its own of that name,
 * `helper.values()` of `const helper = { values() { … } }` (`ownsMethod`), what `reach` says it is.
 */
function namedNonJson(held: Held, reach: (node: Expression) => Expression): boolean {
  const { ownedBy } = held;
  return (
    held.nonJson &&
    (ownedBy === undefined || !ownsMethod(reach(ownedBy.receiver), ownedBy.name, reach))
  );
}

/**
 * Whether `call`, of what `held` says it holds, answers what no JSON holds of how it answers rather
 * than of what it is handed: nothing, of an element it may find none of, which JSON leaves out of an
 * object alone; of nothing it is called on, which it throws of, or answers nothing of through
 * `?.`; what throws of an array of no element, `reduce` of no first value, or of an index past its
 * bounds, `with`; and the holes `map` keeps of what it is called on, which JSON writes as `null` —
 * and what it is called on, whose elements it holds, of no JSON.
 */
function answersOtherwise(call: CallExpression, held: Held, reading: JsonReading): boolean {
  const isNothing = held.nothing && reading.entry !== true && !answersPresent(call, reading);
  const isThrown =
    (held.emptyThrows === true && !holdsElement(call)) ||
    (held.bounded === true && !replacesWithin(call, reading));
  const keepsHoles = held.keepsHoles !== undefined && holdsHoles(held.keepsHoles, reading);
  const onNothing = held.optional === true && reading.entry === true;
  const isTargetNonJson =
    held.target !== undefined &&
    nonJsonOf(held.target, { ...reading, entry: onNothing }) !== undefined;
  return isNothing || isThrown || keepsHoles || isTargetNonJson;
}

/**
 * Whether what a function a call is given answers, as the call's answer holds it, holds what no
 * JSON holds: of a promise, `async`; of what its code returns — a parameter the call hands what it
 * is handed, or a member of one, as what it is handed holds, `[helper].map((value) => value)` — or
 * of a module's function, as it answers what it is given.
 */
function functionNonJson(state: SideState, held: HeldFunction, reading: JsonReading): boolean {
  const handed =
    held.of.some((each) => nonJsonOf(each, reading) !== undefined) ||
    held.likes.some((each) => lacksElement(each, reading));
  const gives = (index: number): boolean => handed && held.parameters.includes(index);
  const given = unwrapped(held.fn);
  // Of `undefined` given in its place, what the call is handed stands as it is: `Array.from(…,
  // undefined)`.
  const { value } = reached(given, reading);
  if ((isIdentifier(value) && globalOf(value) === 'undefined') || isVoidExpression(value)) {
    return handed;
  }
  if (!isAnswering(given)) {
    const fn = (reading.scope ?? componentScope(state)).functionOf(given, reading);
    const outer = fn?.getSourceFile() === state.component.sourceFile ? reading : undefined;
    const giving = { calling: reading.calling, entry: false, gives, outer };
    return fn !== undefined && answersNoJson(state, fn, giving);
  }
  if (answersLater(given)) {
    return true;
  }
  const parameterOf = (node: Expression): number | undefined => {
    const { root } = memberPath(node);
    return isIdentifier(root) ? parameterNamed(given, root.text) : undefined;
  };
  // Of its own names, what it declares: a constant, what it holds; a parameter, what it is handed.
  const locals = localsOf(given);
  const isLocal = (name: Identifier): boolean =>
    standsIn(name, given) && locals.declared.has(name.text);
  // A default of a parameter's, which the call may give nothing in place of, read where it stands.
  const defaultNonJson = (name: string, entry: boolean): boolean =>
    defaultsOf(given, name, () => true).some((each) => isNonJson(each, { ...reading, entry }));
  const inside = told(state, {
    ...reading,
    follow: (name) => (isLocal(name) ? locals.constants.get(name.text) : reading.follow?.(name)),
    holdsNonJson: (name, entry) => {
      const index = parameterNamed(given, name.text);
      if (index !== undefined) {
        return gives(index) || defaultNonJson(name.text, entry);
      }
      return !isLocal(name) && reading.holdsNonJson?.(name, entry) === true;
    },
    isNonJsonMember: (node, entry) => {
      const index = parameterOf(node);
      if (index === undefined) {
        return reading.isNonJsonMember?.(node, entry) === true;
      }
      const { root } = memberPath(node);
      return gives(index) || (isIdentifier(root) && defaultNonJson(root.text, false));
    },
  }).reading;
  return (
    throwsAlways(given, followedOf(inside)) ||
    returnedBy(given).some((returned) => nonJsonOf(returned, inside) !== undefined)
  );
}
