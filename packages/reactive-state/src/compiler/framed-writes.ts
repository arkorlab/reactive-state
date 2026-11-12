import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isFunctionDeclaration,
  isClassDeclaration,
  isConstructorDeclaration,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isBlock,
  isBreakStatement,
  isContinueStatement,
  isExpressionStatement,
  isExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isVariableDeclarationList,
  isTypeNode,
  isNumericLiteral,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  type VariableDeclaration,
  isIfStatement,
  isLabeledStatement,
  isSourceFile,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSpreadElement,
  isSwitchStatement,
  isThrowStatement,
  isTryStatement,
  isVariableDeclaration,
  isVariableStatement,
  isWhileStatement,
  type BreakOrContinueStatement,
  type Node,
  type Statement,
  type TryStatement,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import {
  type AssignedFrameSource,
  assignmentPatternDefault,
  assignmentPatternSources,
  iteratedAssignmentSources,
} from './framed-assignment-patterns.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedPossibleBranch } from './framed-branches.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { isNamedFunction, madeWithin, runsItself } from './framed-recursion.ts';
import { framedCondition } from './framed-sources.ts';
import { readsBinding } from './scope.ts';

/** Source-visible assignments that can supply a local receiver at its lexical read. */

const DIRECT_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Earlier same-owner writes and possible cross-owner writes, retaining lexical binding identity. */
export function framedAssignedValues(name: Identifier): readonly Expression[] {
  return framedAssignedSources(name).map((source) => source.value);
}

/** Pattern selections retain their remaining member path when only a declared source type is known. */
export function framedAssignedSources(name: Identifier): readonly AssignedFrameSource[] {
  const declared = frameDeclarationOf(name);
  if (declared === undefined) return [];
  const values: AssignedFrameSource[] = [];
  const owner = executionOwner(name);
  const cutoff = dataOverwrite(name, owner, declared);
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      (isBinaryExpression(node) || isForOfStatement(node)) &&
      !overwrittenSource(node, cutoff, owner) &&
      framedPossibleBranch(node)
    )
      values.push(...assignedAt(node, name, declared, { owner, cutoff }));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/** Direct and iteration assignments supply the same lexical pattern targets. */
function assignedAt(
  node: Node,
  name: Identifier,
  declared: NonNullable<ReturnType<typeof frameDeclarationOf>>,
  context: { readonly owner: Node; readonly cutoff: Node | undefined },
): readonly AssignedFrameSource[] {
  if (!possibleWriteBefore(node, name, declared, context)) return [];
  if (
    isBinaryExpression(node) &&
    DIRECT_WRITES.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  )
    return assignmentPatternSources(node.left, node.right, name, declared);
  if (isForOfStatement(node) && isExpression(node.initializer))
    return iteratedAssignmentSources(node.initializer, node.expression, name, declared);
  return [];
}

/**
 * Referenced closures remain possible; an entirely unreferenced nested declaration does not run. A
 * write in what a pattern destructures runs before the pattern's defaults and computed keys.
 */
function possibleWriteBefore(
  node: Node,
  name: Identifier,
  declared: Node,
  context: { readonly owner: Node; readonly cutoff: Node | undefined },
): boolean {
  const { owner, cutoff } = context;
  const writer = executionOwner(node);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  return (
    node.pos < name.pos ||
    destructuredFirst(node, name) ||
    repeatedFrameRead(node, name, declared, owner) ||
    (cutoff === undefined && bindingOwner(declared) !== owner)
  );
}

/** Named function and class values are bound where their declaration is evaluated. */
function bindingOwner(declared: Node): Node {
  return executionOwner(
    isFunctionDeclaration(declared) || isClassDeclaration(declared) ? declared.parent : declared,
  );
}

/**
 * A later write in a repeatable loop around a read can reach that read on the next pass where the
 * write lies in the loop's body, condition, update or iteration binding rather than a for
 * initializer or iterable that runs once, and so does the read: one in a part that runs once is
 * reached by no pass, unless the body initializes the binding anew first.
 */
export function repeatedFrameRead(node: Node, name: Node, declared: Node, owner: Node): boolean {
  return repeatingBodies(node, name, declared, owner).length > 0;
}

/** The bodies of the loops around a read that bring a later write back to it, as it asks. */
export function repeatingBodies(
  node: Node,
  name: Node,
  declared: Node,
  owner: Node,
): readonly Node[] {
  const bodies: Node[] = [];
  for (let at = name.parent; at !== owner; at = at.parent) {
    const body = loopBody(at);
    if (
      body !== undefined &&
      canRepeat(at) &&
      withinBody(node, at) &&
      !runsOnce(node, at) &&
      !runsOnce(name, at) &&
      !leavesLoopFirst(node, body, declared) &&
      !initializedWithin(declared, name, body)
    )
      bodies.push(body);
  }
  return bodies;
}

