/**
 * What may replace a native Map's, Set's, WeakMap's or WeakSet's methods where they live: on the
 * collection's prototype, written by any route the file shows, or on an instance's, by giving it
 * another prototype. A method read counts as native only where nothing here may replace it.
 */

import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isArrowFunction,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeNode,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { framedHeritageKept } from './framed-collection-heritage.ts';
import { DEFAULT_ITERATOR, iteratorMemberName } from './framed-iterator-guards.ts';
import { framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { readsBinding } from './scope.ts';

/** A value a write may install as a method, or none where the reader cannot read it. */
export type InstalledMethod = Expression | MethodDeclaration | undefined;

/** One write that may install a collection's method. */
interface Installation {
  /** The collection whose prototype it writes, or `null` for any, an instance's included. */
  readonly target: string | null;
  /** The member names it may write; none known means any. */
  readonly keys: readonly string[] | undefined;
  readonly value: InstalledMethod;
}

/** The native collections whose methods the readers trust. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
/** The global object's names. */
const GLOBAL_OBJECTS = new Set(['global', 'globalThis', 'self', 'window']);
/** The members whose replacement changes what a collection's iteration yields. */
const ITERATING = new Set([DEFAULT_ITERATOR, 'entries', 'forEach', 'keys', 'values']);
/** The mutators whose replacement changes what a collection stores. */
const MUTATORS = new Set(['add', 'clear', 'delete', 'set']);
/** The natives that write a member of an object, its first argument, under a key. */
const KEYED_WRITERS = new Set([
  'Object.defineProperty',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
]);
/** The natives that write members of their first argument, or give it another prototype. */
const WRITERS = new Set([
  ...KEYED_WRITERS,
  'Object.assign',
  'Object.defineProperties',
  'Object.setPrototypeOf',
  'Reflect.setPrototypeOf',
]);
/** The natives that answer an object's prototype, whose members may then be written unseen. */
const PROTOTYPE_READERS = new Set(['Object.getPrototypeOf', 'Reflect.getPrototypeOf']);
/** The operators that step a number, writing their operand. */
const STEPS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);
/** Comparisons, which read a value without handing it on. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
]);
/** Each file's installations, read once. */
const INSTALLED = new WeakMap<SourceFile, readonly Installation[]>();

/**
 * The values the file may install as the `member` of the native collection `constructor` reads:
 * on its prototype, written directly, through an alias or the global object, under a key the
 * reader cannot read, by `Object.defineProperty`, `Object.defineProperties`, `Object.assign`,
 * `Reflect.set` or `Reflect.defineProperty`, or deleted; on an instance, by `__proto__` or
 * `Object.setPrototypeOf`. None read (`undefined`) where the value cannot be read, and wherever
 * the constructor, its prototype or the global object is handed on, or a prototype is read off an
 * object, as what then writes it does so unseen. Empty where nothing may replace it.
 */
export function framedInstalledMethods(
  file: SourceFile,
  constructor: string,
  member: string,
): readonly InstalledMethod[] {
  return installationsOf(file)
    .filter((each) => {
      return (
        (each.target === null || each.target === constructor) &&
        (each.keys === undefined || each.keys.includes(member))
      );
    })
    .map((each) => each.value);
}

/**
 * Whether anything may replace a member the native `constructor`'s iteration reads (`ITERATING`),
 * or a mutator that stores what it yields (`framedMutatorsInstalled`).
 */
export function framedIterationInstalled(file: SourceFile, constructor: string): boolean {
  return installed(file, constructor, ITERATING) || framedMutatorsInstalled(file, constructor);
}

/**
 * Whether anything may replace a mutator of the native `constructor` (`MUTATORS`), `set`, `add`,
 * `delete` or `clear`, so that what it stores, or keeps, is not what the native one would.
 */
export function framedMutatorsInstalled(file: SourceFile, constructor: string): boolean {
  return installed(file, constructor, MUTATORS);
}

/**
 * Whether something the file may install on the native `constructor`'s prototype may, called on an
 * instance, write what it holds as its own, its own get among it: an installation whose value the
 * reader cannot read, or a function that reads its receiver (`readsReceiver`).
 */
export function framedReceiverInstalled(file: SourceFile, constructor: string): boolean {
  return installationsOf(file).some((each) => {
    return (
      (each.target === null || each.target === constructor) &&
      (each.value === undefined || readsReceiver(each.value))
    );
  });
}

