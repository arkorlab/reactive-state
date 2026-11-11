import {
  type BindingName,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isBlock,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isDecorator,
  isEnumDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceImport,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
  isSignatureDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { constructorReferences, fileConstructorReference } from './file-constructor-references.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers, hoistedIn, readsBinding } from './scope.ts';

/** File constructions whose options cannot supply a timestamp independent of the clock. */

type Timestamp = 'absent' | 'defined' | 'unknown';
type Binding = VariableDeclaration | null | undefined;

/**
 * Whether a global File reference can escape construction with a timestamp shown defined. A
 * reference only tested, `typeof File` or `value instanceof File`, constructs nothing.
 */
export function fileReferenceReadsClock(reference: Identifier): boolean {
  if (!fileConstructorReference(reference)) return false;
  const pending = [reference];
  const seen = new Set<VariableDeclaration>();
  for (let read = pending.pop(); read !== undefined; read = pending.pop()) {
    const { at, parent } = useOf(read);
    const expression = at as Expression;
    if (isNewExpression(parent) && parent.expression === expression) {
      if (!hasFileTimestamp(parent)) return true;
      continue;
    }
    if (isTested(parent, expression)) continue;
    const aliased = aliasReads(parent, expression, seen);
    if (aliased === undefined) return true;
    pending.push(...aliased);
  }
  return false;
}

/**
 * Whether `parent` only tests what `at` is: the operand of `typeof`, or the right of `instanceof`,
 * which reads the constructor's `Symbol.hasInstance` and prototype and calls it never. The left of
 * `instanceof` is handed to the right side's `Symbol.hasInstance`, which may construct it.
 */
function isTested(parent: Node, at: Expression): boolean {
  return (
    isTypeOfExpression(parent) ||
    (isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword &&
      parent.right === at)
  );
}

/**
 * What a read of a File reference, `expression` within `parent`, leaves to follow: the reads of the
 * constant it initializes, unless they were followed already. `undefined` where it stands in
 * anything else, or in a constant that is exported, which hands the reference on.
 */
function aliasReads(
  parent: Node,
  expression: Expression,
  seen: Set<VariableDeclaration>,
): readonly Identifier[] | undefined {
  if (!isVariableDeclaration(parent) || parent.initializer !== expression || !isConstant(parent)) {
    return undefined;
  }
  const statement = parent.parent.parent;
  if (
    isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true
  ) {
    return undefined;
  }
  if (seen.has(parent)) return [];
  seen.add(parent);
  return constructorReferences(parent, localBinding);
}

/** Whether a global File, or a constant alias of it, may take its timestamp from the clock. */
export function fileReadsClock(
  made: NewExpression,
  isGlobalFile: (expression: Expression) => boolean,
): boolean {
  let constructor = unwrapped(made.expression);
  const seen = new Set<Expression>();
  while (!seen.has(constructor)) {
    seen.add(constructor);
    if (isGlobalFile(constructor)) {
      return !hasFileTimestamp(made);
    }
    const held = isIdentifier(constructor) ? constantInitializer(constructor) : undefined;
    if (held === undefined) {
      break;
    }
    constructor = unwrapped(held);
  }
  return false;
}

/** Whether the File's final lastModified is shown defined, after ordered option spreads. */
export function hasFileTimestamp(made: NewExpression): boolean {
  const options = made.arguments?.[2];
  return (
    options !== undefined &&
    made.arguments?.some((argument) => isSpreadElement(argument)) !== true &&
    timestampIn(options, made, new Set()) === 'defined'
  );
}

/** The last timestamp an object writes, with unknown spreads retaining their possible override. */
function timestampIn(
  node: Expression,
  made: NewExpression,
  seen: ReadonlySet<Expression>,
): Timestamp {
  const value = declaredValue(node, made);
  if (seen.has(value) || !isObjectLiteralExpression(value)) {
    return 'unknown';
  }
  if (value.properties.some((property) => readsOptionsCode(property))) {
    return 'unknown';
  }
  const following = new Set([...seen, value]);
  let timestamp: Timestamp = 'absent';
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      const spread = timestampIn(property.expression, made, following);
      if (spread !== 'absent') {
        timestamp = spread;
      }
      continue;
    }
    const own = propertyTimestamp(property);
    if (own !== 'absent') {
      timestamp = own;
    }
  }
  return timestamp;
}

