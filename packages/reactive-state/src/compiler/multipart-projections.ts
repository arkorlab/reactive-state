import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAssignment,
  type SpreadAssignment,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { assignmentPatternDefault, iteratedFrameSources } from './framed-assignment-patterns.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import type { Held } from './framed-held-members.ts';
import { resolveDynamicObjectSources, staticPropertyName } from './multipart-dynamic-sources.ts';
import type { ProjectionCallbacks } from './multipart-held-bindings.ts';
import { isTypeOnly } from './scope.ts';

/** Projected destructuring reassignments and dynamic pattern scans for multipart checks. */

export type PatternTargetDeclaration = ParameterDeclaration | VariableDeclaration;

export interface PatternReassignmentScan {
  readonly ambiguous: boolean;
  readonly dynamicOpaque: boolean;
  readonly extraSources: readonly Held[];
}

interface TargetBinding {
  readonly callbacks: ProjectionCallbacks;
  readonly declaration: PatternTargetDeclaration;
  readonly name: Identifier;
  readonly reaches: (change: Node) => boolean;
}

interface PatternStep {
  readonly fromDynamic: boolean;
  readonly sources: readonly Held[];
  readonly target: Expression;
}

interface ScanAccumulator {
  dynamicOpaque: boolean;
  readonly extraSources: Held[];
  matched: boolean;
  readonly pending: PatternStep[];
  readonly writeNode: Node;
}

interface ObjectStepContext {
  readonly excludedKeys: Set<string>;
  readonly fromDynamic: boolean;
  readonly sources: readonly Held[];
}

const BODY_KEY = 'body';
export const NO_PATTERN_REASSIGNMENT: PatternReassignmentScan = {
  ambiguous: false,
  dynamicOpaque: false,
  extraSources: [],
};

const ACTIVE_PATTERN_BINDINGS = new Set<Node>();

const DIRECT_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const UPDATE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);

/** Scans reachable pattern, loop, and update writes targeting `declaration` for rest and dynamic sources. */
export function patternBindingReassignments(
  name: Identifier,
  declaration: PatternTargetDeclaration,
  reaches: (change: Node) => boolean,
  callbacks: ProjectionCallbacks,
): PatternReassignmentScan {
  if (ACTIVE_PATTERN_BINDINGS.has(declaration)) {
    return { ambiguous: true, dynamicOpaque: true, extraSources: [] };
  }
  ACTIVE_PATTERN_BINDINGS.add(declaration);
  try {
    const target: TargetBinding = { callbacks, declaration, name, reaches };
    const extraSources: Held[] = [];
    let ambiguous = false;
    let dynamicOpaque = false;
    const pending: Node[] = [name.getSourceFile()];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (isTypeOnly(node)) {
        continue;
      }
      const site = scanReassignmentSite(node, target);
      if (site.ambiguous) {
        ambiguous = true;
      }
      if (site.dynamicOpaque) {
        dynamicOpaque = true;
      }
      extraSources.push(...site.extraSources);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
    return { ambiguous, dynamicOpaque, extraSources };
  } finally {
    ACTIVE_PATTERN_BINDINGS.delete(declaration);
  }
}

/** Evaluates one AST write site against `target` when it is not a plain identifier assignment. */
function scanReassignmentSite(node: Node, target: TargetBinding): PatternReassignmentScan {
  if (
    isBinaryExpression(node) &&
    DIRECT_WRITES.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  ) {
    if (isIdentifier(unwrapped(node.left)) || !target.reaches(node)) {
      return NO_PATTERN_REASSIGNMENT;
    }
    return scanDestructuringTarget(node.left, [{ keys: [], value: node.right }], node, target);
  }
  if ((isForOfStatement(node) || isForInStatement(node)) && isExpression(node.initializer)) {
    return scanLoopWrite(node, node.initializer, target);
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    UPDATE_OPERATORS.has(node.operator) &&
    target.reaches(node)
  ) {
    const hit = targetsBinding(node.operand, target);
    return { ambiguous: hit, dynamicOpaque: false, extraSources: [] };
  }
  return NO_PATTERN_REASSIGNMENT;
}

/** Evaluates `for-of` and `for-in` assignment targets against `target`. */
function scanLoopWrite(
  loop: Node,
  initializer: Expression,
  target: TargetBinding,
): PatternReassignmentScan {
  if (!target.reaches(loop)) {
    return NO_PATTERN_REASSIGNMENT;
  }
  if (isForOfStatement(loop) && !isIdentifier(unwrapped(initializer))) {
    return scanDestructuringTarget(
      initializer,
      iteratedFrameSources(loop.expression),
      loop,
      target,
    );
  }
  const hit = targetsBinding(initializer, target);
  return { ambiguous: hit, dynamicOpaque: hit && isForOfStatement(loop), extraSources: [] };
}

/** Walks a destructuring LHS pattern to detect writes to `target` and collect rest/computed RHS sources. */
function scanDestructuringTarget(
  rootTarget: Expression,
  rootSources: readonly Held[],
  writeNode: Node,
  target: TargetBinding,
): PatternReassignmentScan {
  const acc: ScanAccumulator = {
    dynamicOpaque: false,
    extraSources: [],
    matched: false,
    pending: [{ fromDynamic: false, sources: rootSources, target: rootTarget }],
    writeNode,
  };
  for (let step = acc.pending.pop(); step !== undefined; step = acc.pending.pop()) {
    const current = unwrapped(step.target);
    if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
      acc.pending.push({
        fromDynamic: step.fromDynamic,
        sources: [...step.sources, { keys: [], value: current.right }],
        target: current.left,
      });
    } else if (isIdentifier(current)) {
      if (matchesBinding(current, target)) {
        acc.matched = true;
        if (step.fromDynamic) {
          acc.extraSources.push(...step.sources);
        }
      }
    } else if (isObjectLiteralExpression(current)) {
      stepObjectTarget(current, step, target, acc);
    } else if (isArrayLiteralExpression(current)) {
      stepArrayTarget(current, step, target, acc);
    }
  }
  return {
    ambiguous: acc.matched,
    dynamicOpaque: acc.dynamicOpaque,
    extraSources: acc.extraSources,
  };
}

