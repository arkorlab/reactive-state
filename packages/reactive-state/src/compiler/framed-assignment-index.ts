import {
  type BinaryExpression,
  type Expression,
  type ForOfStatement,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
import { frameDeclarationOf, type FrameDeclaration } from './framed-bindings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Per-module index of direct/for-of assignment sites and value-binding reads. */

export type AssignmentSite = BinaryExpression | ForOfStatement;

interface ModuleAssignmentIndex {
  readonly bindingReads: ReadonlyMap<VariableDeclaration, ReadonlySet<Identifier>>;
  readonly sitesByDeclaration: ReadonlyMap<FrameDeclaration, readonly AssignmentSite[]>;
}

export const DIRECT_ASSIGNMENT_TOKENS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const MODULE_ASSIGNMENTS = new WeakMap<SourceFile, ModuleAssignmentIndex>();

/** Assignment and iteration write sites targeting `declared` in `file`, in AST traversal order. */
export function framedAssignmentSites(
  file: SourceFile,
  declared: FrameDeclaration,
): readonly AssignmentSite[] {
  return moduleAssignmentIndex(file).sitesByDeclaration.get(declared) ?? [];
}

/** Whether `binding` has any value-reference read in its `SourceFile` other than `name`. */
export function hasOtherBindingRead(name: Identifier, binding: VariableDeclaration): boolean {
  const reads = moduleAssignmentIndex(name.getSourceFile()).bindingReads.get(binding);
  return reads !== undefined && (reads.size > 1 || !reads.has(name));
}

/** Builds and caches the assignment-site and binding-read maps once per `SourceFile`. */
function moduleAssignmentIndex(file: SourceFile): ModuleAssignmentIndex {
  const cached = MODULE_ASSIGNMENTS.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const bindingReads = new Map<VariableDeclaration, Set<Identifier>>();
  const sitesByDeclaration = new Map<FrameDeclaration, AssignmentSite[]>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    recordAssignmentSite(node, sitesByDeclaration);
    recordBindingRead(node, bindingReads);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const indexed: ModuleAssignmentIndex = { bindingReads, sitesByDeclaration };
  MODULE_ASSIGNMENTS.set(file, indexed);
  return indexed;
}

/** Records `node` under each lexical declaration written by its assignment or `for-of` pattern. */
function recordAssignmentSite(
  node: Node,
  sitesByDeclaration: Map<FrameDeclaration, AssignmentSite[]>,
): void {
  const site = directOrForOfSite(node);
  if (site === undefined) {
    return;
  }
  for (const declared of patternTargetDeclarations(site.target)) {
    const existing = sitesByDeclaration.get(declared);
    if (existing === undefined) {
      sitesByDeclaration.set(declared, [site.node]);
    } else {
      existing.push(site.node);
    }
  }
}

/** Classifies a direct assignment or expression-target `for-of` loop and its LHS pattern. */
function directOrForOfSite(
  node: Node,
): { readonly node: AssignmentSite; readonly target: Expression } | undefined {
  if (
    isBinaryExpression(node) &&
    DIRECT_ASSIGNMENT_TOKENS.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  ) {
    return { node, target: node.left };
  }
  return isForOfStatement(node) && isExpression(node.initializer)
    ? { node, target: node.initializer }
    : undefined;
}

/** Collects distinct `FrameDeclaration`s targeted by leaf identifiers of an assignment pattern. */
function patternTargetDeclarations(root: Expression): ReadonlySet<FrameDeclaration> {
  const declarations = new Set<FrameDeclaration>();
  const pending: Expression[] = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = unwrapped(current);
    if (isIdentifier(target)) {
      const declared = frameDeclarationOf(target);
      if (declared !== undefined) {
        declarations.add(declared);
      }
    } else {
      pushPatternChildren(target, pending);
    }
  }
  return declarations;
}

/** Pushes nested target sub-patterns without entering default values or computed property keys. */
function pushPatternChildren(target: Expression, pending: Expression[]): void {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(target.left);
    return;
  }
  if (isArrayLiteralExpression(target)) {
    for (const element of target.elements) {
      if (!isOmittedExpression(element)) {
        pending.push(isSpreadElement(element) ? element.expression : element);
      }
    }
    return;
  }
  if (isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      pushObjectPatternProperty(property, pending);
    }
  }
}

/** Pushes the bound target of an object assignment-pattern property. */
function pushObjectPatternProperty(
  property: ObjectLiteralElementLike,
  pending: Expression[],
): void {
  if (isPropertyAssignment(property)) {
    pending.push(property.initializer);
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    pending.push(property.name);
  }
}

/** Records a value-space identifier read against its resolved `VariableDeclaration`. */
function recordBindingRead(
  node: Node,
  bindingReads: Map<VariableDeclaration, Set<Identifier>>,
): void {
  if (!isIdentifier(node) || !readsBinding(node)) {
    return;
  }
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared) || node === declared.name) {
    return;
  }
  const existing = bindingReads.get(declared);
  if (existing === undefined) {
    bindingReads.set(declared, new Set([node]));
  } else {
    existing.add(node);
  }
}