/**
 * Whether a statement that holds the write is a return or a throw that leaves the loop: the write
 * is made, and the statement goes on to leave, as a return after it does, past the same try
 * statements. A return that is the whole body of the loop leaves it.
 */
function exitsWithWrite(statement: Node, body: Node): boolean {
  if (!isReturnStatement(statement) && !isThrowStatement(statement)) return false;
  if (statement === body) return true;
  let block = statement.parent;
  while (block !== body && !isBlock(block)) block = block.parent;
  return (block === body || isBlock(block)) && leavesBody(statement, block, body);
}

/**
 * Whether a write in the loop's body is always followed by a statement of a block around it that
 * leaves the loop, with no jump between them that may skip it: the loop never comes round to its
 * next pass.
 */
function leavesLoopFirst(node: Node, body: Node, declared: Node): boolean {
  if (!withinBody(node, body) || runsAgainAround(body, declared)) return false;
  for (let at = node; ; at = at.parent) {
    if (exitsWithWrite(at, body)) return true;
    if (at === body) return false;
    const { parent } = at;
    if (!isBlock(parent)) continue;
    const exit = parent.statements.find(
      (each) => each.pos >= at.end && leavesBody(each, parent, body),
    );
    if (exit !== undefined && !jumpsOver(body, node, exit, body)) return true;
  }
}

/**
 * Whether a function around the loop that is called by a name runs itself again, unless the array
 * is made inside it and each run makes its own: the run can come again before it ends, and what a
 * write leaves reaches the loop in that run, though the first leaves its loop.
 */
function runsAgainAround(body: Node, declared: Node): boolean {
  for (let at = body.parent; !isSourceFile(at); at = at.parent)
    if (isNamedFunction(at) && !madeWithin(declared, at) && runsItself(at)) return true;
  return false;
}

/**
 * Whether a statement of `block`, a block within the body, leaves the loop whose body it is: a
 * return or a throw, or a break whose loop, switch or label holds the loop, where no function lies
 * between and no try statement goes on after it.
 */
function leavesBody(statement: Statement, block: Node, body: Node): boolean {
  if (isBreakStatement(statement)) {
    const target = jumpTarget(statement);
    const loop = body.parent;
    if (target === undefined || target.pos > loop.pos || loop.end > target.end) return false;
  } else if (!isReturnStatement(statement) && !isThrowStatement(statement)) return false;
  for (let at = block.parent, from = block; from !== body; from = at, at = at.parent) {
    if (isAnswering(at) || isConstructorDeclaration(at) || isSetAccessorDeclaration(at))
      return false;
    if (isTryStatement(at) && resumesAfter(at, from)) return false;
  }
  return true;
}

/**
 * Whether a try statement between `node` and the first of the `limits` that it lies in may go on
 * after what happens in `node`, as `resumesAfter` asks.
 */
export function resumesWithin(node: Node, limits: readonly Node[]): boolean {
  for (let at = node.parent, from = node; !limits.includes(from); from = at, at = at.parent)
    if (isTryStatement(at) && resumesAfter(at, from)) return true;
  return false;
}

/**
 * Whether a try statement goes on after an exception, or a jump, in the part `from` of it: a catch
 * takes what its try block throws, and a finally with a continue or a break of its own may resume
 * the loop whatever happened; a finally alone only lets the exception, or the exit, go on.
 */
function resumesAfter(statement: TryStatement, from: Node): boolean {
  if (from === statement.tryBlock && statement.catchClause !== undefined) return true;
  const { finallyBlock } = statement;
  return finallyBlock !== undefined && from !== finallyBlock && jumpsOut(finallyBlock);
}

/**
 * Whether a continue or a break that may run lies in the block and lands outside it, wherever it is
 * nested: one that only leaves a loop, a switch or a labeled statement within the block goes on
 * inside it.
 */
