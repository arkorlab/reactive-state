import {
  type ForOfStatement,
  type ArrowFunction,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Component } from './analyze.ts';
import { globalOf, literalName, unwrapped } from './bounded.ts';
import { INCREMENTS, MUTATORS, OBJECT_MUTATORS } from './computed.ts';
import { baseOf, isBuiltIn, type Known, knownIn } from './frozen.ts';
import { bindingIdentifiers, freeReads } from './scope.ts';
import { isConstant } from './statements.ts';
import { ignoresJsonReplacer } from './write-json.ts';

/**
 * What a component's server part writes to (`writtenIn`), which may hold, where a state reads it,
 * other than what it was declared with — a field of the database, which would bind the state
 * rather than start it (`locality.ts`).
 */

/** The names each component's server part writes to, as `writtenIn` finds them once. */
const WRITTEN = new WeakMap<Component, ReadonlySet<string>>();

/**
 * The functions of the language's globals, which change nothing they are given — `JSON.stringify`,
 * `Object.keys`, `String(…)`, `new Map(…)` — but `Object.assign` and its kin (`OBJECT_MUTATORS`).
 */
const READING_GLOBALS: ReadonlySet<string> = new Set([
  'Array',
  'Boolean',
  'Date',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'parseFloat',
  'parseInt',
  'Set',
  'String',
]);

/** The methods of arrays and of text that change neither what they are called on nor what they are given. */
const READING_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'normalize',
  'padEnd',
  'padStart',
  'reduce',
  'reduceRight',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'some',
  'split',
  'startsWith',
  'substring',
  'toLowerCase',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'values',
  'with',
]);

/**
 * The methods of the language's arrays that call the function they are given first with each
 * element, its index and the array itself.
 */
const CALLING_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'toSorted',
]);

/**
 * The functions of the language's globals that call the function they are given second with what
 * the first holds: `Array.from(items, mapping)`, `JSON.stringify(value, replacer)`.
 */
const CALLING_GLOBALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Array', new Set(['from', 'fromAsync'])],
  ['JSON', new Set(['stringify'])],
  ['Map', new Set(['groupBy'])],
  ['Object', new Set(['groupBy'])],
]);

/**
 * The names `component`'s server part writes to, which may hold, where a state reads them, other
 * than what they were declared with: `x = …`, `x.a = …`, `x[i] += …`, `x.a++`, `delete x.a`, a
 * method that changes what it is called on, `x.push(…)`, `x['push'](…)`, `Object.assign(x, …)` —
 * anywhere in it, a function of it too — and what it hands to a call the compile cannot tell, which
 * may change it: what a function of the application's is given, `fill(options)`, `new Form(options)`,
 * each name what it is given reads — `fill({ target: options })`, `fill(() => options)` — and what
 * one of its methods is called on and given, a method named by what the compile cannot read or
 * called through `.call` among them; a write that starts at what the code computes writes to each
 * name that reads, `(cond ? a : b).c = …` — but what nothing a call changes (`frozenIn`): the
 * props, which the authority freezes, and constants of primitives, or of parts of the props. A
 * write through a name that holds another's writes there too (`heldIn`): an alias's, and a
 * parameter's of a function a call is given, which may be handed what the call is called on —
 * `[options].forEach((item) => Object.assign(item, …))` writes `options`. What a function changes
 * of a value it reaches otherwise — one it reads of another — is not followed.
 */
export function writtenIn(component: Component): ReadonlySet<string> {
  let written = WRITTEN.get(component);
  if (written === undefined) {
    const names = new Set<string>();
    const known: Reading = { ...knownIn(component), functions: functionsIn(component) };
    const visit = (node: Node): void => {
      for (const root of writtenRoots(node, known)) {
        names.add(root);
      }
      node.forEachChild(visit);
    };
    for (const statement of component.server) {
      visit(statement);
    }
    // What a constant holds of another — `const alias = options`, `[options]`, `{ ...options }`'s
    // parts — a write through it writes there too.
    const held = heldIn(component, known);
    const pending = [...names];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const others = held.get(name);
      if (others === undefined) {
        continue;
      }
      for (const other of others) {
        if (!names.has(other)) {
          names.add(other);
          pending.push(other);
        }
      }
    }
    written = names;
    WRITTEN.set(component, written);
  }
  return written;
}

