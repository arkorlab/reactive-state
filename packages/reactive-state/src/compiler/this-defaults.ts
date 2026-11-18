import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { runsPerCall } from './kept.ts';
import { freeReads } from './scope.ts';
import {
  advanceRestStep,
  bindingSteps,
  type DefaultWalk,
  finalizeRestPath,
  isNonNegativeIndex,
  shiftedStepKey,
  unchangedLocalInitializer,
} from './this-rest-defaults.ts';

/** A missing property differs from a getter or an unproven member. */
const MISSING = { kind: 'missing' } as const;
type Selection = Expression | typeof MISSING | undefined;
const APPLICATIONS = new WeakMap<SourceFile, boolean>();
const ESCAPED = new WeakMap<ObjectLiteralExpression, boolean>();
const INHERITED = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** A chosen default contributes a fresh value rather than the receiver's existing reference. */
export function freshReceiverDefault(
  name: Identifier,
  source: Expression,
  path: readonly (string | undefined)[],
): boolean {
  const steps = bindingSteps(name);
  if (steps.every((step) => step.initializer === undefined)) {
    return false;
  }
  const walk: DefaultWalk = {
    chosen: false,
    excluded: undefined,
    offset: 0,
    value: receiverLiteral(source),
  };
  for (const step of steps) {
    if (!advanceStep(step, walk, name)) {
      return false;
    }
  }
  if (!walk.chosen || walk.value === undefined) {
    return false;
  }
  const adjusted = finalizeRestPath(name, walk, path);
  return adjusted !== undefined && freshValue(walk.value, adjusted, name);
}

/** The member a reference selects without evaluating a computed key. */
export function receiverKey(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return isElementAccessExpression(node)
    ? literalKey(unwrapped(node.argumentExpression))
    : undefined;
}

/** Advances `walk` across one destructuring `BindingElement`, handling defaults and rest patterns. */
function advanceStep(step: BindingElement, walk: DefaultWalk, name: Identifier): boolean {
  const current =
    walk.chosen && walk.value !== undefined ? projectedValue(walk.value, [], name) : walk.value;
  if (current === undefined) {
    return false;
  }
  if (step.dotDotDotToken !== undefined) {
    return advanceRestStep(step, unwrapped(current), walk);
  }
  const key = shiftedStepKey(step, walk.offset);
  const selected = key === undefined ? undefined : selectedOf(current, key);
  if (selected === undefined) {
    return false;
  }
  walk.offset = 0;
  walk.excluded = undefined;
  if (selected.kind === MISSING.kind || undefinedValue(selected)) {
    if (step.initializer === undefined) {
      return false;
    }
    walk.value = step.initializer;
    walk.chosen = true;
    return true;
  }
  walk.value = selected;
  return true;
}

/** A receiver's unchanged written object, including a projection of one of its data members. */
function receiverLiteral(source: Expression): Expression | undefined {
  let value = unwrapped(source);
  const path: (string | undefined)[] = [];
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      path.unshift(receiverKey(value));
      value = unwrapped(value.expression);
      continue;
    }
    if (isIdentifier(value)) {
      const held = initializerOf(value);
      if (held === undefined) {
        return undefined;
      }
      value = unwrapped(held);
      continue;
    }
    if (value.kind !== SyntaxKind.ThisKeyword) {
      return undefined;
    }
    const owner = functionOf(value);
    const object = owner?.parent;
    if (
      object === undefined ||
      !isObjectLiteralExpression(object) ||
      moduleApplications(object.getSourceFile()) ||
      escapes(object)
    ) {
      return undefined;
    }
    return projectedValue(object, path);
  }
  return undefined;
}

/** Written data members only; getters, spreads and custom prototypes retain uncertainty. */
function selectedOf(node: Expression, key: string): Selection {
  const value = unwrapped(node);
  if (isArrayLiteralExpression(value) && !value.elements.some((each) => isSpreadElement(each))) {
    return isNonNegativeIndex(key) ? (value.elements[Number(key)] ?? MISSING) : undefined;
  }
  return isObjectLiteralExpression(value) ? objectMember(value, key) : undefined;
}