/** Accessors or a custom prototype whose option reads may change the timestamp. */
function readsOptionsCode(property: ObjectLiteralElementLike): boolean {
  return (
    isGetAccessorDeclaration(property) ||
    isSetAccessorDeclaration(property) ||
    (isPropertyAssignment(property) && keyOf(property.name) === '__proto__')
  );
}

/** The timestamp an own property writes, or an unknown computed key may replace. */
function propertyTimestamp(property: ObjectLiteralElementLike): Timestamp {
  if (isSpreadAssignment(property)) {
    return 'unknown';
  }
  const key = keyOf(property.name);
  if (key === undefined) {
    return 'unknown';
  }
  if (key !== 'lastModified') {
    return 'absent';
  }
  let value: Expression | undefined;
  if (isPropertyAssignment(property)) {
    value = property.initializer;
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    value = property.name;
  }
  return value !== undefined && isDefined(value, new Set()) ? 'defined' : 'unknown';
}

/**
 * A literal property name, including a constant computed key. A number is the text the language
 * makes of it as a key — `1`, `0x10` and `[1 + 1]` are `'1'`, `'16'` and `'2'` — and none of them is
 * `lastModified`.
 */
function keyOf(name: Node): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) {
    return name.text;
  }
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, constantInitializer)
    : undefined;
  return key === undefined ? undefined : String(key);
}

/** A constant's initializer, only where that exact lexical binding is a plain const declaration. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declaration = localBinding(name);
  return declaration !== null && declaration !== undefined && isConstant(declaration)
    ? declaration.initializer
    : undefined;
}

/** Whether a plain variable declaration binds an immutable value. */
function isConstant(declaration: VariableDeclaration): boolean {
  return (
    isIdentifier(declaration.name) &&
    isVariableDeclarationList(declaration.parent) &&
    /^const\s/u.test(declaration.parent.getText(declaration.getSourceFile()))
  );
}

/** Constant aliases of options, with no writes or escapes that could replace their timestamp. */
function declaredValue(node: Expression, made: NewExpression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declaration = localBinding(value);
    if (
      declaration === null ||
      declaration === undefined ||
      !isConstant(declaration) ||
      declaration.initializer === undefined ||
      !unchanged(declaration, made, new Set())
    ) {
      break;
    }
    value = unwrapped(declaration.initializer);
  }
  return value;
}

/**
 * Whether the holder is used only by this File, constant aliases, or non-mutating object spreads —
 * of the reads of its own name alone, before the binding each reads is resolved.
 */
function unchanged(
  declaration: VariableDeclaration,
  made: NewExpression,
  seen: ReadonlySet<VariableDeclaration>,
): boolean {
  if (seen.has(declaration)) {
    return false;
  }
  const statement = declaration.parent.parent;
  if (
    isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true
  ) {
    return false;
  }
  const following = new Set([...seen, declaration]);
  let safe = true;
  const visit = (node: Node): void => {
    if (!safe) {
      return;
    }
    if (
      isIdentifier(node) &&
      isIdentifier(declaration.name) &&
      node.text === declaration.name.text &&
      node !== declaration.name &&
      readsBinding(node) &&
      localBinding(node) === declaration
    ) {
      const { at, parent } = useOf(node);
      const expression = at as Expression;
      if (parent === made && made.arguments?.[2] === expression) {
        return;
      }
      if (isSpreadAssignment(parent) && parent.expression === expression) {
        return;
      }
      if (isVariableDeclaration(parent) && parent.initializer === expression) {
        safe = isConstant(parent) && unchanged(parent, made, following);
      } else {
        safe = false;
      }
    }
    node.forEachChild(visit);
  };
  visit(declaration.getSourceFile());
  return safe;
}

/**
 * Whether a value has no branch that may be undefined — nor, where `nullable` is false, `null`;
 * unknown calls and reads stay unknown. The left of `??` supplies its value only where it is
 * neither: `null ?? undefined` is `undefined`.
 */
function isDefined(node: Expression, seen: ReadonlySet<Expression>, nullable = true): boolean {
  const value = unwrapped(node);
  if (seen.has(value)) {
    return false;
  }
  const following = new Set([...seen, value]);
  // `NaN` and `Infinity` are numbers of their own, which no constant of the module declares.
  if (constantValue(value, constantInitializer) !== undefined) {
    return true;
  }
  if (isIdentifier(value)) {
    const held = constantInitializer(value);
    return held !== undefined && isDefined(held, following, nullable);
  }
  if (isConditionalExpression(value)) {
    return (
      isDefined(value.whenTrue, following, nullable) &&
      isDefined(value.whenFalse, following, nullable)
    );
  }
  if (isBinaryExpression(value)) {
    if (value.operatorToken.kind === SyntaxKind.QuestionQuestionToken) {
      return isDefined(value.left, following, false) || isDefined(value.right, following, nullable);
    }
    return (
      value.operatorToken.kind === SyntaxKind.BarBarToken &&
      isDefined(value.right, following, nullable)
    );
  }
  return isDefinedLiteral(value, nullable);
}