/**
 * Whether an installed value may read the receiver it is called on: anything but an arrow, which
 * binds none, or a written function or method whose body reads neither `this` nor `arguments`.
 */
function readsReceiver(value: Expression | MethodDeclaration): boolean {
  const fn = isMethodDeclaration(value) ? value : unwrapped(value);
  if (isArrowFunction(fn)) return false;
  if (!isFunctionExpression(fn) && !isMethodDeclaration(fn)) return true;
  const pending: Node[] = fn.body === undefined ? [] : [fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) return true;
    if (isIdentifier(node) && node.text === 'arguments') return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether anything may install one of `members` for the native `constructor`. */
function installed(file: SourceFile, constructor: string, members: ReadonlySet<string>): boolean {
  return installationsOf(file).some((each) => {
    return (
      (each.target === null || each.target === constructor) &&
      (each.keys === undefined || each.keys.some((key) => members.has(key)))
    );
  });
}

/** Every installation the file may make, read once. */
function installationsOf(file: SourceFile): readonly Installation[] {
  const known = INSTALLED.get(file);
  if (known !== undefined) return known;
  const aliases = prototypeAliases(file);
  const found: Installation[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    // A class's `extends` entry runs as the class is declared; only its type arguments are erased.
    if (isTypeNode(node) && !isExpressionWithTypeArguments(node)) continue;
    found.push(...installedAt(node, aliases));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  INSTALLED.set(file, found);
  return found;
}

/** The installations one node may make. */
function installedAt(node: Node, aliases: PrototypeAliases): readonly Installation[] {
  if (isCallExpression(node)) return calledInstallations(node, aliases);
  if (isIdentifier(node)) {
    const handed = readsBinding(node) ? handedOn(node, aliases) : undefined;
    return handed === undefined ? [] : [{ target: handed, keys: undefined, value: undefined }];
  }
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return [];
  const handed = handedOn(node, aliases);
  if (handed !== undefined) return [{ target: handed, keys: undefined, value: undefined }];
  return writtenInstallations(node, aliases);
}

/**
 * What a write of a member installs: on a collection's prototype, its value under the member's
 * keys; and wherever `__proto__` is written, the members of the prototype it gives an instance.
 */
function writtenInstallations(
  member: PropertyAccessExpression | ElementAccessExpression,
  aliases: PrototypeAliases,
): readonly Installation[] {
  const written = writtenValue(member);
  if (written === undefined) return [];
  const keys = memberKeys(member);
  if (keys?.length === 1 && keys[0] === '__proto__') return prototypeMembers(written.value);
  const target = prototypeTarget(member.expression, aliases);
  return target === undefined ? [] : [{ target, keys, value: written.value }];
}

/** What a native writer call installs, or a native that reads a prototype off an object. */
function calledInstallations(
  call: CallExpression,
  aliases: PrototypeAliases,
): readonly Installation[] {
  const path = globalPathOf(unwrapped(call.expression))?.join('.') ?? '';
  if (PROTOTYPE_READERS.has(path)) return [{ target: null, keys: undefined, value: undefined }];
  if (!WRITERS.has(path)) return [];
  const [object, second, third] = call.arguments;
  if (object === undefined || call.arguments.some((each) => isSpreadElement(each)))
    return [{ target: null, keys: undefined, value: undefined }];
  if (path.endsWith('setPrototypeOf')) return prototypeMembers(second);
  const target = prototypeTarget(object, aliases);
  if (target === undefined) return [];
  if (KEYED_WRITERS.has(path)) {
    const keys = second === undefined ? undefined : keyNames(second);
    const value = path === 'Reflect.set' ? third : descriptorValue(third, path);
    return [{ target, keys, value }];
  }
  if (path === 'Object.defineProperties') return literalInstallations(second, target, true);
  return call.arguments.slice(1).flatMap((source) => literalInstallations(source, target, false));
}

/**
 * The members an object literal installs under its keys, each a value or, where `descriptors`, a
 * descriptor's; any key, unread, for another value, a spread or a key the reader cannot read.
 */
function literalInstallations(
  node: Expression | undefined,
  target: string | null,
  descriptors: boolean,
): readonly Installation[] {
  const object = node === undefined ? undefined : unwrapped(node);
  if (object === undefined || !isObjectLiteralExpression(object))
    return [{ target, keys: undefined, value: undefined }];
  return object.properties.map((property) => {
    if (isSpreadAssignment(property)) return { target, keys: undefined, value: undefined };
    const keys = propertyKeys(property.name);
    const value = propertyValue(property);
    if (!descriptors) return { target, keys, value };
    const descriptor =
      value === undefined || isMethodDeclaration(value)
        ? undefined
        : descriptorValue(value, 'Object.defineProperty');
    return { target, keys, value: descriptor };
  });
}

/** The members a prototype given to an instance supplies, which then shadow the native ones. */
function prototypeMembers(node: Expression | undefined): readonly Installation[] {
  return literalInstallations(node, null, false);
}

/** A property's written value: an assignment's, a shorthand's name, a method; none of an accessor. */
function propertyValue(property: ObjectLiteralExpression['properties'][number]): InstalledMethod {
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property))
    return isIdentifier(property.name) ? property.name : undefined;
  if (isMethodDeclaration(property)) return property;
  return undefined;
}

