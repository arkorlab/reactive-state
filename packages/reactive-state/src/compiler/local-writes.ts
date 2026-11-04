import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateSpan,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TaggedTemplateExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, givenAt, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import type { JsonReading } from './json-reading.ts';
import { readsOf } from './local-module-reads.ts';
import { aliasedDeclaration, followedAlias, readsUntouchedMember } from './local-reading.ts';
import { constantNumber, setsTime } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * What the code writes into a constant after it declares it, as the checks of what no JSON holds
 * read it (`json-values.ts`) — a function's, a component's, a module's: what it puts in, read as
 * the constant's own — `result.key = value`, `items.push(item)`, `Object.assign(result, more)` — and
 * whether it changes it otherwise, of which it may hold anything: a property defined,
 * `Object.defineProperty(result, …)`; a prototype set; a date's time set, `when.setTime(0)`; its
 * `length`; an entry beside an array's elements; a member a pattern or a loop assigns,
 * `[result.x] = items`; the constant held by a variable, or handed to a function of a global's that
 * calls another. What a name the code declares of the constant writes —
 * `const inner = result.inner`, `for (const item of result)` — and what a function the compile
 * reads writes of what it is handed — a tag's too — it writes into the constant. What the constant
 * is put into — an array, an object — is not followed, nor what a function the compile does not
 * read does with what it is handed, of which it tells nothing, as of what it answers.
 */

/** A value the code puts into a constant: an object's entry, which may hold `undefined`, or an element. */
interface Put {
  readonly value: Expression;
  readonly entry: boolean;
  readonly inside: Expression | undefined;
}

/** What is written into a constant: the values put in, and whether it is changed otherwise. */
interface Writes {
  readonly values: readonly Put[];
  readonly changes: boolean;
}

/** How a call reads what it calls, where the code stands (`CallScope`). */
export interface Calls {
  /** The function a call of `callee` calls, of code the compile reads; none of another. */
  readonly functionOf: (callee: Expression) => Answering | undefined;
}

/** How `writesOf` reads the code: the scope it reads, how calls read, the names it reads already. */
interface Walk {
  readonly owner: Node;
  readonly calls: Calls;
  readonly visiting: ReadonlySet<Identifier>;
  readonly reads?: ((name: Identifier) => boolean) | undefined;
}

const CHANGED: Writes = { changes: true, values: [] };
const NONE: Writes = { changes: false, values: [] };

/**
 * The functions of globals that change what they are given first otherwise than by values put in:
 * a property defined — which JSON may leave out, or an accessor computes — a prototype set.
 */
const CHANGING: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

/** The functions of globals that call what they are given, as another function. */
const CALLING: ReadonlySet<string> = new Set(['Reflect.apply', 'Reflect.construct']);

/** The methods of a function that call it, as another. */
const CALLING_METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/**
 * The methods that put what they are given into what they are called on, from a place: an array's,
 * and a `Map`'s `set`, of its key and its value.
 */
const PUTTING_FROM: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['push', 0],
  ['set', 0],
  ['splice', 2],
  ['unshift', 0],
]);

/** The operators that assign what stands on their right. */
const ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The operators that assign what they compute of what stands on either side. */
const COMPUTING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/** The operators of `COMPUTING` that make no finite number of a zero on their right: `ratio /= 0`. */
const BY_ZERO: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/** A reading told the constants the code changes since it declares them, and how it tells of one. */
export interface Told {
  readonly reading: JsonReading;
  /** Whether the code changes the constant `held` — an initializer, or a value written in one — is of. */
  readonly changes: (held: Expression) => boolean;
}

/**
 * `reading`, told the constants the code changes since it declares them (`JsonReading.isChanged`):
 * of what it writes into one (`writesInto`), as `calls` reads what is called where it is declared,
 * a change, or a value `check` says holds what no JSON holds, read where it is written — and a
 * value of its own, of which it would hold itself.
 */
