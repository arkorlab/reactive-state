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
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectBindingPattern,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { arrayIndex } from './proxy-arrays.ts';
import { type Origin, peeled, propertyKey, type ProxyReading } from './proxy-values.ts';
import { hoistedIn } from './scope.ts';

/** Query describing a `BindingName` destructuring read and optional definedness hook. */
export interface PatternBindingQuery {
  readonly checkPresence?: ((source: Origin) => 'defined' | 'possible' | 'undefined') | undefined;
  readonly defaultAt?: Origin | undefined;
  readonly pattern: BindingName;
  readonly readAt: Origin;
  readonly source: Origin | undefined;
  readonly targetText: string;
}

/** Assignment operators whose right-hand expression can become the target binding's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether a hoisted `var` or parameter `BindingName` declares `targetText`. */
export function bindsHoistedName(name: BindingName | undefined, targetText: string): boolean {
  if (name === undefined) {
    return false;
  }
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
      found.push(
        ...destructuredBindingOrigins({
          pattern: declaration.name,
          readAt: at,
          source,
          targetText,
        }),
      );
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
      found.push(
        ...destructuredBindingOrigins({
          pattern: declaration.name,
          readAt: at,
          source,
          targetText,
        }),
      );
    } else if (isForInStatement(loop)) {
      found.push(
        ...destructuredBindingOrigins({
          pattern: declaration.name,
          readAt: at,
          source: undefined,
          targetText,
        }),
      );
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
  const matchesLeaf = (candidate: Expression): boolean => isRead(candidate);
  if (isBinaryExpression(node) && VALUE_ASSIGNMENTS.has(node.operatorToken.kind)) {
    if (node.operatorToken.kind !== SyntaxKind.EqualsToken) {
      return isRead(peeled(node.left)) ? [{ ...at, value: node.right }] : [];
    }
    const source: Origin = {
      ...at,
      excluded: undefined,
      keys: [],
      spread: undefined,
      value: node.right,
    };
    return patternTargetOrigins(node.left, source, at, matchesLeaf);
  }
  if (isForOfStatement(node) && isExpression(node.initializer)) {
    const source: Origin = {
      ...at,
      excluded: undefined,
      keys: [null],
      spread: undefined,
      value: node.expression,
    };
    return patternTargetOrigins(node.initializer, source, at, matchesLeaf);
  }
  if (isForInStatement(node) && isExpression(node.initializer)) {
    return patternTargetOrigins(node.initializer, undefined, at, matchesLeaf);
  }
  return [];
}

/** Projects a `BindingName` (identifier or destructuring pattern) against `query.source`. */
export function destructuredBindingOrigins(query: PatternBindingQuery): readonly Origin[] {
  const { pattern, readAt, source, targetText } = query;
  if (isIdentifier(pattern)) {
    return source !== undefined && pattern.text === targetText
      ? [projectReadOrigin(source, readAt)]
      : [];
  }
  if (isArrayBindingPattern(pattern)) {
    return arrayBindingOrigins(pattern, query);
  }
  return objectBindingOrigins(pattern, query);
}

/** Projects elements and defaults of an `ArrayBindingPattern` for `query.targetText`. */
function arrayBindingOrigins(
  pattern: ArrayBindingPattern,
  query: PatternBindingQuery,
): readonly Origin[] {
  const { readAt, source, targetText } = query;
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
    found.push(...bindingElementOrigins(element, { ...query, source: nextSource }));
  }
  return found;
}

/** Projects properties, object-rest exclusions, and defaults of an `ObjectBindingPattern`. */
function objectBindingOrigins(
  pattern: ObjectBindingPattern,
  query: PatternBindingQuery,
): readonly Origin[] {
  const { readAt, source, targetText } = query;
  const found: Origin[] = [];
  const omittedKeys = new Set<string>();
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      if (source !== undefined && bindsHoistedName(element.name, targetText)) {
        found.push(...objectRestOrigins(source, readAt, omittedKeys));
      }
      continue;
    }
    const key = bindingPropertyKey(element, readAt.context);
    if (bindsHoistedName(element.name, targetText)) {
      const nextSource =
        source === undefined ? undefined : { ...source, keys: [...source.keys, key] };
      found.push(...bindingElementOrigins(element, { ...query, source: nextSource }));
    }
    if (key !== null) {
      omittedKeys.add(key);
    }
  }
  return found;
}

/** Resolves the static property key read by an object `BindingElement`, or `null` when dynamic. */
function bindingPropertyKey(element: BindingElement, reading: ProxyReading): string | null {
  if (element.propertyName !== undefined) {
    return propertyKey(element.propertyName, reading) ?? null;
  }
  return element.name !== undefined && isIdentifier(element.name) ? element.name.text : null;
}

