import {
  type Block,
  type Expression,
  type IfStatement,
  isBlock,
  isBreakStatement,
  isContinueStatement,
  isFunctionDeclaration,
  isIfStatement,
  isNewExpression,
  isReturnStatement,
  isSwitchStatement,
  isThrowStatement,
  isTryStatement,
  type Node,
  type Statement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { runsLater } from '../src/compiler/deferred-syntax.ts';
import type { Resolve } from '../src/compiler/numbers.ts';
import {
  branchThrows,
  computedBy,
  finallyReturns,
  isBranchStatement,
  knownBranch,
  statementsThrowing,
  switchEnding,
} from '../src/compiler/throw-branches.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Where the scan of a block for a throw its code surely reaches stops: at a statement that may
 * return — whichever statement holds the `return`, a `switch`, a `try`, a loop, a label — and not
 * at a `break` or a `continue`, which leave a loop or a `switch`, not the function.
 *
 * `throws-always.ts`, which calls these functions, is not in this tree: the callbacks below are its
 * `statementEnding`, `endingOf` and `ifEnding` as far as the functions under test call them.
 */

type Ending = 'returns' | 'runs' | 'throws';

const NOTHING: Resolve | undefined = undefined;

/** The expressions of these fixtures that throw where they stand: none, a `throw` statement ends a scan. */
function noThrow(expression: Expression): Expression | undefined {
  return isNewExpression(expression) ? expression : undefined;
}

/** How `statements`, run in turn, end the function they stand in. */
function endingOf(statements: readonly Statement[], resolve: Resolve | undefined): Ending {
  for (const statement of statements) {
    const ending = statementEnding(statement, resolve);
    if (ending !== 'runs') {
      return ending;
    }
  }
  return 'runs';
}

/** Whether `statement` may leave the function: a `return`, `break` or `continue` within it. */
function mayLeave(statement: Node): boolean {
  if (
    isReturnStatement(statement) ||
    isBreakStatement(statement) ||
    isContinueStatement(statement)
  ) {
    return true;
  }
  let found = false;
  statement.forEachChild((child) => {
    found ||= !runsLater(child) && mayLeave(child);
  });
  return found;
}

function ifEnding(statement: IfStatement, resolve: Resolve | undefined): Ending {
  const branch = knownBranch(statement, resolve);
  if (branch !== undefined) {
    return endingOf(branch, resolve);
  }
  const then = statementEnding(statement.thenStatement, resolve);
  const otherwise =
    statement.elseStatement === undefined
      ? 'runs'
      : statementEnding(statement.elseStatement, resolve);
  if (then === 'throws' && otherwise === 'throws') {
    return 'throws';
  }
  return then === 'returns' || otherwise === 'returns' ? 'returns' : 'runs';
}

function statementEnding(statement: Statement, resolve: Resolve | undefined): Ending {
  if (isThrowStatement(statement)) {
    return 'throws';
  }
  if (isBlock(statement)) {
    return endingOf(statement.statements, resolve);
  }
  if (isIfStatement(statement)) {
    return ifEnding(statement, resolve);
  }
  if (isSwitchStatement(statement)) {
    return switchEnding(statement, resolve, endingOf, noThrow);
  }
  if (isReturnStatement(statement)) {
    return 'returns';
  }
  if (computedBy(statement) !== undefined) {
    return 'runs';
  }
  return mayLeave(statement) ? 'returns' : 'runs';
}

/** The walk of a block as the compiler's, with no expression that throws: only the statements end it. */
function visit(node: Node): Node | undefined {
  if (isBlock(node)) {
    return statementsThrowing(node.statements, NOTHING, visit, statementEnding);
  }
  if (isBranchStatement(node)) {
    return branchThrows(node, NOTHING, {
      ending: statementEnding,
      escape: (part) => {
        const tried = visit(part.tryBlock);
        return tried ?? (part.finallyBlock === undefined ? undefined : visit(part.finallyBlock));
      },
      visit,
    });
  }
  return node.forEachChild(visit);
}

/** Runs `check` on the body of `function f() { … }`, written with `x` and `items` declared. */
function inBody<T>(source: string, check: (body: Block) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'branch-returns.ts',
    `declare const x: number; declare const items: number[];\nfunction f() {\n${source}\n}\n`,
  );
  const fn = parsed.sourceFile.statements.find((each) => isFunctionDeclaration(each));
  if (fn?.body === undefined) {
    throw new Error('The fixture declares f.');
  }
  return check(fn.body);
}

/** One block of code, and whether the scan of it ends at a throw its code surely reaches. */
interface Scanned {
  readonly id: string;
  readonly body: string;
  readonly throws: boolean;
}