export function toldChanges(
  reading: JsonReading,
  calls: (declaration: VariableDeclaration, at: JsonReading) => Calls,
  check: (node: Expression, at: JsonReading) => boolean,
): Told {
  const known = new Map<VariableDeclaration, boolean | Writes>();
  const changesAt = (held: Expression, at: JsonReading, reference?: Identifier): boolean => {
    const declaration = aliasedDeclaration(held, at.follow, declarationOf);
    // A function holds no JSON whatever the code writes into it, and is read as it is written.
    if (declaration === undefined || isFunctionWritten(unwrapped(held))) {
      return false;
    }
    const was = known.get(declaration);
    if (typeof was === 'boolean') {
      return was;
    }
    if (was !== undefined) {
      return (
        was.changes ||
        reference === undefined ||
        !readsUntouchedMember(reference, was.values, at.follow)
      );
    }
    known.set(declaration, CHANGED);
    const found = writesInto(declaration, calls(declaration, at));
    known.set(declaration, found);
    const changed =
      found.changes || found.values.some((put) => check(put.value, { ...at, entry: put.entry }));
    known.set(declaration, changed);
    return changed;
  };
  const told: JsonReading = {
    ...reading,
    follow: (name) => followedAlias(name, reading.follow, declarationOf),
    isChanged: (name, at) => {
      const held = reading.follow?.(name);
      return held !== undefined && changesAt(held, at, name);
    },
  };
  return { changes: (held) => changesAt(held, told), reading: told };
}

/** Whether `node` is a function the code writes — an arrow, a function, a class. */
function isFunctionWritten(node: Expression): boolean {
  return isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node);
}

/** The constant `held` is the initializer of, or an entry or an element written in it is. */
function declarationOf(held: Expression): VariableDeclaration | undefined {
  let node: Node = held;
  for (;;) {
    const { parent } = node;
    if (isVariableDeclaration(parent)) {
      return isSame(parent.initializer, node) && isIdentifier(parent.name) ? parent : undefined;
    }
    const isWithin =
      (isPropertyAssignment(parent) && parent.initializer === node) ||
      isObjectLiteralExpression(parent) ||
      isArrayLiteralExpression(parent) ||
      isWrapping(parent, node);
    if (!isWithin) {
      return undefined;
    }
    node = parent;
  }
}

/**
 * What the code writes into the constant `declaration` declares (`Writes`), where it is declared —
 * a function's code, a component's, a module's — as `calls` reads what it calls there.
 */
function writesInto(declaration: VariableDeclaration, calls: Calls): Writes {
  const { name } = declaration;
  if (!isIdentifier(name)) {
    return NONE;
  }
  let owner: Node = declaration;
  while (!isSourceFile(owner) && !isAnswering(owner)) {
    owner = owner.parent;
  }
  return writesOf(name, declaration.initializer, { calls, owner, visiting: new Set() });
}

/**
 * What the code `walk.owner` writes into the name `declared` declares, holding what `held`
 * writes where the code says: each read of it that changes it, or hands it on (`writesAt`).
 */
export function writesOf(declared: Identifier, held: Expression | undefined, walk: Walk): Writes {
  if (walk.visiting.has(declared)) {
    return NONE;
  }
  const inner: Walk = { ...walk, visiting: new Set([...walk.visiting, declared]) };
  const values: Put[] = [];
  let changes = false;
  const isRead = readsOf(declared, walk.owner);
  const visit = (node: Node): void => {
    if (isRead(node) && walk.reads?.(node) !== false) {
      const found = writesAt(node, held, inner);
      values.push(...found.values);
      changes ||= found.changes;
    }
    node.forEachChild(visit);
  };
  walk.owner.forEachChild(visit);
  return { changes, values };
}

/**
 * What a read of a name, `name`, writes into what it names, of what `initializer` writes it: what
 * it assigns a member of it, puts in by a method or `Object.assign`; anything of a member a pattern
 * or a loop assigns, `[result.x] = items`; whether a global changes it, a function the compile
 * reads it is handed changes it — a tag's too — or a name of the code's holds it, of which what is
 * written is written into it.
 */
function writesAt(name: Identifier, initializer: Expression | undefined, walk: Walk): Writes {
  const { keys, top } = memberChain(name);
  if (isPatternTarget(top)) {
    return keys.length > 0 ? CHANGED : NONE;
  }
  const { parent } = top;
  if (isBinaryExpression(parent) && parent.left === top) {
    const operator = parent.operatorToken.kind;
    const isAssigning = ASSIGNING.has(operator) || COMPUTING.has(operator);
    return isAssigning
      ? assigned(operator, parent.right, { initializer, inside: receiverOf(top), keys })
      : NONE;
  }
  if (isCallExpression(parent) && parent.expression === top) {
    return called(parent, keys, walk);
  }
  const call = handedTo(top);
  if (call !== undefined) {
    return handed(call, top, { initializer, keys, walk });
  }
  const tagged = taggedBy(top);
  if (tagged !== undefined) {
    const fn = walk.calls.functionOf(unwrapped(tagged.tag));
    return fn !== undefined && writesParameters(fn, walk, () => true) ? CHANGED : NONE;
  }
  return heldBy(top, walk);
}

