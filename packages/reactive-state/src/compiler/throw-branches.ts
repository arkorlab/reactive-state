import {
  type Block,
  type Expression,
  type Node,
  type IfStatement,
  isClassDeclaration,
  isFunctionDeclaration,
  isIfStatement,
  isSwitchStatement,
  isTryStatement,
  type SwitchStatement,
  type TryStatement,
  isEmptyStatement,
  isExpressionStatement,
  isExpression,
  isVariableStatement,
  isReturnStatement,
  isWhileStatement,
  isForStatement,
  isVariableDeclarationList,
  type ReturnStatement,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';
import { switchPlan } from './throw-switches.ts';

/** A literal boolean condition's executed branch, or no known branch. */
export function knownBranch(
  node: IfStatement,
  resolve?: Resolve,
): readonly Statement[] | undefined {
  const condition = writtenOf(node.expression, resolve);
  if (condition.kind === SyntaxKind.FalseKeyword) {
    return node.elseStatement === undefined ? [] : [node.elseStatement];
  }
  return condition.kind === SyntaxKind.TrueKeyword ? [node.thenStatement] : undefined;
}

/**
 * A source return the function may reach from `node`: in a selected branch of an `if`, and in any
 * statement a `switch`, `try`, loop, label or block holds, a clause the source does not select
 * among them. A loop's `break` and `continue` do not return from the function, and a function written
 * within the statement has its own returns.
 */
function conditionalReturn(
  node: Node,
  resolve: Resolve | undefined,
  returns: (node: ReturnStatement) => boolean,
): boolean {
  if (isReturnStatement(node)) {
    return returns(node);
  }
  if (isIfStatement(node)) {
    const branches = knownBranch(node, resolve) ?? [
      node.thenStatement,
      ...(node.elseStatement === undefined ? [] : [node.elseStatement]),
    ];
    return branches.some((branch) => conditionalReturn(branch, resolve, returns));
  }
  // An expression holds a return only in a function it writes, which returns from itself.
  if (isExpression(node) || isFunctionDeclaration(node) || isClassDeclaration(node)) {
    return false;
  }
  return (
    node.forEachChild((child) =>
      conditionalReturn(child, resolve, returns) ? true : undefined,
    ) === true
  );
}

/** A direct return after declarations, expressions or empty statements, without intervening branches. */
function returnsDirectly(block: Block): boolean {
  const first = block.statements.find((statement) => {
    return (
      !isEmptyStatement(statement) &&
      !isExpressionStatement(statement) &&
      !isVariableStatement(statement)
    );
  });
  return first !== undefined && isReturnStatement(first);
}

/** A finalizer's source return path that can replace the earlier completion. */
export function finallyReturns(
  block: Block,
  resolve: Resolve | undefined,
  returns: (node: ReturnStatement) => boolean,
): boolean {
  return returnsDirectly(block) || conditionalReturn(block, resolve, returns);
}

/**
 * What `statement` computes as it runs, each time: an expression's, a declaration's values; none of
 * another statement.
 */
export function computedBy(statement: Statement): readonly Expression[] | undefined {
  if (isExpressionStatement(statement)) {
    return [statement.expression];
  }
  return isVariableStatement(statement)
    ? statement.declarationList.declarations.flatMap((each) =>
        each.initializer === undefined ? [] : [each.initializer],
      )
    : undefined;
}

/** A loop's initial header work runs before its body can return, break or be skipped. */
export function loopHeaderThrows(
  statement: Statement,
  resolve: Resolve | undefined,
  check: (expression: Expression, resolve: Resolve | undefined) => Node | undefined,
): boolean {
  if (isWhileStatement(statement)) {
    return check(statement.expression, resolve) !== undefined;
  }
  if (!isForStatement(statement)) {
    return false;
  }
  const initial = statement.initializer;
  const expressions: Expression[] = [];
  if (initial !== undefined) {
    if (isVariableDeclarationList(initial)) {
      for (const each of initial.declarations) {
        if (each.initializer !== undefined && isExpression(each.initializer)) {
          expressions.push(each.initializer);
        }
      }
    } else if (isExpression(initial)) {
      expressions.push(initial);
    }
  }
  if (statement.condition !== undefined) {
    expressions.push(statement.condition);
  }
  return expressions.some((each) => check(each, resolve) !== undefined);
}

/** The executed prefix of a block, stopping where a statement may return or certainly throws. */
export function statementsThrowing(
  statements: readonly Statement[],
  resolve: Resolve | undefined,
  visit: (node: Node) => Node | undefined,
  endingOfStatement: (
    statement: Statement,
    resolve: Resolve | undefined,
  ) => 'returns' | 'runs' | 'throws',
): Node | undefined {
  for (const statement of statements) {
    const thrown = visit(statement);
    if (thrown !== undefined) {
      return thrown;
    }
    const ending = endingOfStatement(statement, resolve);
    if (ending === 'throws') {
      return statement;
    }
    if (
      ending === 'returns' &&
      conditionalReturn(
        statement,
        resolve,
        (each) => endingOfStatement(each, resolve) === 'returns',
      )
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** The ways a selected synchronous statement ends its enclosing invocation. */
type StatementEnd = 'returns' | 'runs' | 'throws';

/** Structured statements whose selected children require their own control-flow boundary. */
export function isBranchStatement(
  node: Node,
): node is IfStatement | TryStatement | SwitchStatement {
  return isIfStatement(node) || isTryStatement(node) || isSwitchStatement(node);
}

/** The executed tests and selected statements of an if, switch or exception boundary. */
export function branchThrows(
  node: IfStatement | TryStatement | SwitchStatement,
  resolve: Resolve | undefined,
  {
    visit,
    ending,
    escape,
  }: {
    readonly visit: (node: Node) => Node | undefined;
    readonly ending: (statement: Statement, resolve: Resolve | undefined) => StatementEnd;
    readonly escape: (node: TryStatement) => Node | undefined;
  },
): Node | undefined {
  if (isTryStatement(node)) {
    return escape(node);
  }
  if (isIfStatement(node)) {
    return (
      visit(node.expression) ??
      knownBranch(node, resolve)?.find((statement) => visit(statement) !== undefined)
    );
  }
  const plan = switchPlan(node, resolve);
  return (
    plan.checked.find((expression) => visit(expression) !== undefined) ??
    (plan.statements === undefined
      ? undefined
      : statementsThrowing(plan.statements, resolve, visit, ending))
  );
}

/**
 * The source-selected switch suffix, after each necessarily evaluated case test; of a value the
 * source does not give, it may return where any clause does, and otherwise it runs on.
 */
export function switchEnding(
  node: SwitchStatement,
  resolve: Resolve | undefined,
  ending: (statements: readonly Statement[], resolve: Resolve | undefined) => StatementEnd,
  check: (expression: Expression, resolve: Resolve | undefined) => Node | undefined,
): StatementEnd {
  const plan = switchPlan(node, resolve);
  if (plan.checked.some((expression) => check(expression, resolve) !== undefined)) {
    return 'throws';
  }
  if (plan.statements !== undefined) {
    return ending(plan.statements, resolve);
  }
  // Any clause may be the one that runs: a return in one may end the function, unless what it
  // returns throws first.
  const answers = (returned: ReturnStatement): boolean =>
    returned.expression === undefined || check(returned.expression, resolve) === undefined;
  return conditionalReturn(node.caseBlock, resolve, answers) ? 'returns' : 'runs';
}
