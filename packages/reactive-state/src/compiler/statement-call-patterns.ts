import {
  type BindingElement,
  type BindingName,
  type ElementAccessExpression,
  type ForOfStatement,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { EMPTY_NODE_SET, EMPTY_PROJECT_SET, type ResolvedValue } from './statement-call-classes.ts';
import {
  activateEscapedExpression,
  activateWholeValue,
  type EscapeDriver,
} from './statement-call-escapes.ts';
import { projectMemberFromValue } from './statement-call-members.ts';
import {
  accessModeOf,
  ARRAY_SLICE_KIND,
  type Binding,
  nodeIdOf,
  unwrapExpression,
} from './statement-call-scopes.ts';
import { resolveTargets, staticAccessKey } from './statement-call-targets.ts';
import { bindingElementKey, staticPropertyNameKey } from './statement-call-writes.ts';

interface PatternWalk {
  readonly driver: EscapeDriver;
  readonly seenBindings: Set<Binding>;
}

interface SourceProjectionSpec {
  readonly excluded?: ReadonlySet<string> | undefined;
  readonly key: string | undefined;
  readonly ownOnly: boolean;
}

const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether an operator stores its right operand in its left one. */
export function isValueAssignment(operator: SyntaxKind): boolean {
  return VALUE_ASSIGNMENTS.has(operator);
}

export function observeMemberAccess(
  access: ElementAccessExpression | PropertyAccessExpression,
  driver: EscapeDriver,
): void {
  const mode = accessModeOf(access);
  driver.watch(`member:${nodeIdOf(access, driver.scopes)}`, (seenBindings) => {
    const key = staticAccessKey(access, driver.scopes, seenBindings);
    const receivers = resolveTargets(access.expression, driver.ctx, EMPTY_NODE_SET, seenBindings);
    for (const receiver of receivers) {
      projectMemberFromValue(
        receiver,
        {
          key,
          mode,
          ownOnly: false,
          seenBindings,
          seenNodes: EMPTY_NODE_SET,
          seenProjections: EMPTY_PROJECT_SET,
        },
        driver.ctx,
      );
    }
  });
}

export function observeObjectSpread(expr: Node, driver: EscapeDriver): void {
  driver.watch(`spread:${nodeIdOf(expr, driver.scopes)}`, (seenBindings) => {
    const sources = resolveTargets(expr, driver.ctx, EMPTY_NODE_SET, seenBindings);
    for (const source of sources) {
      projectMemberFromValue(
        source,
        {
          key: undefined,
          mode: 'read',
          ownOnly: true,
          seenBindings,
          seenNodes: EMPTY_NODE_SET,
          seenProjections: EMPTY_PROJECT_SET,
        },
        driver.ctx,
      );
    }
  });
}

export function observeDeclarationDestructuring(
  node: Node & { readonly initializer?: Node | undefined; readonly name: BindingName },
  driver: EscapeDriver,
): void {
  if (node.initializer === undefined || isIdentifier(node.name)) {
    return;
  }
  const initializer = node.initializer;
  driver.watch(`bindpat:${nodeIdOf(node, driver.scopes)}`, (seenBindings) => {
    const sources = resolveTargets(initializer, driver.ctx, EMPTY_NODE_SET, seenBindings);
    observeBindingPattern(node.name, sources, { driver, seenBindings });
  });
}

export function observeForOfDestructuring(node: ForOfStatement, driver: EscapeDriver): void {
  driver.watch(`forof:${nodeIdOf(node, driver.scopes)}`, (seenBindings) => {
    const walk: PatternWalk = { driver, seenBindings };
    const iterables = resolveTargets(node.expression, driver.ctx, EMPTY_NODE_SET, seenBindings);
    const elements = projectSources(iterables, { key: undefined, ownOnly: false }, walk);
    if (isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        if (!isIdentifier(declaration.name)) {
          observeBindingPattern(declaration.name, elements, walk);
        }
      }
    } else {
      observeAssignmentTargets(node.initializer, elements, walk);
    }
  });
}

function observeBindingPattern(
  pattern: BindingName,
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  if (isIdentifier(pattern) || sources.length === 0) {
    return;
  }
  if (isObjectBindingPattern(pattern)) {
    observeObjectBindingElements(pattern.elements, sources, walk);
  } else if (isArrayBindingPattern(pattern)) {
    observeArrayBindingElements(pattern.elements, sources, walk);
  }
}

function observeObjectBindingElements(
  elements: readonly BindingElement[],
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  const excluded = new Set<string>();
  for (const element of elements) {
    if (element.dotDotDotToken !== undefined) {
      projectSources(sources, { excluded: new Set(excluded), key: undefined, ownOnly: true }, walk);
      continue;
    }
    const key = bindingElementKey(element, walk.driver.scopes, walk.seenBindings);
    if (key !== undefined) {
      excluded.add(key);
    }
    observeProjectedBindingElement(element, sources, key, walk);
  }
}