/** A property name's possible keys; none for a computed key the reader cannot read. */
function propertyKeys(name: PropertyName | undefined): readonly string[] | undefined {
  if (name === undefined) return undefined;
  if (isComputedPropertyName(name)) return keyNames(name.expression);
  const key = writtenArrayKey(name);
  return key === undefined ? undefined : [key];
}

/** The value a descriptor installs: its `value`; none read for an accessor or another value. */
function descriptorValue(node: Expression | undefined, path: string): InstalledMethod {
  if (path === 'Reflect.deleteProperty' || node === undefined) return undefined;
  const descriptor = unwrapped(node);
  if (!isObjectLiteralExpression(descriptor)) return undefined;
  let value: InstalledMethod;
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const key = propertyKeys(property.name);
    if (key === undefined || key.includes('get') || key.includes('set')) return undefined;
    if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) return undefined;
    if (key.includes('value')) value = propertyValue(property);
  }
  return value;
}

/** A key argument's possible names: `Symbol.iterator`'s, or the text it holds; none unread. */
function keyNames(key: Expression): readonly string[] | undefined {
  if (framedNativeConstructor(key, new Set([DEFAULT_ITERATOR]))) return [DEFAULT_ITERATOR];
  return framedKeyNames(key);
}

/** A member's possible keys, `Symbol.iterator` among them; none for one the reader cannot read. */
function memberKeys(member: Expression): readonly string[] | undefined {
  const iterating = iteratorMemberName(member);
  return iterating === undefined ? framedMemberNames(member) : [iterating];
}

/**
 * Whether a member is written, and with what: a plain assignment's value, or none read for another
 * operator, a destructuring or a loop's head, `delete`, `++` and `--`.
 */
