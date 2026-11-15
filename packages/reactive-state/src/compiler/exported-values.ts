import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type Expression,
  type FunctionDeclaration,
  type GetAccessorDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { type DeclaredValue, exportedValue, settledValue } from './exported-bindings.ts';
import {
  isPrototypeEntry,
  laterPrototypeWork,
  prototypeInitializer,
} from './exported-prototypes.ts';
import type { Modules } from './modules.ts';
import { freeReads } from './scope.ts';

/**
 * What a value an application's module exports is, where the module declares it — followed through
 * `export { … }`, `export … from`, `export *` and what the module itself imports (`exported-bindings.ts`) —
 * and what an entry of the objects and the arrays it writes holds, as the compile reads what a site's
 * element is given of it (`json-values.ts`): a function a `shared` module exports, or a date it holds,
 * is no JSON a reactive component is rendered with.
 */

/**
 * What an entry of an object a module writes holds: its value, the method it is, or the accessor
 * that answers it, read.
 */
export type MemberValue = DeclaredValue | GetAccessorDeclaration | MethodDeclaration;

/**
 * What `file` exports as `name`, read at each of `keys` in turn — `when` of `payload.when`, of
 * `export const payload = { when: … }` — through the objects and the arrays its modules write, an
 * entry's value as its own module declares it; none where one is written otherwise: of a call, of
 * an entry a spread or a key the code computes may write, or of an accessor, which computes it.
 */
export function exportedMember(
  modules: Modules,
  file: string,
  name: string,
  keys: readonly string[],
): MemberValue | undefined {
  let value: MemberValue | undefined = exportedValue(modules, file, name);
  for (const key of keys) {
    if (value === undefined) {
      return undefined;
    }
    value = entryOf(modules, value, key);
  }
  return value;
}

/**
 * What the name `name` holds where its module writes it, as an export of it is read (`settledValue`):
 * a constant's initializer, a function's or a class's declaration, what an import binds, a global
 * itself — none of a name the module declares otherwise, a variable's, a parameter's.
 */
function declaredBy(modules: Modules, name: Identifier): DeclaredValue | undefined {
  return settledValue(modules, name);
}

/** What the name `name` holds where its module declares it a constant (`declaredBy`); none of another. */
export function moduleValue(modules: Modules, name: Identifier): Expression | undefined {
  const found = declaredBy(modules, name);
  return found === undefined || isDeclaration(found) ? undefined : found;
}

/** The function the name `name` is of where its module declares it (`declaredBy`); none of another. */
export function moduleFunction(
  modules: Modules,
  name: Identifier,
): FunctionDeclaration | undefined {
  const found = readsModuleName(name) ? declaredBy(modules, name) : undefined;
  return found !== undefined && isFunctionDeclaration(found) ? found : undefined;
}

const MODULE_READS = new WeakMap<Node, ReadonlySet<Identifier>>();

/** A module name remains free inside its top-level statement, beyond nested parameters and locals. */
function readsModuleName(name: Identifier): boolean {
  let statement: Node = name;
  while (!isSourceFile(statement.parent)) {
    statement = statement.parent;
  }
  let reads = MODULE_READS.get(statement);
  if (reads === undefined) {
    reads = new Set(freeReads(statement));
    MODULE_READS.set(statement, reads);
  }
  return reads.has(name);
}

/** Whether the name `name` is of a function or a class its module declares (`declaredBy`). */
export function isModuleDeclaration(modules: Modules, name: Identifier): boolean {
  const found = declaredBy(modules, name);
  return found !== undefined && isDeclaration(found);
}

/** Whether what a module declares is a function's, a class's or a method's declaration, no value. */
export function isDeclaration(
  value: MemberValue,
): value is ClassDeclaration | FunctionDeclaration | MethodDeclaration {
  return isFunctionDeclaration(value) || isClassDeclaration(value) || isMethodDeclaration(value);
}

