import {
  type ArrayBindingPattern,
  type ArrayLiteralExpression,
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclarationList,
  type Node,
  type ObjectBindingPattern,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayIndex } from './proxy-arrays.ts';
import { type Origin, propertyKey, type ProxyReading } from './proxy-values.ts';
import { hoistedIn } from './scope.ts';

/** Assignment operators whose right-hand expression can become the target binding's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether a hoisted `var` binding name (identifier or pattern) declares `targetText`. */
export function bindsHoistedName(name: BindingName, targetText: string): boolean {
  if (isIdentifier(name)) {
    return name.text === targetText;
  }
  if (isArrayBindingPattern(name)) {
    return name.elements.some(
      (element) => !isOmittedExpression(element) && bindsHoistedName(element.name, targetText),
    );
  }
  return name.elements.some((element) => bindsHoistedName(element.name, targetText));
}

/** Collects origins written by hoisted `var` initializers and `for (var ...)` loop headers. */
export function hoistedParameterOrigins(
  body: Node,
  targetText: string,
  at: Origin,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const declaration of hoistedIn([body])) {
    if (!bindsHoistedName(declaration.name, targetText)) {
      continue;
    }
    if (declaration.initializer !== undefined) {
      const source: Origin = {
        ...at,
        excluded: undefined,
        keys: [],
        spread: undefined,
        value: declaration.initializer,
      };
      found.push(...bindingNameOrigins(declaration.name, source, at, targetText));
      continue;
    }
    const loop = declaration.parent.parent;
    if (isForOfStatement(loop)) {
      const source: Origin = {
        ...at,
        excluded: undefined,
        keys: [null],
        spread: undefined,
        value: loop.expression,
      };
      found.push(...bindingNameOrigins(declaration.name, source, at, targetText));
    } else if (isForInStatement(loop)) {
      found.push(...bindingNameOrigins(declaration.name, undefined, at, targetText));
    }
  }
  return found;
}

/** Extracts parameter write origins from one assignment expression or `for..of`/`for..in` node. */
export function nodeAssignedOrigins(
  node: Node,
  isRead: (candidate: Node) => candidate is Identifier,
  at: Origin,
): readonly Origin[] {
  if (isBinaryExpression(node) && VALUE_ASSIGNMENTS.has(node.operatorToken.kind)) {
    if (node.operatorToken.kind !== SyntaxKind.EqualsToken) {
      return isRead(unwrapped(node.left)) ? [{ ...at, value: node.right }] : [];
    }
    const source: Origin = {
      ...at,
      excluded: undefined,
      keys: [],
      spread: undefined,
      value: node.right,
    };
    return patternTargetOrigins(node.left, source, at, isRead);
  }
  if (isForOfStatement(node) && !isVariableDeclarationList(node.initializer)) {
    const source: Origin = {
      ...at,
      excluded: undefined,
      keys: [null],
      spread: undefined,
      value: node.expression,
    };
    return patternTargetOrigins(node.initializer, source, at, isRead);
  }
  if (isForInStatement(node) && !isVariableDeclarationList(node.initializer)) {
    return patternTargetOrigins(node.initializer, undefined, at, isRead);
  }
  return [];
}

/** Projects a `BindingName` (`var` identifier or destructuring pattern) against `source`. */
function bindingNameOrigins(
  pattern: BindingName,
  source: Origin | undefined,
  readAt: Origin,
  targetText: string,
): readonly Origin[] {
  if (isIdentifier(pattern)) {
    return pattern.text === targetText && source !== undefined
      ? [projectReadOrigin(source, readAt)]
      : [];
  }
  if (isArrayBindingPattern(pattern)) {
    return arrayBindingOrigins(pattern, source, readAt, targetText);
  }
  return objectBindingOrigins(pattern, source, readAt, targetText);
}

/** Projects elements and defaults of an `ArrayBindingPattern` for `targetText`. */
function arrayBindingOrigins(
  pattern: ArrayBindingPattern,
  source: Origin | undefined,
  readAt: Origin,
  targetText: string,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const [index, element] of pattern.elements.entries()) {
    if (isOmittedExpression(element) || !bindsHoistedName(element.name, targetText)) {
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      found.push(...restSliceOrigins(source, readAt));
      continue;
    }
    const nextSource =
      source === undefined ? undefined : { ...source, keys: [...source.keys, String(index)] };
    found.push(...bindingElementOrigins(element, nextSource, readAt, targetText));
  }
  return found;
}

/** Projects properties and defaults of an `ObjectBindingPattern` for `targetText`. */
function objectBindingOrigins(
  pattern: ObjectBindingPattern,
  source: Origin | undefined,
  readAt: Origin,
  targetText: string,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const element of pattern.elements) {
    if (!bindsHoistedName(element.name, targetText)) {
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      if (source !== undefined) {
        found.push(objectRestOrigin(source, readAt));
      }
      continue;
    }
    const key = bindingPropertyKey(element, readAt.context);
    const nextSource =
      source === undefined ? undefined : { ...source, keys: [...source.keys, key] };
    found.push(...bindingElementOrigins(element, nextSource, readAt, targetText));
  }
  return found;
}