function writtenValue(member: Expression): { readonly value: Expression | undefined } | undefined {
  const { at, parent, held } = patternUse(member);
  if (isBinaryExpression(parent)) {
    if (parent.left !== at || !isAssignment(parent.operatorToken.kind)) return undefined;
    const plain = !held && parent.operatorToken.kind === SyntaxKind.EqualsToken;
    return { value: plain ? parent.right : undefined };
  }
  if (isForOfStatement(parent) || isForInStatement(parent))
    return parent.initializer === at ? { value: undefined } : undefined;
  if (held) return undefined;
  if (isDeleteExpression(parent)) return { value: undefined };
  return (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    STEPS.has(parent.operator)
    ? { value: undefined }
    : undefined;
}

/**
 * Where a member is used past the patterns that may hold it, an array literal's element, a spread
 * or a property's value, and whether one does (`held`).
 */
function patternUse(member: Expression): {
  readonly at: Node;
  readonly parent: Node;
  readonly held: boolean;
} {
  let use = useOf(member);
  let held = false;
  for (;;) {
    const { at, parent } = use;
    if (isPropertyAssignment(parent) && parent.initializer === at) use = useOf(parent.parent);
    else if (isSpreadElement(parent) || isArrayLiteralExpression(parent)) use = useOf(parent);
    else return { ...use, held };
    held = true;
  }
}

/** Whether an operator writes its left operand. */
function isAssignment(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/** Each name that holds a collection's prototype, and whose: a whole declaration's or assignment's. */
type PrototypeAliases = ReadonlyMap<FrameBinding, string | null>;

/**
 * The names the file gives a collection's prototype, in turn, and the prototype each holds: a
 * `const`'s one initializer's; any (`null`) of a name declared otherwise or assigned, which may
 * hold another in turn, or of one that may hold more than one.
 */
function prototypeAliases(file: SourceFile): PrototypeAliases {
  const aliases = new Map<FrameBinding, string | null>();
  for (let grown = true; grown;) {
    grown = false;
    const pending: Node[] = [file];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const made = aliasMade(node, aliases);
      if (made !== undefined) {
        const known = aliases.has(made.binding);
        const held = aliases.get(made.binding);
        // A name that may hold two prototypes may hold any.
        const target = !known || held === made.target ? made.target : null;
        if (!known || held !== target) {
          aliases.set(made.binding, target);
          grown = true;
        }
      }
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return aliases;
}

/** The name a declaration or a plain assignment gives a collection's prototype, and whose. */
function aliasMade(
  node: Node,
  aliases: PrototypeAliases,
): { readonly binding: FrameBinding; readonly target: string | null } | undefined {
  const made = madeAlias(node);
  if (made === undefined) return undefined;
  const target = prototypeTarget(made.value, aliases);
  if (target === undefined) return undefined;
  // A whole `const` holds its one initializer; any other name may be given another in turn.
  return { binding: made.binding, target: constantInitializer(node) === undefined ? null : target };
}

/** The name a declaration or a plain assignment gives a value, and the value. */
function madeAlias(
  node: Node,
): { readonly binding: FrameBinding; readonly value: Expression } | undefined {
  if (isVariableDeclaration(node))
    return node.initializer === undefined ? undefined : { binding: node, value: node.initializer };
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const target = unwrapped(node.left);
  const selected = isIdentifier(target) ? frameBindingOf(target) : undefined;
  return selected?.keys.length === 0 ? { binding: selected.binding, value: node.right } : undefined;
}

/**
 * Whose prototype an expression may be: a collection's, read as `X.prototype` of a collection
 * constructor or through a name that holds one; `null` for `prototype` of anything else the reader
 * cannot prove is no collection, and for what `__proto__` reads off any value, its prototype, an
 * instance's a collection's, as `Object.getPrototypeOf` answers; none for anything else.
 */
function prototypeTarget(node: Expression, aliases: PrototypeAliases): string | null | undefined {
  const value = framedQuietOperand(node);
  if (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    return selected?.keys.length === 0 ? aliases.get(selected.binding) : undefined;
  }
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
  const keys = memberKeys(value) ?? [];
  if (keys.includes('__proto__')) return null;
  if (!keys.includes('prototype')) return undefined;
  const owner = unwrapped(value.expression);
  return collectionOf(owner) ?? (otherConstructor(owner) ? undefined : null);
}

/**
 * The collection a constructor read names: `Map`, `Set`, `WeakMap` or `WeakSet`, through whole
 * `const` aliases and the global object, an alias of it among them.
 */
function collectionOf(node: Node): string | undefined {
  const value = unwrapped(node as Expression);
  if (isIdentifier(value)) {
    const read = namedReferent(value);
    return read?.kind === 'collection' ? read.name : undefined;
  }
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
  const [global, ...rest] = globalPathOf(value) ?? [];
  if (global !== undefined && rest.length === 0 && COLLECTIONS.has(global)) return global;
  const [key, ...others] = memberKeys(value) ?? [];
  return key !== undefined &&
    others.length === 0 &&
    COLLECTIONS.has(key) &&
    globalObject(value.expression)
    ? key
    : undefined;
}

/** Whether a read is of the global object, through whole `const` aliases. */
function globalObject(node: Expression): boolean {
  const value = unwrapped(node);
  return isIdentifier(value) && namedReferent(value)?.kind === 'global';
}

/** What a name reads of what may reach a collection's prototype. */
type Referent =
  | { readonly kind: 'collection'; readonly name: string }
  | { readonly kind: 'global' };

/**
 * What a name reads: a collection constructor or the global object, as a global the file does not
 * bind, or through a whole `const` alias of one; none for anything else.
 */
function namedReferent(name: Expression): Referent | undefined {
  let value = name;
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (declared === undefined) return globalReferent(value);
    const initializer = constantInitializer(declared);
    if (initializer === undefined) return undefined;
    const collection = isIdentifier(initializer) ? undefined : collectionOf(initializer);
    if (collection !== undefined) return { kind: 'collection', name: collection };
    value = initializer;
  }
  return undefined;
}

/** What a global the file does not bind is: a collection constructor, or the global object. */
function globalReferent(name: Expression & { readonly text: string }): Referent | undefined {
  if (globalPathOf(name) === undefined) return undefined;
  if (COLLECTIONS.has(name.text)) return { kind: 'collection', name: name.text };
  return GLOBAL_OBJECTS.has(name.text) ? { kind: 'global' } : undefined;
}

/** A whole `const` name's initializer, past what wraps it; none for any other declaration. */
function constantInitializer(declared: Node): Expression | undefined {
  return isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\b/u.test(declared.parent.getText(declared.getSourceFile())) &&
    declared.initializer !== undefined
    ? unwrapped(declared.initializer)
    : undefined;
}

/** Whether a constructor read is proved no collection's: another global's, a local class or function. */
function otherConstructor(node: Expression): boolean {
  const [global, ...rest] = globalPathOf(node) ?? [];
  if (global !== undefined) return rest.length > 0 || !COLLECTIONS.has(global);
  if (!isIdentifier(node)) return false;
  const declared = frameDeclarationOf(node);
  if (declared === undefined) return false;
  if (isClassDeclaration(declared) || isFunctionDeclaration(declared)) return true;
  const value = constantInitializer(declared);
  return (
    value !== undefined &&
    (isClassExpression(value) || isFunctionExpression(value) || isArrowFunction(value))
  );
}

/**
 * Whose methods a read hands on, where it may reach a collection's prototype by a path the names
 * in sight do not show: a collection constructor, its prototype or the global object read other
 * than by a member the code names, called or constructed, tested, compared, or made a whole
 * alias; and a collection constructor or the global object read by a key the reader cannot read.
 * A native writer's own object is read by the writer (`calledInstallations`). None otherwise.
 */
function handedOn(node: Expression, aliases: PrototypeAliases): string | null | undefined {
  const reached = reachedPrototype(node, aliases);
  if (reached === undefined) return undefined;
  const { at, parent } = useOf(node);
  return keptUse(parent, at, reached.prototype) ? undefined : reached.target;
}

/**
 * Whether a read keeps what it reads to itself: by a member the code names, or any member of a
 * prototype, whose writes `writtenInstallations` reads; called or constructed, a constructor; a
 * class's `extends` entry whose body keeps it (`framedHeritageKept`); a native writer's object;
 * tested or compared; or made a whole alias (`aliasUse`).
 */
function keptUse(parent: Node, at: Node, prototype: boolean): boolean {
  if (!prototype && isExpressionWithTypeArguments(parent) && parent.expression === at)
    return framedHeritageKept(parent);
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  )
    return prototype || memberKeys(parent) !== undefined;
  if ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at)
    return !prototype;
  if (isCallExpression(parent) && writerCall(parent)) {
    const [object] = parent.arguments;
    if (object !== undefined && object === at) return true;
  }
  return testedUse(parent) || aliasUse(parent, at, prototype);
}