const SCANNED: readonly Scanned[] = [
  // What stays reported: nothing before the throw may leave the function.
  { body: "throw new Error('x');", id: 'a bare throw', throws: true },
  {
    body: "for (const item of items) { if (item === x) { break; } } throw new Error('x');",
    id: 'a break leaves the loop, the throw after it runs',
    throws: true,
  },
  {
    body: "switch (x) { case 1: items.push(1); break; } throw new Error('x');",
    id: 'a break leaves the switch, the throw after it runs',
    throws: true,
  },
  {
    body: "switch (x) { case 1: items.push(1); } throw new Error('x');",
    id: 'a switch with no return',
    throws: true,
  },
  {
    body: "for (const item of items) { function pick() { return item; } } throw new Error('x');",
    id: 'a return of a function declared in the loop is its own',
    throws: true,
  },
  {
    body: "for (const item of items) { (() => { return item; })(); } throw new Error('x');",
    id: 'a return of an arrow function in the loop is its own',
    throws: true,
  },
  {
    body: "for (const item of items) { if (false) { return item; } } throw new Error('x');",
    id: 'a return of a branch the source never selects',
    throws: true,
  },
  // What the conditional return shape already stopped at.
  {
    body: "if (x) { return 1; } throw new Error('x');",
    id: 'a return under an if',
    throws: false,
  },
  {
    body: "{ if (x) { return 1; } } throw new Error('x');",
    id: 'a return under an if in a block',
    throws: false,
  },
  // What returns in a statement the shape did not read: the throw after it may not run.
  {
    body: "try { if (x) { return 1; } } catch {} throw new Error('x');",
    id: 'a return in a try block',
    throws: false,
  },
  {
    body: "try { items.push(1); } catch { return 2; } throw new Error('x');",
    id: 'a return in a catch block',
    throws: false,
  },
  {
    body: "try { items.push(1); } finally { if (x) { return 3; } } throw new Error('x');",
    id: 'a return in a finally block',
    throws: false,
  },
  {
    body: "for (const item of items) { if (item === x) { return item; } } throw new Error('x');",
    id: 'a return in a for-of loop',
    throws: false,
  },
  {
    body: "while (x > 0) { return 1; } throw new Error('x');",
    id: 'a return in a while loop',
    throws: false,
  },
  {
    body: "do { if (x > 5) { return 1; } } while (x > 9); throw new Error('x');",
    id: 'a return in a do-while loop',
    throws: false,
  },
  {
    body: "outer: { if (x) { return 1; } } throw new Error('x');",
    id: 'a return in a labeled block',
    throws: false,
  },
  {
    body: "switch (0) { default: switch (0) { default: return 1; } throw new Error('unreachable'); }",
    id: 'a switch of a literal that returns, inside one',
    throws: false,
  },
  {
    body: "switch (0) { default: try { return 1; } catch {} throw new Error('unreachable'); }",
    id: 'a try that returns, inside a switch of a literal',
    throws: false,
  },
  {
    body: "switch (0) { default: for (const item of items) { return item; } throw new Error('after'); }",
    id: 'a loop that returns, inside a switch of a literal',
    throws: false,
  },
];

describe('the scan of a block stops at a statement that may return', () => {
  it.each(SCANNED)('$id', ({ body, throws }) => {
    const found = inBody(body, (block) =>
      statementsThrowing(block.statements, NOTHING, visit, statementEnding),
    );

    expect(found !== undefined).toBe(throws);
  });
});

/** A finalizer, and whether it may return, replacing what the try block did. */
interface Finalizer {
  readonly id: string;
  readonly finalizer: string;
  readonly returns: boolean;
}

const FINALIZERS: readonly Finalizer[] = [
  { finalizer: 'return 1;', id: 'a return', returns: true },
  { finalizer: 'if (x) { return 1; }', id: 'a return under an if', returns: true },
  { finalizer: 'items.push(1);', id: 'no return', returns: false },
  {
    finalizer: 'if (false) { return 1; }',
    id: 'a return of a branch never selected',
    returns: false,
  },
  {
    finalizer: 'for (const item of items) { if (item === x) { break; } }',
    id: 'a break of its loop',
    returns: false,
  },
  {
    finalizer: 'for (const item of items) { if (item === x) { return item; } }',
    id: 'a return in a loop',
    returns: true,
  },
  { finalizer: 'switch (x) { case 1: return 1; }', id: 'a return in a switch', returns: true },
  { finalizer: 'try { return 1; } catch {}', id: 'a return in a try block', returns: true },
  { finalizer: 'inner: { return 1; }', id: 'a return in a labeled block', returns: true },
  {
    finalizer: 'for (const item of items) { function pick() { return item; } }',
    id: 'a return of a function declared in it',
    returns: false,
  },
];

describe('a finalizer that may return replaces what its try block did', () => {
  it.each(FINALIZERS)('$id', ({ finalizer, returns }) => {
    const found = inBody(`try { items.push(0); } finally { ${finalizer} }`, (block) => {
      const statement = block.statements.find((each) => isTryStatement(each));
      if (
        statement === undefined ||
        !isTryStatement(statement) ||
        statement.finallyBlock === undefined
      ) {
        throw new Error('The fixture holds a try with a finalizer.');
      }
      return finallyReturns(statement.finallyBlock, NOTHING, () => true);
    });

    expect(found).toBe(returns);
  });
});
