import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateSpan,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  type TaggedTemplateExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, givenAt, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { followedOf, type JsonReading } from './json-reading.ts';
import { readsOf } from './local-module-reads.ts';
import { aliasedDeclaration, followedAlias, readsUntouchedMember } from './local-reading.ts';
import { assignedBinary, updatedAt } from './local-write-arithmetic.ts';
import {
  ASSIGNING,
  handedTo,
  isConstList,
  isPatternTarget,
  isShrunkAt,
  isWrapping,
  memberChain,
  receiverOf,
  type Target,
  unreplacedAt,
  UPDATING,
} from './local-write-paths.ts';
import {
  assignedFrom,
  CHANGED,
  deletedAt,
  deletedByReflect,
  NONE,
  type Put,
  type Writes,
} from './local-write-targets.ts';
import { type Resolve, setsTime } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * What the code writes into a constant after it declares it, as the checks of what no JSON holds
 * read it (`json-values.ts`) — a function's, a component's, a module's: what it puts in, read as
 * the constant's own — `result.key = value`, `items.push(item)`, `Object.assign(result, more)` — and
 * whether it changes it otherwise, of which it may hold anything.
 */

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
  readonly resolve?: Resolve | undefined;
}

const CHANGING: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

const CALLING: ReadonlySet<string> = new Set(['Reflect.apply', 'Reflect.construct']);
const CALLING_METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

const PUTTING_FROM: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['push', 0],
  ['set', 0],
  ['splice', 2],
  ['unshift', 0],
]);

/** A reading told the constants the code changes since it declares them, and how it tells of one. */
export interface Told {
  readonly reading: JsonReading;
  /** Whether the code changes the constant `held` — an initializer, or a value written in one — is of. */
  readonly changes: (held: Expression) => boolean;
}

/**
 * `reading`, told the constants the code changes since it declares them (`JsonReading.isChanged`).
 */
export function toldChanges(
  reading: JsonReading,
  calls: (declaration: VariableDeclaration, at: JsonReading) => Calls,
  check: (node: Expression, at: JsonReading) => boolean,
): Told {
  const known = new Map<VariableDeclaration, boolean | Writes>();
  const changesAt = (held: Expression, at: JsonReading, reference?: Identifier): boolean => {
    const declaration = aliasedDeclaration(held, at.follow, declarationOf);
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
    const found = writesInto(declaration, calls(declaration, at), followedOf(at));
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

/** What the code writes into the constant `declaration` declares (`Writes`). */
function writesInto(declaration: VariableDeclaration, calls: Calls, resolve: Resolve): Writes {
  const { name } = declaration;
  if (!isIdentifier(name)) {
    return NONE;
  }
  let owner: Node = declaration;
  while (!isSourceFile(owner) && !isAnswering(owner)) {
    owner = owner.parent;
  }
  return writesOf(name, declaration.initializer, { calls, owner, resolve, visiting: new Set() });
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
      const found = writesAt(node, declared, held, inner);
      values.push(...found.values);
      changes ||= found.changes;
    }
    node.forEachChild(visit);
  };
  walk.owner.forEachChild(visit);
  return { changes, values };
}

/** Direct syntax-level write (`[target.x] = …`, `delete target.x`, `target.x++`, `target.x = …`). */
function directWriteAt(top: Expression, target: Target): Writes | undefined {
  if (isPatternTarget(top)) {
    return target.keys.length > 0 ? CHANGED : NONE;
  }
  const { parent } = top;
  if (isDeleteExpression(parent) && parent.expression === top) {
    return deletedAt(target);
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    parent.operand === top &&
    UPDATING.has(parent.operator)
  ) {
    return updatedAt(parent.operator, top, target);
  }
  if (isBinaryExpression(parent) && parent.left === top) {
    return assignedBinary(parent.operatorToken.kind, top, parent.right, target);
  }
  return undefined;
}