/**
 * The operators of an assignment of which what stands on its left may hold what stands on its
 * right: `=`, and `&&=`, `||=`, `??=`, which assign it where they assign.
 */
const HOLDING_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * The names each name of `component`'s server part reads in what it is given, which it may hold —
 * a declaration's, anywhere in it, in a block, a function of it too (`const alias = options`), an
 * assignment's (`alias = options`, `alias ??= options`, `holder.options = options`), and each
 * parameter of a function a call is given — written there, or a function of the server part's
 * named — what the call is called on and given besides, which it may be handed
 * (`[options].forEach((item) => …)`) — but those of `frozen`, which nothing changes.
 */
function heldIn(component: Component, reading: Reading): ReadonlyMap<string, readonly string[]> {
  const { frozen, functions } = reading;
  const held = new Map<string, Set<string>>();
  const hold = (names: readonly string[], read: readonly string[]): void => {
    for (const name of names) {
      const holding = held.get(name) ?? new Set<string>();
      for (const each of read) {
        holding.add(each);
      }
      held.set(name, holding);
    }
  };
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node) && node.initializer !== undefined) {
      const names = bindingIdentifiers(node.name).map((bound) => bound.text);
      hold(names, namesRead(node.initializer, frozen));
    }
    // `const { alias = options } = given`, `(alias = options) => …`: what a default gives, the name holds.
    if (
      (isBindingElement(node) || isParameterDeclaration(node)) &&
      node.initializer !== undefined &&
      node.name !== undefined
    ) {
      const names = bindingIdentifiers(node.name).map((bound) => bound.text);
      hold(names, namesRead(node.initializer, frozen));
    }
    // `({ alias = options } = given)`.
    if (
      isShorthandPropertyAssignment(node) &&
      node.objectAssignmentInitializer !== undefined &&
      isIdentifier(node.name)
    ) {
      hold([node.name.text], namesRead(node.objectAssignmentInitializer, frozen));
    }
    if (isBinaryExpression(node) && HOLDING_ASSIGNMENTS.has(node.operatorToken.kind)) {
      hold(rootsOf(targetsOf(node.left)), namesRead(node.right, frozen));
    }
    // `for (const item of [options])`: what the loop binds holds what it iterates, element by element.
    if (isForOfStatement(node)) {
      hold(loopNames(node), namesRead(node.expression, frozen));
    }
    // `list.push(options)`, `Object.assign(target, { options })`: what a call puts into another,
    // that one holds.
    const put = isCallExpression(node) ? putInto(node) : undefined;
    if (put !== undefined) {
      hold(
        rootsOf(targetsOf(put.into)),
        put.given.flatMap((each) => namesRead(each, frozen)),
      );
    }
    if (isCallExpression(node) || isNewExpression(node)) {
      for (const [parameters, handed] of callbacksOf(node, functions)) {
        hold(
          parameters,
          handed.flatMap((each) => namesRead(each, frozen)),
        );
      }
    }
    node.forEachChild(visit);
  };
  for (const statement of component.server) {
    visit(statement);
  }
  return new Map([...held].map(([name, read]) => [name, [...read]]));
}

/** The methods of a map and of a set that put what they are given into what they are called on. */
const PUTTING: ReadonlySet<string> = new Set(['add', 'set']);

/** The functions of `Reflect` that put what they are given into what they are given first. */
const REFLECT_PUTTING: ReadonlySet<string> = new Set(['defineProperty', 'set', 'setPrototypeOf']);

/**
 * What `call` puts into another of what it reads, and what it puts there: of a method that changes
 * what it is called on (`MUTATORS`, `push`), and of a map's or a set's `set` and `add`, what it is
 * called on, of each argument; of `Object.assign` and its kin, and of `Reflect.set` and its kin,
 * what it is given first, of the rest.
 */