/** The key text or a number writes: `'when'`, `1` of `1.0`; none of another. */
export function literalKey(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/**
 * The keys `node` reads in turn, by name or by text or a number in brackets, and what it reads the
 * first of: `['when']` and `payload` of `payload.when`, none and `node` of anything else.
 */
export function memberPath(node: Expression): {
  readonly keys: readonly string[];
  readonly root: Expression;
} {
  const keys: string[] = [];
  let root = unwrapped(node);
  for (;;) {
    let key: string | undefined;
    if (isPropertyAccessExpression(root)) {
      key = root.name.text;
    } else if (isElementAccessExpression(root)) {
      key = literalKey(unwrapped(root.argumentExpression));
    }
    if (
      key === undefined ||
      !(isPropertyAccessExpression(root) || isElementAccessExpression(root))
    ) {
      return { keys, root };
    }
    keys.unshift(key);
    root = unwrapped(root.expression);
  }
}

/** What `value` holds at `key`: an entry of the object it writes, or an element of the array. */
function entryOf(modules: Modules, value: MemberValue, key: string): MemberValue | undefined {
  if (
    isFunctionDeclaration(value) ||
    isClassDeclaration(value) ||
    isMethodDeclaration(value) ||
    isGetAccessorDeclaration(value)
  ) {
    return undefined;
  }
  const written = unwrapped(value);
  if (isObjectLiteralExpression(written)) {
    return objectEntry(written, key, modules);
  }
  return isArrayLiteralExpression(written) ? arrayElement(written, key, modules) : undefined;
}

/**
 * What an object the code writes holds at a key, as `entryIn` reads it: what of its properties
 * writes it last, `held` — of `value`, none where that is a setter alone — a setter, `set`, which
 * the getter beside it answers; that none does, `none`; or that the compile cannot tell, `untold`,
 * of a spread or a key it cannot read, which may.
 */
interface Lookup {
  readonly kind: 'held' | 'none' | 'set' | 'untold';
  readonly value?: MemberValue | undefined;
  /** Whether what holds it is a getter, which a setter after it defines the entry with. */
  readonly getter?: boolean;
}

const NONE: Lookup = { kind: 'none' };
const UNTOLD: Lookup = { kind: 'untold' };

/** The deepest spreads `entryIn` reads into. */
const MAX_SPREADS = 16;

/**
 * The entry `key` of an object the code writes, of the last property that writes it: its value, as
 * the module declares it, the method, or the getter; none of a spread or a key the code computes
 * that may write it (`entryIn`).
 */
function objectEntry(
  object: ObjectLiteralExpression,
  key: string,
  modules: Modules,
): MemberValue | undefined {
  let current = object;
  const seen = new Set<ObjectLiteralExpression>();
  while (!seen.has(current)) {
    seen.add(current);
    const found = entryIn(current, key, modules, 0);
    if (found.kind !== 'none') {
      return found.kind === 'held' ? found.value : undefined;
    }
    const expression = prototypeInitializer(current);
    const prototype =
      expression === undefined || laterPrototypeWork(current)
        ? undefined
        : settledValue(modules, expression);
    if (prototype === undefined || isDeclaration(prototype)) {
      return undefined;
    }
    const value = unwrapped(prototype);
    if (!isObjectLiteralExpression(value) || laterPrototypeWork(value)) {
      return undefined;
    }
    current = value;
  }
  return undefined;
}

/**
 * What `object` holds at `key` (`Lookup`), of its properties, last first (`propertyEntry`): past
 * what writes none of it; a setter defines the entry with the getter beside it, and none where
 * there is none, which what writes it before the setter would.
 */
function entryIn(
  object: ObjectLiteralExpression,
  key: string,
  modules: Modules,
  depth: number,
): Lookup {
  let isSet = false;
  for (const property of object.properties.toReversed()) {
    const found = propertyEntry(property, key, modules, depth);
    if (found.kind === 'set') {
      isSet = true;
    } else if (found.kind !== 'none') {
      return !isSet || found.kind === 'untold' || found.getter === true
        ? found
        : { kind: 'held', value: undefined };
    }
  }
  return isSet ? { kind: 'held', value: undefined } : NONE;
}

/**
 * What `property` writes at `key` (`Lookup`): a spread, what what it spreads holds
 * (`spreadEntry`); a property of another key, or of a key the code computes of a constant of other
 * text, none; one of a key the compile cannot read, untold.
 */
function propertyEntry(
  property: ObjectLiteralElementLike,
  key: string,
  modules: Modules,
  depth: number,
): Lookup {
  if (isSpreadAssignment(property)) {
    return spreadEntry(property.expression, key, modules, depth + 1);
  }
  if (isPrototypeEntry(property)) {
    return NONE;
  }
  const name = keyOf(property.name, modules);
  if (name === undefined) {
    return UNTOLD;
  }
  if (name !== key) {
    return NONE;
  }
  if (isSetAccessorDeclaration(property)) {
    return { kind: 'set' };
  }
  return {
    getter: isGetAccessorDeclaration(property),
    kind: 'held',
    value: propertyValue(property, modules),
  };
}

/**
 * What a spread of `expression` writes at `key` (`Lookup`): of an object the code writes, what it
 * holds; of `null` or `undefined`, none; of an array, none but at an index; anything else, untold.
 */
function spreadEntry(expression: Expression, key: string, modules: Modules, depth: number): Lookup {
  const value = depth > MAX_SPREADS ? undefined : settledValue(modules, expression);
  if (value === undefined || isFunctionDeclaration(value) || isClassDeclaration(value)) {
    return UNTOLD;
  }
  const written = unwrapped(value);
  if (isObjectLiteralExpression(written)) {
    const found = entryIn(written, key, modules, depth);
    // What a spread writes, it writes as an entry of its own: a getter's answer, as it reads.
    return found.kind === 'held' ? { kind: 'held', value: found.value } : found;
  }
  if (isArrayLiteralExpression(written)) {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? UNTOLD : NONE;
  }
  const isNothing =
    written.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(written) && globalOf(written) === 'undefined');
  return isNothing ? NONE : UNTOLD;
}

