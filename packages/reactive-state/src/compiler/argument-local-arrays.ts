import {
  type Block,
  type CaseBlock,
  type ClassStaticBlockDeclaration,
  type ConstructorDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isCaseBlock,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isDefaultClause,
  isElementAccessExpression,
  isEnumDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isIdentifier,
  isModuleBlock,
  isModuleDeclaration,
  isNonNullExpression,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isStringLiteral,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type ModuleBlock,
  type ModuleDeclaration,
  type Node,
  type SetAccessorDeclaration,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { rootOf, targetsOf } from './kept.ts';
import { bindingIdentifiers, isBlockScoped, readsBinding } from './scope.ts';
import { writtenArgumentBy, writtenBy } from './written.ts';

/** Local-binding and cached fresh-local-array write exemptions for argument-effect checks. */

type FunctionOwner = Answering | ConstructorDeclaration | SetAccessorDeclaration;
type VarScopeOwner = ClassStaticBlockDeclaration | FunctionOwner | ModuleDeclaration | SourceFile;

interface VarScopeIndex {
  readonly bodyNode: Node | undefined;
  readonly otherHoistedCounts: ReadonlyMap<string, number>;
  readonly varDeclarations: ReadonlyMap<string, readonly VariableDeclaration[]>;
}

const LOCAL_ARRAY_CALLS: ReadonlySet<string> = new Set(['pop', 'push', 'shift', 'unshift']);
const COMPROMISED_ARRAYS = new WeakMap<Node, ReadonlySet<Node>>();
const VAR_SCOPES = new WeakMap<VarScopeOwner, VarScopeIndex>();
const LEXICAL_SCOPES = new WeakMap<Node, ReadonlyMap<string, number>>();

/** Every binding, member or argument target `node` mutates. */
export function allWrittenTargets(node: Node): readonly Node[] {
  const written = writtenBy(node);
  const primary = written === undefined ? [] : writeTargets(node, written);
  return [...primary, ...writtenArgumentBy(node).flatMap((each) => targetsOf(each))];
}

/** Rebinding a local or changing a fresh, un-reassigned local array's own storage stays local. */
export function localWrite(target: Node, operation: Node, fn: Node | undefined): boolean {
  if (fn === undefined) {
    return false;
  }
  const binding = directIdentifier(target);
  if (binding !== undefined && !isCallExpression(operation)) {
    const declared = frameDeclarationOf(binding);
    return declared !== undefined && within(declared, fn);
  }
  const arrayRoot = isCallExpression(operation) ? binding : arrayStorageRoot(target);
  const declared = arrayRoot === undefined ? undefined : frameDeclarationOf(arrayRoot);
  return declared !== undefined && within(declared, fn) && freshLocalArray(declared, fn);
}

/** Array insertion/removal has no callback when called on an uncompromised fresh local array. */
export function localArrayCall(node: Node, target: Node, fn: Node | undefined): boolean {
  if (!isCallExpression(node) || !localWrite(target, node, fn)) {
    return false;
  }
  const member = unwrapped(node.expression);
  return isPropertyAccessExpression(member) && LOCAL_ARRAY_CALLS.has(member.name.text);
}

/** Each binding or member target an assignment, loop or in-place write mutates. */
function writeTargets(node: Node, written: Node): readonly Node[] {
  const patterned =
    (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) ||
    isForOfStatement(node) ||
    isForInStatement(node);
  return patterned ? targetsOf(written) : [written];
}

/** A local variable initialized to an array literal that is never rebound or given own methods. */
function freshLocalArray(declared: Node, fn: Node): boolean {
  if (
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    declared.initializer === undefined ||
    !isArrayLiteralExpression(unwrapped(declared.initializer))
  ) {
    return false;
  }
  if (compromisedArraysIn(fn).has(declared)) {
    return false;
  }
  return unredeclaredBinding(declared, declared.name.text);
}

/** Checks that `declared` is not merged with another `var` or same-scope lexical declaration. */
function unredeclaredBinding(declared: VariableDeclaration, name: string): boolean {
  const varIndex = varScopeIndex(varScopeOf(declared));
  const vars = varIndex.varDeclarations.get(name) ?? [];
  if (isCatchClause(declared.parent)) {
    const catchScope = declared.parent;
    return vars.every((varDecl) => !within(varDecl, catchScope));
  }
  const extraHoisted = varIndex.otherHoistedCounts.get(name) ?? 0;
  if (!isVariableDeclarationList(declared.parent) || !isBlockScoped(declared.parent)) {
    return vars.length + extraHoisted <= 1;
  }
  const lexScope = lexicalScopeOf(declared);
  if (lexScope === varIndex.bodyNode && extraHoisted > 0) {
    return false;
  }
  if (vars.some((varDecl) => within(varDecl, lexScope))) {
    return false;
  }
  return (lexicalCounts(lexScope).get(name) ?? 0) <= 1;
}

/** Indexes compromised array declarations once per outer invocation root `fn`. */
function compromisedArraysIn(fn: Node): ReadonlySet<Node> {
  const cached = COMPROMISED_ARRAYS.get(fn);
  if (cached !== undefined) {
    return cached;
  }
  const declarations = new Set<Node>();
  const pending: Node[] = [fn];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const target of allWrittenTargets(current)) {
      const compromised = compromisedTargetDeclaration(current, target);
      if (compromised !== undefined) {
        declarations.add(compromised);
      }
    }
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  COMPROMISED_ARRAYS.set(fn, declarations);
  return declarations;
}