function putInto(
  call: CallExpression,
): { readonly into: Node; readonly given: readonly Node[] } | undefined {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const name = isPropertyAccessExpression(callee) ? callee.name.text : literalName(callee);
  if (name === undefined) {
    return undefined;
  }
  const target = unwrapped(callee.expression);
  const global = globalOf(target);
  if (
    (global === 'Object' && OBJECT_MUTATORS.has(name)) ||
    (global === 'Reflect' && REFLECT_PUTTING.has(name))
  ) {
    const [into, ...given] = call.arguments;
    return into === undefined ? undefined : { given, into };
  }
  return global === undefined && (MUTATORS.has(name) || PUTTING.has(name))
    ? { given: call.arguments, into: target }
    : undefined;
}

/** The names a `for … of` loop's head declares, or assigns, each of what the loop iterates. */
function loopNames(statement: ForOfStatement): readonly string[] {
  const head = statement.initializer;
  return isVariableDeclarationList(head)
    ? head.declarations.flatMap((each) => bindingIdentifiers(each.name).map((bound) => bound.text))
    : rootsOf(targetsOf(head));
}

/** A function of the server part's, as a call may be given it: its parameters. */
type Callback = Pick<ArrowFunction, 'parameters'>;

/** What the server part holds that nothing changes (`Known`), and the functions it names. */
interface Reading extends Known {
  readonly functions: ReadonlyMap<string, Callback>;
}

/**
 * The functions the server part declares by name, anywhere in it — `const fill = (into) => …`,
 * `function fill(into) { … }` — which a call may be given by that name: but a name it assigns
 * another, or declares more than once — a parameter's too — which a call may be given another of.
 */