/** Combines projected `source` origins with an optional `BindingElement` default initializer. */
function bindingElementOrigins(
  element: BindingElement,
  query: PatternBindingQuery,
): readonly Origin[] {
  if (element.name === undefined) {
    return [];
  }
  const nextQuery: PatternBindingQuery = { ...query, pattern: element.name };
  const fromSource = destructuredBindingOrigins(nextQuery);
  if (element.initializer === undefined) {
    return fromSource;
  }
  const presence =
    query.source === undefined || query.checkPresence === undefined
      ? 'possible'
      : query.checkPresence(query.source);
  if (presence === 'defined') {
    return fromSource;
  }
  const baseAt = query.defaultAt ?? query.readAt;
  const fallback: Origin = {
    ...baseAt,
    excluded: undefined,
    keys: [],
    spread: undefined,
    value: element.initializer,
  };
  const fromDefault = destructuredBindingOrigins({ ...nextQuery, source: fallback });
  return presence === 'undefined' ? fromDefault : [...fromSource, ...fromDefault];
}

/** Projects an expression assignment target (identifier, member, or pattern) against `source`. */
export function patternTargetOrigins(
  target: Expression,
  source: Origin | undefined,
  readAt: Origin,
  matchesLeaf: (candidate: Expression) => boolean,
): readonly Origin[] {
  const current = peeled(target);
  if (matchesLeaf(current)) {
    return source === undefined ? [] : [projectReadOrigin(source, readAt)];
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
      ...patternTargetOrigins(current.left, source, readAt, matchesLeaf),
      ...patternTargetOrigins(current.left, fallback, readAt, matchesLeaf),
    ];
  }
  if (isArrayLiteralExpression(current)) {
    return arrayPatternTargetOrigins(current, source, readAt, matchesLeaf);
  }
  return isObjectLiteralExpression(current)
    ? objectPatternTargetOrigins(current, source, readAt, matchesLeaf)
    : [];
}

/** Projects elements of an array-destructuring assignment literal against `source`. */
function arrayPatternTargetOrigins(
  pattern: ArrayLiteralExpression,
  source: Origin | undefined,
  readAt: Origin,
  matchesLeaf: (candidate: Expression) => boolean,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const [index, element] of pattern.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      if (matchesLeaf(peeled(element.expression))) {
        found.push(...restSliceOrigins(source, readAt));
      }
      continue;
    }
    const nextSource =
      source === undefined ? undefined : { ...source, keys: [...source.keys, String(index)] };
    found.push(...patternTargetOrigins(element, nextSource, readAt, matchesLeaf));
  }
  return found;
}

/** Projects properties of an object-destructuring assignment literal against `source`. */
function objectPatternTargetOrigins(
  pattern: ObjectLiteralExpression,
  source: Origin | undefined,
  readAt: Origin,
  matchesLeaf: (candidate: Expression) => boolean,
): readonly Origin[] {
  const found: Origin[] = [];
  const omittedKeys = new Set<string>();
  for (const property of pattern.properties) {
    found.push(
      ...objectPatternPropertyOrigins(property, source, readAt, { matchesLeaf, omittedKeys }),
    );
  }
  return found;
}

/** Projects one object-destructuring property or rest spread against `source`. */
function objectPatternPropertyOrigins(
  property: ObjectLiteralExpression['properties'][number],
  source: Origin | undefined,
  readAt: Origin,
  state: {
    readonly matchesLeaf: (candidate: Expression) => boolean;
    readonly omittedKeys: Set<string>;
  },
): readonly Origin[] {
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    const key = property.name.text;
    state.omittedKeys.add(key);
    if (!state.matchesLeaf(property.name)) {
      return [];
    }
    const fromSource =
      source === undefined
        ? []
        : [projectReadOrigin({ ...source, keys: [...source.keys, key] }, readAt)];
    const fromInit =
      property.objectAssignmentInitializer === undefined
        ? []
        : [{ ...readAt, value: property.objectAssignmentInitializer }];
    return [...fromSource, ...fromInit];
  }
  if (isPropertyAssignment(property)) {
    const key = propertyKey(property.name, readAt.context) ?? null;
    const nextSource =
      source === undefined ? undefined : { ...source, keys: [...source.keys, key] };
    const nested = patternTargetOrigins(
      property.initializer,
      nextSource,
      readAt,
      state.matchesLeaf,
    );
    if (key !== null) {
      state.omittedKeys.add(key);
    }
    return nested;
  }
  return source !== undefined &&
    isSpreadAssignment(property) &&
    state.matchesLeaf(peeled(property.expression))
    ? objectRestOrigins(source, readAt, state.omittedKeys)
    : [];
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

/** Projects an object rest copy `{ ...target }` across `readAt`, excluding stripped keys. */
function objectRestOrigins(
  source: Origin,
  readAt: Origin,
  omittedKeys: ReadonlySet<string>,
): readonly Origin[] {
  if (readAt.keys.length === 0) {
    let excluded: ReadonlySet<string> | undefined;
    if (omittedKeys.size > 0 || readAt.excluded !== undefined) {
      const merged = new Set(readAt.excluded);
      for (const key of omittedKeys) {
        merged.add(key);
      }
      excluded = merged;
    }
    return [{ ...source, excluded, keys: [...source.keys], spread: true }];
  }
  const [firstKey] = readAt.keys;
  if (firstKey !== undefined && firstKey !== null && omittedKeys.has(firstKey)) {
    return [];
  }
  return [
    {
      ...source,
      excluded: readAt.excluded,
      keys: [...source.keys, ...readAt.keys],
      spread: readAt.spread,
    },
  ];
}
