import {
  type Block,
  type Expression,
  isBlock,
  isFunctionDeclaration,
  isIfStatement,
  isInterfaceDeclaration,
  isReturnStatement,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Statement,
  type VariableStatement,
} from 'typescript/ast';

import { framedCondition } from './framed-sources.ts';

/** Reachable synchronous returns within written if branches, without evaluating application effects. */
export function framedFactoryReturns(
  body: Block,
  constant: (statement: VariableStatement) => boolean,
): readonly Expression[] | undefined {
  const flow: FactoryFlow = { constant, pending: [body.statements], seen: new Set(), values: [] };
  for (
    let statements = flow.pending.pop();
    statements !== undefined;
    statements = flow.pending.pop()
  ) {
    if (!collectStatements(statements, flow)) return undefined;
  }
  return flow.values;
}

interface FactoryFlow {
  readonly constant: (statement: VariableStatement) => boolean;
  readonly pending: (readonly Statement[])[];
  readonly seen: Set<Statement>;
  readonly values: Expression[];
}

/** Each statement and its one syntactic continuation are processed once, retaining early returns. */
function collectStatements(statements: readonly Statement[], flow: FactoryFlow): boolean {
  for (const [index, statement] of statements.entries()) {
    if (flow.seen.has(statement)) break;
    flow.seen.add(statement);
    if (isReturnStatement(statement)) {
      if (statement.expression !== undefined) flow.values.push(statement.expression);
      break;
    }
    if (isBlock(statement) || isIfStatement(statement)) {
      const rest = statements.slice(index + 1);
      flow.pending.push(...branchStatements(statement).map((branch) => [...branch, ...rest]));
      break;
    }
    if (!transparentStatement(statement, flow.constant)) return false;
  }
  return true;
}

/** Each possible if branch continues at the same suffix; known conditions exclude the other branch. */
function branchStatements(statement: Statement): readonly (readonly Statement[])[] {
  if (isBlock(statement)) return [statement.statements];
  if (!isIfStatement(statement)) return [];
  const condition = framedCondition(statement.expression);
  const branches =
    condition === undefined
      ? [statement.thenStatement, statement.elseStatement]
      : [condition ? statement.thenStatement : statement.elseStatement];
  return branches.map((branch) => (branch === undefined ? [] : [branch]));
}

/** The declarations already allowed in a flat factory remain transparent between its returns. */
function transparentStatement(
  statement: Statement,
  constant: (statement: VariableStatement) => boolean,
): boolean {
  return (
    isFunctionDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    (isVariableStatement(statement) && constant(statement))
  );
}