/** Literals and constructions always supply a value when they complete; `null` if `nullable`. */
function isDefinedLiteral(value: Expression, nullable: boolean): boolean {
  return (
    (nullable && value.kind === SyntaxKind.NullKeyword) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.TrueKeyword].includes(value.kind) ||
    isBigIntLiteral(value) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isNewExpression(value) ||
    isTemplateExpression(value)
  );
}

/** The nearest value declaration, including blockers in catch, loop, switch and function scopes. */
function localBinding(name: Identifier): Binding {
  let within: Node = name;
  let parameterDecorator = false;
  for (let at: Node = name.parent; ; within = at, at = at.parent) {
    const own = ownBinding(at, within, name.text, parameterDecorator);
    if (own !== undefined) {
      return own;
    }
    const binding = bindingIn(at, name.text);
    if (binding !== undefined) {
      return binding;
    }
    if (isSourceFile(at)) {
      return hoistedIn([at]).some((declaration) => binds(declaration.name, name.text))
        ? null
        : undefined;
    }
    parameterDecorator = isParameterDeclaration(at) && isDecorator(within);
  }
}

/** A binding among the statements sharing one scope. */
function bindingIn(node: Node, name: string): Binding {
  const statements = statementsOf(node);
  if (statements !== undefined) {
    for (const statement of statements) {
      const binding = statementBinding(statement, name);
      if (binding !== undefined) {
        return binding;
      }
    }
  }
  return undefined;
}

/** The bindings a catch, loop or function introduces around the reference. */
function ownBinding(node: Node, within: Node, name: string, parameterDecorator: boolean): Binding {
  if ((isClassExpression(node) || isFunctionExpression(node)) && node.name?.text === name) {
    return null;
  }
  if (isCatchClause(node) && node.variableDeclaration !== undefined) {
    return binds(node.variableDeclaration.name, name) ? null : undefined;
  }
  const loop = loopBinding(node, name);
  if (loop !== undefined) {
    return loop;
  }
  if (parameterDecorator || isComputedPropertyName(within) || isDecorator(within)) {
    return undefined;
  }
  const parameters = isSignatureDeclaration(node) ? node.parameters : undefined;
  if (parameters?.some((parameter) => binds(parameter.name, name)) === true) {
    return null;
  }
  return 'body' in node &&
    node.body === within &&
    hoistedIn([within]).some((declaration) => binds(declaration.name, name))
    ? null
    : undefined;
}

/** A loop head's local variable, including an opaque iteration value. */
function loopBinding(node: Node, name: string): Binding {
  if (!(isForStatement(node) || isForInStatement(node) || isForOfStatement(node))) {
    return undefined;
  }
  const { initializer } = node;
  return initializer !== undefined && isVariableDeclarationList(initializer)
    ? initializer.declarations.find((each) => binds(each.name, name))
    : undefined;
}

/** The statements sharing a lexical scope. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) {
    return node.clauses.flatMap((clause) => clause.statements);
  }
  return isBlock(node) || isModuleBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/** The value binding a statement introduces, with imports and non-variable values opaque. */
function statementBinding(statement: Statement, name: string): Binding {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.find((each) => binds(each.name, name));
  }
  if (isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
      return undefined;
    }
    const named = clause.namedBindings;
    const bound =
      clause.name?.text === name ||
      (named !== undefined &&
        (isNamespaceImport(named)
          ? named.name.text === name
          : named.elements.some((each) => !each.isTypeOnly && each.name.text === name)));
    return bound ? null : undefined;
  }
  if (isImportEqualsDeclaration(statement)) {
    return statement.name.text === name ? null : undefined;
  }
  return (isClassDeclaration(statement) ||
    isFunctionDeclaration(statement) ||
    isEnumDeclaration(statement) ||
    isModuleDeclaration(statement)) &&
    statement.name?.text === name
    ? null
    : undefined;
}

/** Whether a plain name or destructuring pattern binds the name read. */
function binds(binding: BindingName, name: string): boolean {
  return bindingIdentifiers(binding).some((each) => each.text === name);
}