/** What an object's property holds, as `objectEntry` reads it: a getter, as what it answers. */
function propertyValue(
  property: ObjectLiteralElementLike,
  modules: Modules,
): MemberValue | undefined {
  if (isPropertyAssignment(property)) {
    return settledValue(modules, property.initializer);
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? settledValue(modules, property.name) : undefined;
  }
  return isMethodDeclaration(property) || isGetAccessorDeclaration(property) ? property : undefined;
}

/**
 * The key a property is written with, a name or what `literalKey` reads, in brackets too — of a
 * constant its module declares of one, `[KEY]` of `const KEY = 'when'`.
 */
function keyOf(name: Node | undefined, modules: Modules): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (!isComputedPropertyName(name)) {
    return isIdentifier(name) ? name.text : literalKey(name);
  }
  const computed = unwrapped(name.expression);
  if (!isIdentifier(computed)) {
    return literalKey(computed);
  }
  const held = settledValue(modules, computed);
  return held === undefined || isFunctionDeclaration(held) || isClassDeclaration(held)
    ? undefined
    : literalKey(unwrapped(held));
}

/** The element at the index `key` of an array the code writes: none past a spread, nor of a hole. */
function arrayElement(
  array: ArrayLiteralExpression,
  key: string,
  modules: Modules,
): MemberValue | undefined {
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
    return undefined;
  }
  const elements = array.elements.slice(0, index + 1);
  const element = elements[index];
  return element === undefined ||
    isOmittedExpression(element) ||
    elements.some((each) => isSpreadElement(each))
    ? undefined
    : settledValue(modules, element);
}

/** Whether the file `name` stands in imports it: `import name`, `{ name }`, `* as name`. */
export function isImportBinding(name: Identifier): boolean {
  return name.getSourceFile().statements.some((statement) => {
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined || clause.name?.text === name.text) {
      return clause !== undefined;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      return false;
    }
    return isNamedImports(bindings)
      ? bindings.elements.some((each) => each.name.text === name.text)
      : bindings.name.text === name.text;
  });
}