/** Nearest enclosing function body, class `static {}` block, namespace or `SourceFile` owning `var`s. */
function varScopeOf(node: Node): VarScopeOwner {
  let child = node;
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isModuleDeclaration(at) || isClassStaticBlockDeclaration(at)) {
      return at;
    }
    if (isFunctionOwner(at) && varScopeBody(at) === child) {
      return at;
    }
    child = at;
  }
  return node.getSourceFile();
}

/** Indexes hoisted `var` declarations, parameters and `FunctionDeclaration`s in `owner`'s scope. */
function varScopeIndex(owner: VarScopeOwner): VarScopeIndex {
  const cached = VAR_SCOPES.get(owner);
  if (cached !== undefined) {
    return cached;
  }
  const varDeclarations = new Map<string, VariableDeclaration[]>();
  const otherHoistedCounts = new Map<string, number>();
  if (isFunctionOwner(owner)) {
    for (const parameter of owner.parameters) {
      for (const bound of bindingIdentifiers(parameter.name)) {
        incrementCount(otherHoistedCounts, bound.text);
      }
    }
  }
  const bodyNode = varScopeBody(owner);
  if (bodyNode !== undefined) {
    walkVarScopeBody(bodyNode, varDeclarations, otherHoistedCounts);
  }
  const indexed: VarScopeIndex = { bodyNode, otherHoistedCounts, varDeclarations };
  VAR_SCOPES.set(owner, indexed);
  return indexed;
}

/** Walks `bodyNode` without crossing nested `var`-owning function, class or namespace boundaries. */
function walkVarScopeBody(
  bodyNode: Node,
  varDeclarations: Map<string, VariableDeclaration[]>,
  otherHoistedCounts: Map<string, number>,
): void {
  const pending: Node[] = [bodyNode];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current !== bodyNode && isVarBoundary(current)) {
      continue;
    }
    recordHoistedNode(current, varDeclarations, otherHoistedCounts);
    current.forEachChild((child) => {
      if (!isTypeNode(child)) {
        pending.push(child);
      }
    });
  }
}

/** Records non-ambient `var` declarations and `FunctionDeclaration`s within a single `var` scope. */
function recordHoistedNode(
  node: Node,
  varDeclarations: Map<string, VariableDeclaration[]>,
  otherHoistedCounts: Map<string, number>,
): void {
  if (isFunctionDeclaration(node) && node.name !== undefined) {
    incrementCount(otherHoistedCounts, node.name.text);
    return;
  }
  if (
    !isVariableDeclaration(node) ||
    !isVariableDeclarationList(node.parent) ||
    isBlockScoped(node.parent) ||
    isAmbientVar(node)
  ) {
    return;
  }
  for (const bound of bindingIdentifiers(node.name)) {
    let list = varDeclarations.get(bound.text);
    if (list === undefined) {
      list = [];
      varDeclarations.set(bound.text, list);
    }
    list.push(node);
  }
}

/** Immediate lexical container of a block-scoped `const`, `let` or `using` declaration. */
function lexicalScopeOf(declared: VariableDeclaration): Node {
  const list = declared.parent;
  const holder = list.parent;
  if (isForStatement(holder) || isForOfStatement(holder) || isForInStatement(holder)) {
    return holder;
  }
  const parent = holder.parent;
  return isCaseClause(parent) || isDefaultClause(parent) ? parent.parent : parent;
}

/** Counts direct lexical declarations in `scope` (`Block`, `CaseBlock`, loop header or module). */
function lexicalCounts(scope: Node): ReadonlyMap<string, number> {
  const cached = LEXICAL_SCOPES.get(scope);
  if (cached !== undefined) {
    return cached;
  }
  const counts = new Map<string, number>();
  if (isForStatement(scope) || isForOfStatement(scope) || isForInStatement(scope)) {
    if (scope.initializer !== undefined && isVariableDeclarationList(scope.initializer)) {
      countDeclarationList(scope.initializer.declarations, counts);
    }
  } else {
    for (const statement of directStatementsOf(scope)) {
      countStatementDeclarations(statement, counts);
    }
  }
  LEXICAL_SCOPES.set(scope, counts);
  return counts;
}