/** Resolves the static property key read by an object `BindingElement`, or `null` when dynamic. */
function bindingPropertyKey(element: BindingElement, reading: ProxyReading): string | null {
  if (element.propertyName !== undefined) {
    return propertyKey(element.propertyName, reading) ?? null;
  }
  return isIdentifier(element.name) ? element.name.text : null;
}

/** Combines projected `source` origins with an optional `BindingElement` default initializer. */
function bindingElementOrigins(
  element: BindingElement,
  source: Origin | undefined,
  readAt: Origin,
  targetText: string,
): readonly Origin[] {
  const fromSource = bindingNameOrigins(element.name, source, readAt, targetText);
  if (element.initializer === undefined) {
    return fromSource;
  }
  const fallback: Origin = {
    ...readAt,
    excluded: undefined,
    keys: [],
    spread: undefined,
    value: element.initializer,
  };
  return [...fromSource, ...bindingNameOrigins(element.name, fallback, readAt, targetText)];
}

/** Projects an expression assignment target (identifier or destructuring literal) against `source`. */
function patternTargetOrigins(
  target: Expression,
  source: Origin | undefined,
  readAt: Origin,
  isRead: (candidate: Node) => candidate is Identifier,
): readonly Origin[] {
  const current = unwrapped(target);
  if (isIdentifier(current)) {
    return isRead(current) && source !== undefined ? [projectReadOrigin(source, readAt)] : [];
  }
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    const fallback: Origin = {
      ...readAt,
      excluded: undefined,
      keys: [],
      spread: undefined,
      value: current.right,
    };
    return [
      ...patternTargetOrigins(current.left, source, readAt, isRead),
      ...patternTargetOrigins(current.left, fallback, readAt, isRead),
    ];
  }
  if (isArrayLiteralExpression(current)) {
    return arrayPatternTargetOrigins(current, source, readAt, isRead);
  }
  return isObjectLiteralExpression(current)
    ? objectPatternTargetOrigins(current, source, readAt, isRead)
    : [];
}

/** Projects elements of an array-destructuring assignment literal against `source`. */
function arrayPatternTargetOrigins(
  pattern: ArrayLiteralExpression,
  source: Origin | undefined,
  readAt: Origin,
  isRead: (candidate: Node) => candidate is Identifier,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const [index, element] of pattern.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      if (isRead(unwrapped(element.expression))) {
        found.push(...restSliceOrigins(source, readAt));
      }
      continue;
    }
    const nextSource =
      source === undefined ? undefined : { ...source, keys: [...source.keys, String(index)] };
    found.push(...patternTargetOrigins(element, nextSource, readAt, isRead));
  }
  return found;
}

/** Projects properties of an object-destructuring assignment literal against `source`. */
function objectPatternTargetOrigins(
  pattern: ObjectLiteralExpression,
  source: Origin | undefined,
  readAt: Origin,
  isRead: (candidate: Node) => candidate is Identifier,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const property of pattern.properties) {
    if (isShorthandPropertyAssignment(property)) {
      if (!isRead(property.name)) {
        continue;
      }
      if (source !== undefined) {
        const propSource = { ...source, keys: [...source.keys, property.name.text] };
        found.push(projectReadOrigin(propSource, readAt));
      }
      if (property.objectAssignmentInitializer !== undefined) {
        found.push({ ...readAt, value: property.objectAssignmentInitializer });
      }
      continue;
    }
    if (isPropertyAssignment(property)) {
      const key = propertyKey(property.name, readAt.context) ?? null;
      const nextSource =
        source === undefined ? undefined : { ...source, keys: [...source.keys, key] };
      found.push(...patternTargetOrigins(property.initializer, nextSource, readAt, isRead));
      continue;
    }
    if (
      isSpreadAssignment(property) &&
      isRead(unwrapped(property.expression)) &&
      source !== undefined
    ) {
      found.push(objectRestOrigin(source, readAt));
    }
  }
  return found;
}

/** Combines `source`'s accumulated member path with the outer read's `keys` and spread state. */
function projectReadOrigin(source: Origin, readAt: Origin): Origin {
  return {
    ...source,
    excluded: readAt.excluded,
    keys: [...source.keys, ...readAt.keys],
    spread: readAt.spread,
  };
}

/** Projects an array rest slice `[...target]` for whole-array or indexed reads at `readAt`. */
function restSliceOrigins(source: Origin | undefined, readAt: Origin): readonly Origin[] {
  if (source === undefined) {
    return [];
  }
  if (readAt.keys.length === 0) {
    return [{ ...source, excluded: undefined, keys: [...source.keys, null], spread: undefined }];
  }
  const [firstKey, ...rest] = readAt.keys;
  return firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)
    ? [
        {
          ...source,
          excluded: readAt.excluded,
          keys: [...source.keys, null, ...rest],
          spread: readAt.spread,
        },
      ]
    : [];
}

/** Projects an object rest copy `{ ...target }` across `readAt`. */
function objectRestOrigin(source: Origin, readAt: Origin): Origin {
  return {
    ...source,
    excluded: readAt.excluded,
    keys: [...source.keys, ...readAt.keys],
    spread: readAt.keys.length === 0 ? true : readAt.spread,
  };
}