/** Whether a use tests or compares a value: `typeof`, `void`, `!` and the comparisons. */
function testedUse(parent: Node): boolean {
  if (isTypeOfExpression(parent) || isVoidExpression(parent)) return true;
  if (isPrefixUnaryExpression(parent)) return parent.operator === SyntaxKind.ExclamationToken;
  return isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind);
}

/**
 * What a read may reach a collection's prototype through: a collection constructor, its own; the
 * global object, any (`null`); a prototype, its collection's or any (`prototypeTarget`).
 */
function reachedPrototype(
  node: Expression,
  aliases: PrototypeAliases,
): { readonly target: string | null; readonly prototype: boolean } | undefined {
  const collection = collectionOf(node);
  if (collection !== undefined) return { target: collection, prototype: false };
  if (globalObject(node)) return { target: null, prototype: false };
  const prototype = prototypeTarget(node, aliases);
  return prototype === undefined ? undefined : { target: prototype, prototype: true };
}

/** Whether a call is a native writer's, which reads its first argument itself. */
function writerCall(call: CallExpression): boolean {
  return WRITERS.has(globalPathOf(unwrapped(call.expression))?.join('.') ?? '');
}

/**
 * Whether a read makes a whole alias: of a prototype, any declaration or plain assignment of a
 * name, which `prototypeAliases` tracks; of a constructor or the global object, a whole `const`
 * declaration, which `framedNativeConstructor` reads through.
 */
function aliasUse(parent: Node, at: Node, prototype: boolean): boolean {
  if (isVariableDeclaration(parent))
    return (
      parent.initializer !== undefined &&
      parent.initializer === at &&
      isIdentifier(parent.name) &&
      (prototype ||
        (isVariableDeclarationList(parent.parent) &&
          /^const\b/u.test(parent.parent.getText(parent.getSourceFile()))))
    );
  return (
    prototype &&
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.right === at &&
    isIdentifier(unwrapped(parent.left))
  );
}