function functionsIn(component: Component): ReadonlyMap<string, Callback> {
  const found = new Map<string, Callback>();
  const unsure = new Set<string>();
  const declared = new Set<string>();
  const visit = (node: Node): void => {
    for (const name of declaredBy(node)) {
      if (declared.has(name)) {
        unsure.add(name);
      }
      declared.add(name);
    }
    const named = namedFunction(node, component.sourceFile);
    if (named !== undefined) {
      found.set(...named);
    }
    if (isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      for (const target of targetsOf(node.left)) {
        if (isIdentifier(target)) {
          unsure.add(target.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  for (const statement of component.server) {
    visit(statement);
  }
  for (const name of unsure) {
    found.delete(name);
  }
  return found;
}

/** The names `node` declares: a variable's, destructured too, a parameter's, a function's. */
function declaredBy(node: Node): readonly string[] {
  if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    return bindingIdentifiers(node.name).map((bound) => bound.text);
  }
  return isFunctionDeclaration(node) && node.name !== undefined ? [node.name.text] : [];
}

/**
 * The function `node` declares by name, with the name: a function's declaration, or a constant of
 * a function written there, `const fill = (into) => …`.
 */
function namedFunction(
  node: Node,
  sourceFile: Component['sourceFile'],
): readonly [string, Callback] | undefined {
  if (isFunctionDeclaration(node) && node.name !== undefined) {
    return [node.name.text, node];
  }
  if (!isVariableDeclaration(node) || !isIdentifier(node.name) || node.initializer === undefined) {
    return undefined;
  }
  const value = unwrapped(node.initializer);
  const statement = node.parent.parent;
  return (isArrowFunction(value) || isFunctionExpression(value)) &&
    isVariableStatement(statement) &&
    isConstant(statement, sourceFile)
    ? [node.name.text, value]
    : undefined;
}

function isAssignment(operator: SyntaxKind): boolean {
  return operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
}

/**
 * Whether `node`, a function a call is given to call, is one whose writes the compile follows: one
 * written there, or one of the server part's it names, whose parameters hold what the call hands
 * them (`heldIn`); or one of the language's that changes nothing it is given — or none at all. One
 * it reaches otherwise — under another name, `alias`, a member of a value, `handlers.fill` — it
 * does not see. For stringify, a known ignored replacer hands nothing to a callback.
 */
function isSeenFunction(
  node: Expression | undefined,
  reading: Reading,
  stringify = false,
): boolean {
  if (node === undefined || (stringify && ignoresJsonReplacer(node))) {
    return true;
  }
  const value = unwrapped(node);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return true;
  }
  if (isIdentifier(value)) {
    return reading.functions.has(value.text) || READING_GLOBALS.has(globalOf(value) ?? '');
  }
  if (!isPropertyAccessExpression(value)) {
    return false;
  }
  const global = globalOf(unwrapped(value.expression));
  return (
    global !== undefined &&
    READING_GLOBALS.has(global) &&
    !(global === 'Object' && OBJECT_MUTATORS.has(value.name.text))
  );
}

/**
 * Each function `call` is given — written there, or named — with the names its parameters bind and
 * what the call is called on and given besides, which the call may hand to it.
 */
function callbacksOf(
  call: CallExpression | NewExpression,
  functions: ReadonlyMap<string, Callback>,
): readonly (readonly [readonly string[], readonly Node[]])[] {
  const callee = unwrapped(call.expression);
  const target =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? [callee.expression]
      : [];
  const given = call.arguments ?? [];
  return given.flatMap((argument) => {
    const fn = functionGiven(argument, functions);
    if (fn === undefined) {
      return [];
    }
    const parameters = fn.parameters.flatMap((parameter) =>
      bindingIdentifiers(parameter.name).map((bound) => bound.text),
    );
    return [[parameters, [...target, ...given.filter((each) => each !== argument)]] as const];
  });
}

/** The function `argument` is: one written there, or one of the server part's it names. */
function functionGiven(
  argument: Expression,
  functions: ReadonlyMap<string, Callback>,
): Callback | undefined {
  const value = unwrapped(argument);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return value;
  }
  return isIdentifier(value) ? functions.get(value.text) : undefined;
}

/**
 * The names `node` reads as values of what is around it — not a property's name, nor one it
 * declares itself, a function's parameter (`freeReads`) — but those of `frozen`.
 */
function namesRead(node: Node, frozen: ReadonlySet<string>): readonly string[] {
  const found = new Set<string>();
  for (const read of freeReads(node)) {
    if (!frozen.has(read.text)) {
      found.add(read.text);
    }
  }
  return [...found];
}

/**
 * The names `node` writes to, where it writes: the root of what it assigns, or changes — of a call,
 * none of `known.frozen`, which nothing it calls changes.
 */
function writtenRoots(node: Node, known: Reading): readonly string[] {
  if (isBinaryExpression(node)) {
    return isAssignment(node.operatorToken.kind) ? rootsOf(targetsOf(node.left)) : [];
  }
  // `for (options.title of items)`: the loop writes each item to what its head names.
  if (
    (isForOfStatement(node) || isForInStatement(node)) &&
    !isVariableDeclarationList(node.initializer)
  ) {
    return rootsOf(targetsOf(node.initializer));
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    return INCREMENTS.has(node.operator) ? rootsOf([node.operand]) : [];
  }
  if (isDeleteExpression(node)) {
    return rootsOf([node.expression]);
  }
  const called = calledOf(node, known);
  return called.filter((root) => !known.frozen.has(root));
}

/**
 * The names a call `node` may write to (`calledRoots`): of a call, of `new`, and of a tagged
 * template, which calls its tag with what it substitutes (``fill`${options}` ``); none of another.
 */
function calledOf(node: Node, known: Reading): readonly string[] {
  if (isCallExpression(node) || isNewExpression(node)) {
    return calledRoots(node.expression, node.arguments ?? [], known);
  }
  if (isTaggedTemplateExpression(node)) {
    const { template } = node;
    const given = isTemplateExpression(template)
      ? template.templateSpans.map((span) => span.expression)
      : [];
    return calledRoots(node.tag, given, known);
  }
  return [];
}

/**
 * The names a call may write to: what a method that changes it is called on, what `Object.assign`
 * and its kin are given first, nothing of the language's functions — the globals' own, not a
 * binding of their names, and by a name the compile reads — and, of a method of a name the
 * language's arrays and text read by (`READING_METHODS`), what it is given, which one of the
 * application's of that name may change, and what it is called on but where that is the language's
 * own array or text (`isBuiltIn`); and, of any other call, which the compile cannot tell, what it
 * is given, and what it is called on.
 */
function calledRoots(
  called: Expression,
  given: readonly Expression[],
  known: Reading,
): readonly string[] {
  const callee = unwrapped(called);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return READING_GLOBALS.has(globalOf(callee) ?? '') ? [] : handedRoots(given, known);
  }
  const name = isPropertyAccessExpression(callee) ? callee.name.text : literalName(callee);
  const target = unwrapped(callee.expression);
  const global = globalOf(target);
  if (name !== undefined && global !== undefined && READING_GLOBALS.has(global)) {
    const changed = global === 'Object' && OBJECT_MUTATORS.has(name);
    // `Array.from(items, mapping, receiver)` hands what it calls each element of what it is given
    // first, and the receiver of the call, its third, which the mapping may change as `this`.
    const calling = CALLING_GLOBALS.get(global)?.has(name) === true;
    return changed || (calling && !isSeenFunction(given[1], known, global === 'JSON'))
      ? handedRoots(handedTo(global, given), known)
      : [];
  }
  if (name !== undefined && READING_METHODS.has(name)) {
    return readingRoots(target, given, CALLING_METHODS.has(name), known);
  }
  return handedRoots(
    name !== undefined && MUTATORS.has(name) ? [target] : [target, ...given],
    known,
  );
}

/** What a function of the language's globals that calls its second argument is handed: its first, and `Array.from`'s third, the receiver of its calls. */
function handedTo(global: string, given: readonly Expression[]): readonly Expression[] {
  return global === 'Array' ? given.filter((_, index) => index !== 1) : given.slice(0, 1);
}

/**
 * What a method of a name the language's arrays and text read by may write to: nothing of theirs;
 * but one of the application's own may be so named, and change what it is given
 * (`helper.map(options)`), or what it is called on (`options.map(value)`, of
 * `map(value) { this.initial = value; }`) — but where that is the language's own array or text,
 * and what it calls, if it calls one, is a function the compile sees (`isSeenFunction`): one it
 * does not see is handed each element, and the array itself, `[options].forEach(alias)`.
 */
function readingRoots(
  target: Expression,
  given: readonly Expression[],
  calls: boolean,
  known: Reading,
): readonly string[] {
  const seen = !calls || isSeenFunction(given[0], known);
  return handedRoots(seen && isBuiltIn(target, known) ? given : [target, ...given], known);
}

/**
 * What an assignment's left side writes to: itself, or each target a pattern of it destructures
 * into — `[options.title] = …`, `({ a: options.title, ...rest } = …)`, a default's target too.
 */
function targetsOf(left: Node): readonly Node[] {
  let target = left;
  // `(options.title)`, and `options.title = fallback` of a pattern: the target itself.
  while (
    isParenthesizedExpression(target) ||
    (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken)
  ) {
    target = isParenthesizedExpression(target) ? target.expression : target.left;
  }
  if (isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      targetsOf(isSpreadElement(element) ? element.expression : element),
    );
  }
  if (isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (isPropertyAssignment(property)) {
        return targetsOf(property.initializer);
      }
      if (isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      return isSpreadAssignment(property) ? targetsOf(property.expression) : [];
    });
  }
  return [target];
}

/** No names kept out: what a write starts at may be any name what it computes reads. */
const NONE: ReadonlySet<string> = new Set();

/**
 * The names each of `nodes` may write to: the name a chain of reads starts at — `x` of `x.a[0].b` —
 * or, where it starts at what the code computes, each name that reads, which it may be any of:
 * `(cond ? a : b).c = …`, `({ target: options }).target.c = …`.
 */
function rootsOf(nodes: readonly Node[]): readonly string[] {
  return nodes.flatMap((node) => {
    const base = baseOf(node);
    return isIdentifier(base) ? [base.text] : namesRead(base, NONE);
  });
}

/**
 * The names what a call is handed, or called on, may hold, which it may change: each name it reads
 * as a value — of a chain of reads, its root; of an object, an array, a condition, a function of
 * it, each it holds or reaches, `fill({ target: options })`, `fill(() => options)` — as a constant
 * of it holds them (`heldIn`); but those of `known.frozen`, which nothing a call changes.
 */
function handedRoots(nodes: readonly Node[], known: Known): readonly string[] {
  return nodes.flatMap((node) => namesRead(node, known.frozen));
}