/**
 * The member a read of `name` reads — `name` itself, or `name.a[0]`, through what wraps it — and
 * the keys it reads in turn, `undefined` of one the compile cannot read.
 */
function memberChain(name: Identifier): {
  readonly keys: readonly (string | undefined)[];
  readonly top: Expression;
} {
  const keys: (string | undefined)[] = [];
  let top: Expression = name;
  for (;;) {
    const { parent } = top;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === top
    ) {
      keys.push(
        isPropertyAccessExpression(parent)
          ? parent.name.text
          : literalKey(unwrapped(parent.argumentExpression)),
      );
    } else if (!isWrapping(parent, top)) {
      return { keys, top };
    }
    top = parent as Expression;
  }
}

/**
 * Whether `node` is assigned what a pattern takes apart — `[result.x] = items`, `({ k: result.x } =
 * value)`, a default's target too, `[result.x = 1] = items` — or what a loop iterates, `for
 * (result.x of items)`.
 */
function isPatternTarget(node: Expression): boolean {
  let at: Node = node;
  let isWithin = false;
  for (;;) {
    const { parent } = at;
    if ((isForOfStatement(parent) || isForInStatement(parent)) && parent.initializer === at) {
      return true;
    }
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      // An assignment of its own, or a default within a pattern, `[target = fallback] = …`.
      const isDefault =
        isArrayLiteralExpression(parent.parent) || isPropertyAssignment(parent.parent);
      if (parent.left !== at || !(isWithin || isDefault)) {
        return false;
      }
      if (isWithin) {
        return true;
      }
    } else if (!isPatternPart(parent, at)) {
      return false;
    }
    isWithin ||= isArrayLiteralExpression(parent) || isObjectLiteralExpression(parent);
    at = parent;
  }
}

/** Whether `parent` holds `node` as a part of a pattern: an element, an entry's value, a spread. */
function isPatternPart(parent: Node, node: Node): boolean {
  return (
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    isShorthandPropertyAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === node) ||
    isWrapping(parent, node)
  );
}

/** The tagged template whose substitution `node` is, which hands it to its tag. */
function taggedBy(node: Expression): TaggedTemplateExpression | undefined {
  const span = node.parent;
  const tagged = isTemplateSpan(span) && span.expression === node ? span.parent.parent : undefined;
  return tagged !== undefined && isTaggedTemplateExpression(tagged) ? tagged : undefined;
}

/** Whether `parent` wraps `node` as what answers of it alike: parentheses, a cast, a `!`. */
function isWrapping(parent: Node, node: Node): boolean {
  return (
    (isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent)) &&
    parent.expression === node
  );
}

/** Where a member of a constant is written: the constant's initializer, and the keys in turn. */
interface Target {
  readonly initializer: Expression | undefined;
  readonly keys: readonly (string | undefined)[];
  readonly inside?: Expression | undefined;
}

/**
 * What an assignment of `operator` writes of `value` into the member `keys` reads of a constant:
 * the value; anything of a prototype, of a `length`, of an entry beside an array's elements, and
 * of what it computes of zero that no number is finite of, `ratio /= 0`.
 */
function assigned(operator: SyntaxKind, value: Expression, target: Target): Writes {
  const { keys } = target;
  const last = keys.at(-1);
  if (keys.length === 0) {
    return NONE;
  }
  if (last === 'length' || keys.includes('__proto__') || besideElements(target)) {
    return CHANGED;
  }
  if (COMPUTING.has(operator)) {
    const byZero = BY_ZERO.has(operator) && constantNumber(value) === 0;
    return byZero
      ? CHANGED
      : { changes: false, values: [{ entry: false, inside: target.inside, value }] };
  }
  return {
    changes: false,
    values: [{ entry: last !== undefined && !isIndex(last), inside: target.inside, value }],
  };
}

/** The container a member is read from, through any casts around the whole member. */
function receiverOf(node: Expression): Expression | undefined {
  const value = unwrapped(node);
  return isPropertyAccessExpression(value) || isElementAccessExpression(value)
    ? value.expression
    : undefined;
}