function jumpsOut(block: Node): boolean {
  const pending: Node[] = [block];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if ((isContinueStatement(each) || isBreakStatement(each)) && framedPossibleBranch(each)) {
      const destination = jumpTarget(each);
      if (destination === undefined || destination.pos < block.pos || destination.end > block.end)
        return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether a continue, a break or a return between a write and `target`, in `scope`, lands past
 * `target`: the loop, switch or labeled statement it leaves or goes round holds `target`, or the
 * function it returns from, a function within the loop's `body`, does, and so leaves it behind;
 * one that lands before it, out of an inner statement, does not, nor one in an arm a written
 * condition rules out. A write in a finally block is run by the jumps of its try and catch blocks
 * on their way out, whatever their place before it, unless `target` lies in the block too.
 */
export function jumpsOver(scope: Node, write: Node, target: Node, body: Node): boolean {
  const loops = loopsRound(write, scope, target);
  const base = pendingFrom(write, scope, target);
  const from = Math.min(base, ...loops.map((each) => each.pos));
  const pending: Node[] = [scope];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      (isContinueStatement(node) || isBreakStatement(node) || isReturnStatement(node)) &&
      node.pos >= from &&
      node.pos < target.pos &&
      framedPossibleBranch(node) &&
      !(node.pos < base && endsRun(node, body)) &&
      !inExclusiveArms(write, node, loops) &&
      skips(node, target, body)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a break leaves the loop whose body it is asked about, or one around it: no pass follows. */
function endsRun(jump: Node, body: Node): boolean {
  if (!isBreakStatement(jump)) return false;
  const destination = jumpTarget(jump);
  return destination !== undefined && destination.pos <= body.pos && body.end <= destination.end;
}

/**
 * Whether two nodes lie in the two arms of one if statement or conditional expression: where the
 * one runs the other does not, so a jump in the second skips nothing after a write in the first. A
 * jump that holds the write is not in an arm of its own: it goes after the write is made. Within a
 * loop that comes round to the write, the two arms run in different passes.
 */
function inExclusiveArms(first: Node, second: Node, loops: readonly Node[]): boolean {
  if (second.pos <= first.pos && first.end <= second.end) return false;
  for (let at = first; !isSourceFile(at); at = at.parent) {
    const { parent } = at;
    if (parent.pos > second.pos || parent.end < second.end) continue;
    if (loops.some((each) => withinBody(parent, each))) return false;
    let other = second;
    while (other.parent !== parent) other = other.parent;
    let arms: readonly (Node | undefined)[] = [];
    if (isIfStatement(parent)) arms = [parent.thenStatement, parent.elseStatement];
    else if (isConditionalExpression(parent)) arms = [parent.whenTrue, parent.whenFalse];
    return at !== other && arms.includes(at) && arms.includes(other);
  }
  return false;
}

/** Whether a jump leaves `target` behind, where it is not found to land elsewhere. */
function skips(jump: Node, target: Node, body: Node): boolean {
  if (isReturnStatement(jump)) return returnsPast(jump, target, body);
  const destination = jumpTarget(jump as BreakOrContinueStatement);
  return (
    destination === undefined || (destination.pos <= target.pos && target.end <= destination.end)
  );
}

/**
 * Whether a return leaves a function within the loop's body that holds `target`, as an immediately
 * invoked function that the run flattens into its caller does, and the loop goes on; a return of
 * the function that holds the loop ends the run, and one of a function that does not hold
 * `target` skips nothing of it.
 */
function returnsPast(statement: Node, target: Node, body: Node): boolean {
  for (let at = statement.parent; !isSourceFile(at); at = at.parent) {
    if (!isAnswering(at) && !isConstructorDeclaration(at) && !isSetAccessorDeclaration(at))
      continue;
    const inside = at.pos >= body.pos && at.end <= body.end;
    return inside && at.pos <= target.pos && target.end <= at.end;
  }
  return false;
}

/**
 * The loops within `scope` that hold the write and not `target`, and may come round to the write
 * again before they end: a jump of theirs that lies before the write in the source may run after
 * the write in a later pass, and the arms of a branch of theirs run in different passes.
 */
function loopsRound(write: Node, scope: Node, target: Node): readonly Node[] {
  const loops: Node[] = [];
  let within = write;
  for (let at = write.parent; at !== scope && !isSourceFile(at); within = at, at = at.parent)
    if (canRepeat(at) && !runsOnce(within, at) && !withinBody(target, at)) loops.push(at);
  return loops;
}

/**
 * Where the jumps pending when the write runs begin: at the try statement of a finally block, but
 * for a `target` in that block, which the jumps run through and which may replace them.
 */
function pendingFrom(write: Node, scope: Node, target: Node): number {
  let from = write.pos;
  for (let at = write; at !== scope && !isSourceFile(at); at = at.parent) {
    const { parent } = at;
    const within = target.pos >= at.pos && target.end <= at.end;
    if (!within && isTryStatement(parent) && isBlock(at) && parent.finallyBlock === at)
      from = Math.min(from, parent.pos);
  }
  return from;
}

/** The loop, switch or labeled statement a break or continue leaves or goes round, if it is found. */
function jumpTarget(jump: BreakOrContinueStatement): Node | undefined {
  const breaks = isBreakStatement(jump);
  for (let at = jump.parent; !isSourceFile(at) && !isAnswering(at); at = at.parent) {
    if (jump.label === undefined) {
      if (loopBody(at) !== undefined || (breaks && isSwitchStatement(at))) return at;
    } else if (isLabeledStatement(at) && at.label.text === jump.label.text) return at;
  }
  return undefined;
}

/** A for initializer and a for-of or for-in iterable run once, before the loop's first pass. */
function runsOnce(node: Node, loop: Node): boolean {
  if (isForStatement(loop))
    return loop.initializer !== undefined && withinBody(node, loop.initializer);
  return (isForOfStatement(loop) || isForInStatement(loop)) && withinBody(node, loop.expression);
}

/** The written body of the language's loop forms, one of the parts each later pass repeats. */
function loopBody(node: Node): Node | undefined {
  return isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node)
    ? node.statement
    : undefined;
}

/** A false loop condition or a fixed singleton iterable cannot produce a second iteration. */
function canRepeat(node: Node): boolean {
  if (isWhileStatement(node) || isDoStatement(node))
    return framedCondition(node.expression) !== false;
  if (isForStatement(node))
    return node.condition === undefined || framedCondition(node.condition) !== false;
  if (isForOfStatement(node)) {
    const value = unwrapped(node.expression);
    return (
      !isArrayLiteralExpression(value) ||
      value.elements.length > 1 ||
      value.elements.some((each) => isSpreadElement(each))
    );
  }
  return isForInStatement(node);
}

/** An unconditional declaration prefix initializes this binding whenever that body reaches its read. */
function initializedWithin(declared: Node, name: Node, body: Node): boolean {
  if (!isVariableDeclaration(declared) || declared.initializer === undefined) return false;
  const statement = declared.parent.parent;
  return (
    isVariableStatement(statement) &&
    statement.pos < name.pos &&
    withinBody(statement, body) &&
    withinBody(name, statement.parent)
  );
}

/** Whether a syntax node belongs to this enclosing body. */
function withinBody(node: Node, body: Node): boolean {
  for (let at = node; ; at = at.parent) {
    if (at === body) return true;
    if (isSourceFile(at)) return false;
  }
}

/** The synchronous body whose textual prefix constrains a write; another body may run later. */
function executionOwner(node: Node): Node {
  for (let at = node, within = node; ; within = at, at = at.parent) {
    if (
      (isPropertyDeclaration(at) &&
        isExpression(within) &&
        within === at.initializer &&
        at.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true) ||
      isAnswering(at) ||
      isConstructorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isClassStaticBlockDeclaration(at) ||
      isSourceFile(at)
    )
      return at;
  }
}

/** A closed, same-block data assignment replaces older same-owner values before this read. */
function dataOverwrite(
  name: Identifier,
  owner: Node,
  declared: NonNullable<ReturnType<typeof frameDeclarationOf>>,
): Node | undefined {
  for (let at: Node = name; at !== owner; at = at.parent)
    if (loopBody(at) !== undefined) return undefined;
  let at: Node = name;
  while (!isBlock(at.parent) && !isSourceFile(at.parent)) at = at.parent;
  let last: Node | undefined;
  for (const statement of at.parent.statements) {
    if (statement === at) break;
    if (!isExpressionStatement(statement)) continue;
    const value = unwrapped(statement.expression);
    if (
      isBinaryExpression(value) &&
      value.operatorToken.kind === SyntaxKind.EqualsToken &&
      isIdentifier(value.left) &&
      frameDeclarationOf(value.left) === declared &&
      executionOwner(value) === owner &&
      closedData(value.right)
    )
      last = value;
  }
  return last;
}

/** A possible closure write remains independent of a same-owner overwrite. */
function overwrittenSource(node: Node, cutoff: Node | undefined, owner: Node): boolean {
  return (
    cutoff !== undefined &&
    node !== cutoff &&
    node.end <= cutoff.end &&
    executionOwner(node) === owner
  );
}

/** Literal data and unexposed constant aliases establish a data replacement without call inference. */
function closedData(node: Expression): boolean {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected === undefined ||
      selected.keys.length > 0 ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined ||
      otherUse(value, binding)
    )
      return false;
    value = unwrapped(binding.initializer);
  }
  if (!isObjectLiteralExpression(value)) return primitiveData(value);
  return value.properties.every((property) => {
    if (!isPropertyAssignment(property)) return false;
    const key = property.name;
    const name =
      isIdentifier(key) ||
      isStringLiteral(key) ||
      isNoSubstitutionTemplateLiteral(key) ||
      isNumericLiteral(key)
        ? key.text
        : undefined;
    return (
      name !== undefined && name !== '__proto__' && primitiveData(unwrapped(property.initializer))
    );
  });
}

/** A primitive literal value neither inherits Error identity nor invokes application conversion. */
function primitiveData(value: Expression): boolean {
  return (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** Another value reference can mutate or expose an object alias, so it removes a closed-data proof. */
function otherUse(name: Identifier, binding: VariableDeclaration): boolean {
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      node !== name &&
      node !== binding.name &&
      isIdentifier(node) &&
      readsBinding(node) &&
      frameDeclarationOf(node) === binding
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

export { framedPossibleBranch } from './framed-branches.ts';