/** Steps object destructuring properties, recording rest copies unless `body` is statically excluded. */
function stepObjectTarget(
  object: ObjectLiteralExpression,
  step: PatternStep,
  target: TargetBinding,
  acc: ScanAccumulator,
): void {
  const excludedKeys = new Set<string>();
  const context: ObjectStepContext = {
    excludedKeys,
    fromDynamic: step.fromDynamic,
    sources: step.sources,
  };
  for (const property of object.properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      const propName = property.name.text;
      excludedKeys.add(propName);
      if (matchesBinding(property.name, target)) {
        acc.matched = true;
        if (step.fromDynamic) {
          acc.extraSources.push(
            ...step.sources.map((each) => {
              return {
                keys: [...each.keys, propName],
                value: each.value,
              };
            }),
          );
        }
      }
    } else if (isPropertyAssignment(property)) {
      stepObjectPropertyTarget(property, context, target, acc);
    } else if (isSpreadAssignment(property)) {
      stepObjectSpreadTarget(property, context, target, acc);
    }
  }
}

/** Handles an object rest assignment target (`...options`). */
function stepObjectSpreadTarget(
  property: SpreadAssignment,
  context: ObjectStepContext,
  target: TargetBinding,
  acc: ScanAccumulator,
): void {
  const restTarget = unwrapped(property.expression);
  if (isIdentifier(restTarget) && matchesBinding(restTarget, target)) {
    acc.matched = true;
    if (!context.excludedKeys.has(BODY_KEY)) {
      acc.extraSources.push(...context.sources);
    }
    return;
  }
  acc.pending.push({ fromDynamic: context.fromDynamic, sources: [], target: restTarget });
}

/** Handles one keyed or computed object destructuring property assignment. */
function stepObjectPropertyTarget(
  property: PropertyAssignment,
  context: ObjectStepContext,
  target: TargetBinding,
  acc: ScanAccumulator,
): void {
  const subTarget = property.initializer;
  const key = staticPropertyName(property.name);
  if (key !== undefined) {
    context.excludedKeys.add(key);
    acc.pending.push({
      fromDynamic: context.fromDynamic,
      sources: context.sources.map((each) => ({ keys: [...each.keys, key], value: each.value })),
      target: subTarget,
    });
    return;
  }
  if (!targetsBinding(subTarget, target)) {
    return;
  }
  acc.matched = true;
  const dynamic = resolveDynamicObjectSources(context.sources, acc.writeNode, target.callbacks);
  if (dynamic.opaque) {
    acc.dynamicOpaque = true;
  }
  acc.pending.push({ fromDynamic: true, sources: dynamic.values, target: subTarget });
}

/** Steps array destructuring elements and leading array rest targets. */
function stepArrayTarget(
  array: ArrayLiteralExpression,
  step: PatternStep,
  target: TargetBinding,
  acc: ScanAccumulator,
): void {
  for (const [index, element] of array.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      const restTarget = unwrapped(element.expression);
      if (isIdentifier(restTarget) && matchesBinding(restTarget, target)) {
        acc.matched = true;
        if (index === 0) {
          acc.extraSources.push(...step.sources);
        }
      } else {
        acc.pending.push({ fromDynamic: step.fromDynamic, sources: [], target: restTarget });
      }
    } else {
      acc.pending.push({
        fromDynamic: step.fromDynamic,
        sources: step.sources.map((each) => {
          return {
            keys: [...each.keys, String(index)],
            value: each.value,
          };
        }),
        target: element,
      });
    }
  }
}

/** Whether any assignment target identifier inside `pattern` resolves to `target.declaration`. */
function targetsBinding(pattern: Expression, target: TargetBinding): boolean {
  const pending: Expression[] = [pattern];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const current = unwrapped(at);
    if (isIdentifier(current) && matchesBinding(current, target)) {
      return true;
    }
    pending.push(...patternChildTargets(current));
  }
  return false;
}

/** Direct child target expressions of one unwrapped assignment pattern node. */
function patternChildTargets(current: Expression): readonly Expression[] {
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    return [current.left];
  }
  if (isObjectLiteralExpression(current)) {
    return objectPatternChildTargets(current);
  }
  if (!isArrayLiteralExpression(current)) {
    return [];
  }
  const children: Expression[] = [];
  for (const element of current.elements) {
    if (isSpreadElement(element)) {
      children.push(element.expression);
    } else if (!isOmittedExpression(element)) {
      children.push(element);
    }
  }
  return children;
}

/** Child target expressions inside an object destructuring assignment literal. */
function objectPatternChildTargets(object: ObjectLiteralExpression): readonly Expression[] {
  const children: Expression[] = [];
  for (const property of object.properties) {
    if (isPropertyAssignment(property)) {
      children.push(property.initializer);
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      children.push(property.name);
    } else if (isSpreadAssignment(property)) {
      children.push(property.expression);
    }
  }
  return children;
}

/** Checks whether `id` references `target.declaration`. */
function matchesBinding(id: Identifier, target: TargetBinding): boolean {
  return id.text === target.name.text && frameDeclarationOf(id) === target.declaration;
}