/**
 * Whether the member `target.keys` reads is an entry beside an array's elements, which no JSON the
 * authority holds has: of a key that is no index, of an array the constant is written of there.
 */
function besideElements({ initializer, keys }: Target): boolean {
  const last = keys.at(-1);
  if (last === undefined || isIndex(last)) {
    return false;
  }
  const at = writtenAt(initializer, keys.slice(0, -1));
  return at !== undefined && isArrayLiteralExpression(at);
}

/**
 * What an object or an array `initializer` writes there holds at `keys` in turn, where it writes
 * each plainly (`entryOf`); none else.
 */
function writtenAt(
  initializer: Expression | undefined,
  keys: readonly (string | undefined)[],
): Expression | undefined {
  let at = initializer === undefined ? undefined : unwrapped(initializer);
  for (const key of keys) {
    at = key === undefined || at === undefined ? undefined : entryOf(at, key);
  }
  return at;
}

/** What an object or an array the code writes holds at `key`, where it writes it plainly; none else. */
function entryOf(node: Expression, key: string): Expression | undefined {
  if (isArrayLiteralExpression(node)) {
    const element = isIndex(key) ? node.elements[Number(key)] : undefined;
    return element === undefined || isSpreadElement(element) ? undefined : unwrapped(element);
  }
  if (!isObjectLiteralExpression(node)) {
    return undefined;
  }
  const property = node.properties.findLast(
    (each) => isPropertyAssignment(each) && literalOrName(each.name) === key,
  );
  return property !== undefined && isPropertyAssignment(property)
    ? unwrapped(property.initializer)
    : undefined;
}

/** The key a property's name writes, by a name or by text or a number. */
function literalOrName(name: Node): string | undefined {
  return isIdentifier(name) ? name.text : literalKey(name);
}

/**
 * What a call of a method of a constant, or of a member of it, writes into it: what `push`,
 * `unshift`, `splice`, `fill` and a `Map`'s `set` put in; anything of a method called by a key the
 * compile cannot read, and of one that sets a date's time (`setsTime`); and of any other, what
 * a function it is given changes of what it is handed (`changesHanded`) — of `call`, `apply` and
 * `bind` too, which change what they are handed as what they call does (`handed`).
 */
function called(call: CallExpression, keys: readonly (string | undefined)[], walk: Walk): Writes {
  const method = keys.at(-1);
  if (keys.length === 0) {
    return NONE;
  }
  if (method === undefined) {
    return CHANGED;
  }
  const from = PUTTING_FROM.get(method);
  if (from === undefined) {
    return setsTime(method) || changesHanded(call, walk) ? CHANGED : NONE;
  }
  const put = call.arguments.slice(from);
  if (put.some((each) => isSpreadElement(each))) {
    return CHANGED;
  }
  return {
    changes: false,
    values: put.map((value) => ({ entry: false, inside: receiverOf(call.expression), value })),
  };
}

/** The call or the `new` that `node` is given to, an argument or what a spread there spreads. */
function handedTo(node: Expression): CallExpression | NewExpression | undefined {
  const at = isSpreadElement(node.parent) ? node.parent : node;
  const { parent } = at;
  return (isCallExpression(parent) || isNewExpression(parent)) &&
    parent.arguments?.includes(at) === true
    ? parent
    : undefined;
}

/**
 * What a call writes into a constant, or a member of it, it is handed — `node`: what
 * `Object.assign` puts into an object the constant is written of there, and anything of what it
 * puts into another; anything of a global's function that changes it (`CHANGING`), or calls
 * another (`CALLING`, `call`, `apply`, `bind`); of a function the compile reads, what its code
 * writes into the parameters it is given at; and of any, what a function it is given changes of
 * what it is handed.
 */
function handed(
  call: CallExpression | NewExpression,
  node: Expression,
  { initializer, keys, walk }: Target & { readonly walk: Walk },
): Writes {
  const callee = unwrapped(call.expression);
  const given = call.arguments ?? [];
  const isFirst = given[0] === node;
  const path = globalPath(callee);
  const global = path?.join('.');
  const method = path?.at(-1) ?? (isPropertyAccessExpression(callee) ? callee.name.text : '');
  if (CALLING_METHODS.has(method) || (global !== undefined && CALLING.has(global))) {
    return CHANGED;
  }
  if (global !== undefined) {
    if (isFirst && global === 'Object.assign') {
      return assignedFrom(given.slice(1), { initializer, inside: node, keys });
    }
    return (isFirst && CHANGING.has(global)) || changesHanded(call, walk) ? CHANGED : NONE;
  }
  const fn = isCallExpression(call) ? walk.calls.functionOf(callee) : undefined;
  const isWritten = fn !== undefined && changesParameters(fn, given, node, walk);
  return isWritten || changesHanded(call, walk) ? CHANGED : NONE;
}