/** Adds direct block-scoped variable, function, class and enum names from `statement` to `counts`. */
function countStatementDeclarations(statement: Statement, counts: Map<string, number>): void {
  if (isVariableStatement(statement) && !hasDeclareModifier(statement)) {
    if (isBlockScoped(statement.declarationList)) {
      countDeclarationList(statement.declarationList.declarations, counts);
    }
    return;
  }
  if (
    (isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    incrementCount(counts, statement.name.text);
  }
}

/** Counts every bound identifier across `declarations`. */
function countDeclarationList(
  declarations: readonly VariableDeclaration[],
  counts: Map<string, number>,
): void {
  for (const declaration of declarations) {
    for (const bound of bindingIdentifiers(declaration.name)) {
      incrementCount(counts, bound.text);
    }
  }
}

/** Statements directly inside a `Block`, `CaseBlock`, `ModuleBlock` or `SourceFile`. */
function directStatementsOf(
  scope: Block | CaseBlock | ModuleBlock | Node | SourceFile,
): readonly Statement[] {
  if (isBlock(scope) || isModuleBlock(scope) || isSourceFile(scope)) {
    return scope.statements;
  }
  return isCaseBlock(scope) ? scope.clauses.flatMap((clause) => clause.statements) : [];
}

/** Body node within which `owner`'s hoisted `var`s reside. */
function varScopeBody(owner: VarScopeOwner): Node | undefined {
  if (isSourceFile(owner)) {
    return owner;
  }
  return owner.body;
}

/** Callable AST nodes whose `body` establishes an independent `var` hoisting scope. */
function isFunctionOwner(node: Node): node is FunctionOwner {
  return isAnswering(node) || isConstructorDeclaration(node) || isSetAccessorDeclaration(node);
}

/** Nodes that establish their own `var` scope and stop outer `var` collection. */
function isVarBoundary(node: Node): boolean {
  return (
    isFunctionOwner(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node) ||
    isClassStaticBlockDeclaration(node) ||
    isModuleDeclaration(node)
  );
}

/** Ambient `declare var` statements bind no runtime storage. */
function isAmbientVar(declaration: VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return isVariableStatement(statement) && hasDeclareModifier(statement);
}

/** Checks whether `statement` carries a TypeScript `declare` modifier. */
function hasDeclareModifier(statement: Statement): boolean {
  return (
    isVariableStatement(statement) &&
    (statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword) ?? false)
  );
}

/** Increments `name`'s entry in `counts`. */
function incrementCount(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** The declaration compromised when `(node, target)` rebinds, customizes or escapes an array. */
function compromisedTargetDeclaration(node: Node, target: Node): Node | undefined {
  const root = rootOf(target);
  const declared = root === undefined ? undefined : frameDeclarationOf(root);
  if (declared === undefined) {
    return undefined;
  }
  if (isCallExpression(node)) {
    const member = unwrapped(node.expression);
    const receiver = isPropertyAccessExpression(member)
      ? directIdentifier(member.expression)
      : undefined;
    return receiver !== undefined && frameDeclarationOf(receiver) === declared
      ? undefined
      : declared;
  }
  return arrayStorageRoot(target) === undefined ? declared : undefined;
}

/** The direct local array binding when `node` names its `length` or a literal integer slot. */
function arrayStorageRoot(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  if (isPropertyAccessExpression(plain)) {
    return plain.name.text === 'length' ? directIdentifier(plain.expression) : undefined;
  }
  if (!isElementAccessExpression(plain)) {
    return undefined;
  }
  const key = unwrapped(plain.argumentExpression);
  const integerSlot =
    (isNumericLiteral(key) || isStringLiteral(key)) &&
    /^(?:0|[1-9]\d*)$/u.test(key.text) &&
    Number.isSafeInteger(Number(key.text));
  return integerSlot ? directIdentifier(plain.expression) : undefined;
}

/** A direct binding read rather than a member or nested element access. */
function directIdentifier(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  return isIdentifier(plain) && readsBinding(plain) ? plain : undefined;
}

/** A write target peeled of parentheses, casts and non-null assertions. */
function plainTarget(node: Node): Node {
  let each = node;
  while (
    isParenthesizedExpression(each) ||
    isAsExpression(each) ||
    isSatisfiesExpression(each) ||
    isNonNullExpression(each)
  ) {
    each = each.expression;
  }
  return each;
}

/** A declaration owned by this invocation rather than captured from a caller. */
function within(node: Node, owner: Node): boolean {
  for (let at: Node = node; at.kind !== SyntaxKind.SourceFile; at = at.parent) {
    if (at === owner) {
      return true;
    }
  }
  return owner.kind === SyntaxKind.SourceFile;
}