/** What a read of `name` writes into `declared`, initialized by `initializer`. */
function writesAt(
  name: Identifier,
  declared: Identifier,
  initializer: Expression | undefined,
  walk: Walk,
): Writes {
  const { keys, top } = memberChain(name, walk.resolve);
  const target: Target = {
    callsLocal: (callee) => walk.calls.functionOf(callee) !== undefined,
    declared,
    initializer,
    inside: receiverOf(top),
    keys,
    owner: walk.owner,
    resolve: walk.resolve,
  };
  const direct = directWriteAt(top, target);
  if (direct !== undefined) {
    return direct;
  }
  const { parent } = top;
  if (isCallExpression(parent) && parent.expression === top) {
    return called(parent, keys, walk);
  }
  const call = handedTo(top);
  if (call !== undefined) {
    return handed(call, top, target, walk);
  }
  const tagged = taggedBy(top);
  if (tagged !== undefined) {
    const fn = walk.calls.functionOf(unwrapped(tagged.tag));
    return fn !== undefined && writesParameters(fn, walk, () => true) ? CHANGED : NONE;
  }
  return heldBy(top, target, walk);
}

/** The tagged template whose substitution `node` is, which hands it to its tag. */
function taggedBy(node: Expression): TaggedTemplateExpression | undefined {
  const span = node.parent;
  const tagged = isTemplateSpan(span) && span.expression === node ? span.parent.parent : undefined;
  return tagged !== undefined && isTaggedTemplateExpression(tagged) ? tagged : undefined;
}

/** What a call of a method of a constant, or of a member of it, writes into it. */
function called(call: CallExpression, keys: readonly (string | undefined)[], walk: Walk): Writes {
  const method = keys.at(-1);
  if (keys.length === 0) {
    return NONE;
  }
  if (method === undefined || (method === 'fill' && call.arguments.length === 0)) {
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

/** Handles a call to a recognized global (`Object.assign`, `Reflect.deleteProperty`, `CHANGING`). */
function handedGlobal(
  global: string,
  call: CallExpression | NewExpression,
  node: Expression,
  { target, walk }: { readonly target: Target; readonly walk: Walk },
): Writes {
  if (CALLING.has(global)) {
    return CHANGED;
  }
  const given = call.arguments ?? [];
  const isFirst = given[0] === node;
  if (isFirst && global === 'Object.assign') {
    return assignedFrom(given.slice(1), { ...target, inside: node });
  }
  if (isFirst && global === 'Reflect.deleteProperty') {
    return changesHanded(call, walk) ? CHANGED : deletedByReflect(target);
  }
  return (isFirst && CHANGING.has(global)) || changesHanded(call, walk) ? CHANGED : NONE;
}

/** What a call writes into a constant, or a member of it, it is handed — `node`. */
function handed(
  call: CallExpression | NewExpression,
  node: Expression,
  target: Target,
  walk: Walk,
): Writes {
  const callee = unwrapped(call.expression);
  const path = globalPath(callee);
  const method = path?.at(-1) ?? (isPropertyAccessExpression(callee) ? callee.name.text : '');
  if (CALLING_METHODS.has(method)) {
    return CHANGED;
  }
  const global = path?.join('.');
  if (global !== undefined) {
    return handedGlobal(global, call, node, { target, walk });
  }
  const given = call.arguments ?? [];
  const fn = isCallExpression(call) ? walk.calls.functionOf(callee) : undefined;
  const isWritten = fn !== undefined && changesParameters(fn, given, node, walk);
  return isWritten || changesHanded(call, walk) ? CHANGED : NONE;
}

/** Whether `fn`, called with `given`, writes into the parameters `node` is passed at. */
function changesParameters(
  fn: Answering,
  given: readonly Expression[],
  node: Expression,
  walk: Walk,
): boolean {
  return writesParameters(fn, walk, (index) => givenAt(given, fn, index).includes(node));
}

/** Whether an inline callback argument of `call` writes into its parameters. */
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

/** Container initializer propagated to a plain `const alias = member` binding when unreplaced. */
function aliasedHeldOf(target: Target): Expression | undefined {
  const found = unreplacedAt(target, target.keys);
  if (found === undefined) {
    return undefined;
  }
  if (isArrayLiteralExpression(found) && isShrunkAt(target, target.keys)) {
    return undefined;
  }
  return found;
}

/** What a name of the code's that holds a constant, or a member of it, writes into it. */
function heldBy(node: Expression, target: Target, walk: Walk): Writes {
  const { parent } = node;
  if (isVariableDeclaration(parent) && parent.initializer === node) {
    if (!isConstList(parent.parent)) {
      return CHANGED;
    }
    if (isIdentifier(parent.name)) {
      return writesOf(parent.name, aliasedHeldOf(target), walk);
    }
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
  if (!isConstList(list)) {
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