/** A surviving ordinary own data value or a proven absent ordinary property. */
function objectMember(value: ObjectLiteralExpression, key: string): Selection {
  let found: Selection = MISSING;
  let prototype = false;
  for (const property of value.properties) {
    if (
      isSpreadAssignment(property) ||
      isGetAccessorDeclaration(property) ||
      isSetAccessorDeclaration(property)
    ) {
      return undefined;
    }
    const name = propertyName(property.name);
    if (name === undefined) {
      return undefined;
    }
    if (name === '__proto__' && !isComputedPropertyName(property.name)) {
      prototype = true;
    }
    if (name === key) {
      found = isPropertyAssignment(property) ? property.initializer : shorthandValue(property);
    }
  }
  return found?.kind === MISSING.kind && (prototype || INHERITED.has(key)) ? undefined : found;
}

/** A shorthand reads its lexical value; methods and accessors do not establish a default. */
function shorthandValue(node: Node): Expression | undefined {
  return isShorthandPropertyAssignment(node) && isIdentifier(node.name) ? node.name : undefined;
}

/** A member name whose value is written directly. */
function propertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? unwrapped(name.expression) : name);
}

/** Literal property-key text, without application evaluation or conversions. */
function literalKey(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/** A written value whose selection invokes the binding's default. */
function undefinedValue(node: Expression): boolean {
  const value = unwrapped(node);
  return isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined';
}

/** A data projection inside a fresh default preserves only references it explicitly contains. */
function freshValue(
  value: Expression,
  path: readonly (string | undefined)[],
  name: Identifier,
): boolean {
  const held = projectedValue(value, path, name);
  return held !== undefined && (isObjectLiteralExpression(held) || isArrayLiteralExpression(held));
}

/** Literal/local-constant projections; a module-held or unknown value stays unproven. */
function projectedValue(
  node: Expression,
  path: readonly (string | undefined)[],
  local?: Identifier,
): Expression | undefined {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  let index = 0;
  while (!seen.has(value)) {
    seen.add(value);
    if (isIdentifier(value)) {
      const initializer =
        local === undefined
          ? undefined
          : unchangedLocalInitializer(value, functionOf(local), functionOf);
      if (initializer === undefined) {
        return undefined;
      }
      value = unwrapped(initializer);
      continue;
    }
    if (index >= path.length) {
      return value;
    }
    const key = path[index];
    index += 1;
    const selected = key === undefined ? undefined : selectedOf(value, key);
    if (selected === undefined || selected.kind === MISSING.kind) {
      return undefined;
    }
    value = unwrapped(selected);
  }
  return undefined;
}

/** The executing function which creates a local value, rather than a surrounding module. */
function functionOf(node: Node): Node | undefined {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (
      isMethodDeclaration(at) ||
      isFunctionDeclaration(at) ||
      isFunctionExpression(at) ||
      isArrowFunction(at) ||
      isConstructorDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at)
    ) {
      return at;
    }
  }
  return undefined;
}

/** Passing a receiver to application code leaves its later member set unproven. */
function escapes(object: ObjectLiteralExpression): boolean {
  const cached = ESCAPED.get(object);
  if (cached !== undefined) {
    return cached;
  }
  if (!isVariableDeclaration(object.parent)) {
    return true;
  }
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    const given = isCallExpression(node) || isNewExpression(node) ? node.arguments : undefined;
    if (given !== undefined) {
      found = given.some((argument) => referencesObject(argument, object));
    } else if (isTaggedTemplateExpression(node)) {
      found = referencesObject(node.template, object);
    }
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(object.getSourceFile());
  ESCAPED.set(object, found);
  return found;
}

/** A direct or constant-aliased reference to the receiver in an application's argument. */
function referencesObject(node: Node, object: ObjectLiteralExpression): boolean {
  for (const read of freeReads(node)) {
    const seen = new Set<Expression>();
    let value: Expression = read;
    while (isIdentifier(value) && !seen.has(value)) {
      seen.add(value);
      const held = initializerOf(value);
      if (held === undefined) {
        break;
      }
      value = unwrapped(held);
    }
    if (value === object) {
      return true;
    }
  }
  return false;
}

/** Module-load application code can add a receiver member before any later method call. */
function moduleApplications(file: SourceFile): boolean {
  const cached = APPLICATIONS.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    found =
      (isCallExpression(node) ||
        isNewExpression(node) ||
        isPropertyAccessExpression(node) ||
        isElementAccessExpression(node) ||
        isTaggedTemplateExpression(node)) &&
      !runsPerCall(node);
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(file);
  APPLICATIONS.set(file, found);
  return found;
}