function observeArrayBindingElements(
  elements: readonly Node[],
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  for (const [index, element] of elements.entries()) {
    if (!isOmittedExpression(element) && isBindingElement(element)) {
      const key = element.dotDotDotToken === undefined ? String(index) : undefined;
      observeProjectedBindingElement(element, sources, key, walk);
    }
  }
}

function observeProjectedBindingElement(
  element: BindingElement,
  sources: readonly ResolvedValue[],
  key: string | undefined,
  walk: PatternWalk,
): void {
  const projected = projectSources(sources, { key, ownOnly: false }, walk);
  if (element.name !== undefined && !isIdentifier(element.name)) {
    const nextSources =
      element.initializer === undefined
        ? projected
        : [
            ...projected,
            ...resolveTargets(
              element.initializer,
              walk.driver.ctx,
              EMPTY_NODE_SET,
              walk.seenBindings,
            ),
          ];
    observeBindingPattern(element.name, nextSources, walk);
  }
}

export function observeAssignmentDestructuring(
  left: Node,
  right: Node,
  driver: EscapeDriver,
): void {
  const target = unwrapExpression(left);
  if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
    // What a member holds is not followed, so what is stored there escapes, as an argument does.
    activateEscapedExpression(right, driver);
    return;
  }
  if (!isObjectLiteralExpression(target) && !isArrayLiteralExpression(target)) {
    return;
  }
  driver.watch(`assignpat:${nodeIdOf(left, driver.scopes)}`, (seenBindings) => {
    const sources = resolveTargets(right, driver.ctx, EMPTY_NODE_SET, seenBindings);
    observeAssignmentTargets(target, sources, { driver, seenBindings });
  });
}

function observeAssignmentTargets(
  lhs: Node,
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  if (sources.length === 0) {
    return;
  }
  const target = unwrapExpression(lhs);
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    const merged = [
      ...sources,
      ...resolveTargets(target.right, walk.driver.ctx, EMPTY_NODE_SET, walk.seenBindings),
    ];
    observeAssignmentTargets(target.left, merged, walk);
  } else if (isObjectLiteralExpression(target)) {
    observeObjectAssignmentPattern(target.properties, sources, walk);
  } else if (isArrayLiteralExpression(target)) {
    observeArrayAssignmentPattern(target.elements, sources, walk);
  } else if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
    for (const source of sources) {
      activateWholeValue(source, walk.driver);
    }
  }
}

function observeObjectAssignmentPattern(
  properties: readonly ObjectLiteralElementLike[],
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  const excluded = new Set<string>();
  for (const property of properties) {
    if (isSpreadAssignment(property)) {
      projectSources(sources, { excluded: new Set(excluded), key: undefined, ownOnly: true }, walk);
      continue;
    }
    const key = staticPropertyNameKey(property.name, walk.driver.scopes, walk.seenBindings);
    if (key !== undefined) {
      excluded.add(key);
    }
    const projected = projectSources(sources, { key, ownOnly: false }, walk);
    if (isPropertyAssignment(property)) {
      observeAssignmentTargets(property.initializer, projected, walk);
    }
  }
}

function observeArrayAssignmentPattern(
  elements: readonly Node[],
  sources: readonly ResolvedValue[],
  walk: PatternWalk,
): void {
  for (const [index, element] of elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      const restSlices: ResolvedValue[] = sources.map((source) => {
        return source.kind === ARRAY_SLICE_KIND
          ? { kind: ARRAY_SLICE_KIND, offset: source.offset + index, source: source.source }
          : { kind: ARRAY_SLICE_KIND, offset: index, source };
      });
      projectSources(restSlices, { key: undefined, ownOnly: false }, walk);
      observeAssignmentTargets(element.expression, restSlices, walk);
    } else {
      const projected = projectSources(sources, { key: String(index), ownOnly: false }, walk);
      observeAssignmentTargets(element, projected, walk);
    }
  }
}

function projectSources(
  sources: readonly ResolvedValue[],
  spec: SourceProjectionSpec,
  walk: PatternWalk,
): readonly ResolvedValue[] {
  return sources.flatMap((src) => {
    return projectMemberFromValue(
      src,
      {
        excluded: spec.excluded,
        key: spec.key,
        mode: 'read',
        ownOnly: spec.ownOnly,
        seenBindings: walk.seenBindings,
        seenNodes: EMPTY_NODE_SET,
        seenProjections: EMPTY_PROJECT_SET,
      },
      walk.driver.ctx,
    );
  });
}
