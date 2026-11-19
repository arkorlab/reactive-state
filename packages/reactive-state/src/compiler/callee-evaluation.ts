import {
  type Block,
  type ClassDeclaration,
  type Expression,
  isBlock,
  isClassDeclaration,
  isConstructorDeclaration,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isCallExpression,
  isExpressionStatement,
  isNewExpression,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isTaggedTemplateExpression,
  isVariableStatement,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { rootOf, targetsOf } from './kept.ts';
import { freeReads, isTypeOnly, readsBinding } from './scope.ts';
import { interveningEvaluation } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

/** A deferred read can run after later-written statements, outside the literal's lexical range. */
export function calleeUncertain(value: Expression, at: Expression): boolean {
  if (interveningEvaluation(value, at)) {
    return true;
  }
  if (executionOf(value) === executionOf(at) && !repeatedAround(value, at)) {
    return false;
  }
  const before = constructionBoundary(value, at);
  const status = { changed: false };
  const visit = (node: Node): void => {
    if (status.changed) {
      return;
    }
    const written = writtenBy(node);
    status.changed = (written === undefined ? [] : targetsOf(written)).some((target) => {
      const root = rootOf(target);
      return root !== undefined && refersTo(root, value) && !afterConstruction(node, before);
    });
    if (node !== at && !status.changed) {
      status.changed = handedToCall(node, value) && !afterConstruction(node, before);
    }
    if (!status.changed) {
      node.forEachChild(visit);
    }
  };
  visit(value.getSourceFile());
  return status.changed;
}

interface ConstructionBoundary {
  readonly body: Block;
  readonly execution: Node;
  readonly end: number;
}

/** Whether a loop, which does not build `value`, runs `at` again, so a write after `at` precedes its next run. */
function repeatedAround(value: Expression, at: Expression): boolean {
  const execution = executionOf(at);
  for (let each: Node = at.parent; each !== execution; each = each.parent) {
    if (isLoop(each) && !contains(each, value)) {
      return true;
    }
  }
  return false;
}

/** Whether `node` is a statement that runs its body again: `for`, `for…in`, `for…of`, `while`, `do`. */
function isLoop(node: Node): boolean {
  return (
    isForStatement(node) ||
    isForInStatement(node) ||
    isForOfStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node)
  );
}

/** Direct constructions in one sequential body finish before its later statements run. */
function constructionBoundary(value: Expression, at: Expression): ConstructionBoundary | undefined {
  const execution = executionOf(value);
  const deferred = executionOf(at);
  if (!isConstructorDeclaration(deferred) || !isClassDeclaration(deferred.parent)) {
    return undefined;
  }
  const body = isAnswering(execution) ? execution.body : undefined;
  if (body === undefined || !isBlock(body) || deferred.parent.parent !== body) {
    return undefined;
  }
  const end = constructionEnd(deferred.parent, body, execution);
  return end === undefined ? undefined : { body, execution, end };
}

/** Every runtime class reference must be a direct, immediate construction in the same body. */
function constructionEnd(
  target: ClassDeclaration,
  body: Block,
  execution: Node,
): number | undefined {
  const state = { unknown: false, end: undefined as number | undefined };
  const visit = (node: Node): void => {
    if (state.unknown || isTypeOnly(node)) {
      return;
    }
    if (
      isIdentifier(node) &&
      node !== target.name &&
      readsBinding(node) &&
      declarationOf(node) === target
    ) {
      const call = node.parent;
      const statement = statementOf(call, body);
      if (
        statement === undefined ||
        !isNewExpression(call) ||
        call.expression !== node ||
        executionOf(call) !== execution ||
        !immediateStatement(statement)
      ) {
        state.unknown = true;
      } else {
        state.end = Math.max(state.end ?? 0, statement.end);
      }
    }
    if (!state.unknown) {
      node.forEachChild(visit);
    }
  };
  visit(target.getSourceFile());
  return state.unknown ? undefined : state.end;
}

/** A top-level expression or binding finishes before the body proceeds; a loop can run again. */
function immediateStatement(node: Node): boolean {
  return isVariableStatement(node) || isExpressionStatement(node) || isReturnStatement(node);
}

/** The statement of this execution body containing the given node, excluding outer bodies. */
function statementOf(node: Node, body: Block): Node | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (each.parent === body) {
      return each;
    }
  }
  return undefined;
}

/** A write after all proven constructions cannot change what those constructors already read. */
function afterConstruction(node: Node, before: ConstructionBoundary | undefined): boolean {
  if (executionOf(node) !== before?.execution) {
    return false;
  }
  const statement = statementOf(node, before.body);
  return statement !== undefined && statement.pos >= before.end;
}

/** A function or instance field starts another execution; top-level reads keep statement order. */
function executionOf(node: Node): Node {
  for (let at: Node = node.parent; ; at = at.parent) {
    if (
      isSourceFile(at) ||
      isAnswering(at) ||
      isConstructorDeclaration(at) ||
      isSetAccessorDeclaration(at)
    ) {
      return at;
    }
    if (
      isPropertyDeclaration(at) &&
      at.initializer !== undefined &&
      at.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
    ) {
      return at;
    }
  }
}

/** Code handed the actual container can replace members before a deferred source read. */
function handedToCall(node: Node, value: Expression): boolean {
  if (isCallExpression(node) || isNewExpression(node)) {
    const given = node.arguments;
    return given?.some((argument) => references(argument, value)) === true;
  }
  return isTaggedTemplateExpression(node) && references(node.template, value);
}

/** Runtime argument references, excluding property names and parameters that shadow a constant. */
function references(node: Node, value: Expression): boolean {
  for (const read of freeReads(node)) {
    if (refersTo(read, value)) {
      return true;
    }
  }
  return false;
}

/** The written constant or one of its lexical aliases, without recursively resolving members. */
function refersTo(node: Expression, value: Expression): boolean {
  const seen = new Set<Expression>();
  let held = unwrapped(node);
  while (!seen.has(held)) {
    if (held === value) {
      return true;
    }
    seen.add(held);
    if (!isIdentifier(held)) {
      return contains(held, value);
    }
    const initializer = initializerOf(held);
    if (initializer === undefined) {
      return false;
    }
    held = unwrapped(initializer);
  }
  return false;
}

/** An outer literal's replacement also invalidates a nested literal selected from it. */
function contains(outer: Node, inner: Node): boolean {
  for (let at: Node = inner; !isSourceFile(at); at = at.parent) {
    if (at === outer) {
      return true;
    }
  }
  return false;
}