/**
 * What `Object.assign` of the sources `sources` puts into a constant, or a member of it: each
 * source's entries, of an object the code writes there; anything of an array, of what the code
 * does not show, which may be one, of what a spread hands.
 */
function assignedFrom(sources: readonly Expression[], target: Target): Writes {
  const at = writtenAt(target.initializer, target.keys);
  const isSpread = sources.some((each) => isSpreadElement(each));
  if (isSpread || at === undefined || !isObjectLiteralExpression(at)) {
    return CHANGED;
  }
  return {
    changes: false,
    values: sources.map((value) => ({ entry: true, inside: target.inside, value })),
  };
}

/**
 * Whether `fn`, called and given what `given` says, writes into what it is handed at the places
 * of its parameters `node` is given at: what its code writes into each name they bind.
 */
function changesParameters(
  fn: Answering,
  given: readonly Expression[],
  node: Expression,
  walk: Walk,
): boolean {
  return writesParameters(fn, walk, (index) => givenAt(given, fn, index).includes(node));
}

/**
 * Whether a function a call is given there writes into what it is handed — `item.done = true` of
 * `items.forEach((item) => …)` — what each of its parameters binds.
 */
function changesHanded(call: CallExpression | NewExpression, walk: Walk): boolean {
  return (call.arguments ?? []).some((argument) => {
    const fn = unwrapped(argument);
    return (
      (isArrowFunction(fn) || isFunctionExpression(fn)) && writesParameters(fn, walk, () => true)
    );
  });
}

/** Whether the code of `fn` writes into what a parameter of it `at` says of binds. */
function writesParameters(fn: Answering, walk: Walk, at: (index: number) => boolean): boolean {
  const inner: Walk = { ...walk, owner: fn };
  return parametersOf(fn).some((parameter, index) => {
    return (
      at(index) &&
      bindingIdentifiers(parameter.name).some((each) => {
        const found = writesOf(each, undefined, inner);
        return found.changes || found.values.length > 0;
      })
    );
  });
}

/**
 * What a name of the code's that holds a constant, or a member of it, writes into it: of a
 * constant declared of it — `const inner = result.inner`, `const { inner } = result`, `for (const
 * item of result)` — what is written of each name it binds; anything of a variable, or of another
 * name assigned it.
 */
function heldBy(node: Expression, walk: Walk): Writes {
  const { parent } = node;
  if (isVariableDeclaration(parent) && parent.initializer === node) {
    return boundBy(parent.parent, parent.name, walk);
  }
  if (isForOfStatement(parent) && parent.expression === node) {
    const { initializer } = parent;
    return isVariableDeclarationList(initializer)
      ? merged(initializer.declarations.map((each) => boundBy(initializer, each.name, walk)))
      : CHANGED;
  }
  const isAssigned =
    isBinaryExpression(parent) &&
    parent.right === node &&
    ASSIGNING.has(parent.operatorToken.kind) &&
    !isPropertyAccessExpression(unwrapped(parent.left)) &&
    !isElementAccessExpression(unwrapped(parent.left));
  return isAssigned ? CHANGED : NONE;
}

/** What is written of each name `name` binds, declared of `list` — anything of a variable. */
function boundBy(list: Node, name: VariableDeclaration['name'], walk: Walk): Writes {
  if (!isVariableDeclarationList(list) || !/^const\s/u.test(list.getText())) {
    return CHANGED;
  }
  return merged(bindingIdentifiers(name).map((each) => writesOf(each, undefined, walk)));
}

/** The writes of `each`, together. */
function merged(each: readonly Writes[]): Writes {
  return {
    changes: each.some((found) => found.changes),
    values: each.flatMap((found) => found.values),
  };
}

/** Whether `node` is `other`, which may be none. */
function isSame(node: Node | undefined, other: Node): boolean {
  return node === other;
}

/** Whether `key` is the index of an array's element, as the language writes one: `0`, `12`. */
function isIndex(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}
