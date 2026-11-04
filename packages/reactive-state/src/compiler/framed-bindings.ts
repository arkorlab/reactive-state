import {
  type BindingElement,
  type ClassDeclaration,
  type Expression,
  type Identifier,
  type FunctionDeclaration,
  isArrayBindingPattern,
  isBindingElement,
  isBlock,
  isCallExpression,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isFunctionDeclaration,
  isFunctionExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isModuleBlock,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ParameterDeclaration,
  type Statement,
  type TypeNode,
  type VariableDeclaration,
  isSignatureDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped } from './scope.ts';

/** Written binding paths and constant keys, keeping the scope of each original syntax node. */

export type FrameBinding = ParameterDeclaration | VariableDeclaration;
export type FrameDeclaration = FrameBinding | FunctionDeclaration | ClassDeclaration;

export interface FrameSelection {
  readonly binding: FrameBinding;
  readonly keys: readonly string[];
}

export interface FrameTypeSelection {
  readonly type: TypeNode;
  readonly keys: readonly string[];
}

const RESOLVING_KEYS = new WeakSet<Node>();

/** The stable member name recorded after a framed read is classified, including coercion calls. */
export function framedInputName(node: Node): string {
  return (
    frameMemberName(node) ??
    (isCallExpression(node) ? frameMemberName(unwrapped(node.expression)) : undefined) ??
    'toString'
  );
}

/** The written, immutable name of a member or a destructured object field. */
export function frameMemberName(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) return node.name.text;
  if (isElementAccessExpression(node)) return constantKey(node.argumentExpression);
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) return undefined;
  const name = node.propertyName ?? node.name;
  if (name === undefined) return undefined;
  if (isIdentifier(name)) return name.text;
  if (isComputedPropertyName(name)) return constantKey(name.expression);
  return isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name) || isNumericLiteral(name)
    ? constantKey(name)
    : undefined;
}

/** The parameter or variable nearest a read, including names taken apart by a binding pattern. */
export function frameBindingOf(name: Identifier): FrameSelection | undefined {
  const binding = frameDeclarationOf(name);
  return binding !== undefined &&
    (isParameterDeclaration(binding) || isVariableDeclaration(binding))
    ? selectedBinding(binding, name.text)
    : undefined;
}

/** The nearest written value declaration, with unsupported own expression names kept opaque. */
export function frameDeclarationOf(name: Identifier): FrameDeclaration | undefined {
  let within: Node = name;
  for (let at: Node = name.parent; ; within = at, at = at.parent) {
    const binding = localBinding(at, within, name.text);
    if (binding === null) return undefined;
    if (binding !== undefined) return binding;
    if (isSourceFile(at)) return undefined;
  }
}

/** The container a binding element selects from, before it reads its own final member. */
export function frameBindingContainer(element: BindingElement): FrameSelection | undefined {
  const selected = elementSelection(element);
  return selected === undefined ? undefined : { ...selected, keys: selected.keys.slice(0, -1) };
}

/** The written type of an expression, selecting members after following lexical variable aliases. */
export function frameTypeOf(node: Expression): FrameTypeSelection | undefined {
  let value = unwrapped(node);
  let keys: readonly string[] = [];
  const seen = new Set<FrameBinding>();
  for (;;) {
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = frameMemberName(value);
      if (key === undefined) return undefined;
      keys = [key, ...keys];
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) return undefined;
    const selected = frameBindingOf(value);
    if (selected === undefined || seen.has(selected.binding)) return undefined;
    const { binding } = selected;
    seen.add(binding);
    keys = [...selected.keys, ...keys];
    if (binding.type !== undefined) return { keys, type: binding.type };
    if (binding.initializer === undefined) return undefined;
    value = unwrapped(binding.initializer);
  }
}

/** A constant key follows only const variables, with parameter and block shadows left intact. */
function constantKey(node: Expression): string | undefined {
  if (RESOLVING_KEYS.has(node)) return undefined;
  RESOLVING_KEYS.add(node);
  try {
    return resolvedKey(node);
  } finally {
    RESOLVING_KEYS.delete(node);
  }
}

/** A key's constant syntax, with re-entry through computed binding patterns cut above. */
function resolvedKey(node: Expression): string | undefined {
  const value = constantValue(node, (name) => {
    const selected = frameBindingOf(name);
    if (selected === undefined) return;
    if (selected.keys.length > 0) return;
    const { binding } = selected;
    if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent)) return;
    const statement = binding.parent.parent;
    return isVariableStatement(statement) &&
      /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
      ? binding.initializer
      : undefined;
  });
  return value === undefined ? undefined : String(value);
}

/** A scope's direct written binding, with parameters checked where their function is reached. */
function localBinding(node: Node, within: Node, name: string): FrameDeclaration | null | undefined {
  const loop = loopBinding(node, name);
  if (loop !== undefined) return loop;
  if (
    isCatchClause(node) &&
    node.variableDeclaration !== undefined &&
    bindingIdentifiers(node.variableDeclaration.name).some((bound) => bound.text === name)
  )
    return node.variableDeclaration;
  const statements = statementsOf(node);
  if (statements !== undefined) {
    const binding = statementBinding(statements, name);
    if (binding !== undefined) return binding;
  }
  const parameters = isSignatureDeclaration(node) ? node.parameters : undefined;
  const declared =
    parameters?.find((parameter) =>
      bindingIdentifiers(parameter.name).some((bound) => bound.text === name),
    ) ?? hoistedBinding(node, within, name);
  if (declared !== undefined) return declared;
  return (isFunctionExpression(node) || isClassExpression(node)) && node.name?.text === name
    ? null
    : undefined;
}

/** Ordinary and namespace blocks keep their statements; a switch's clauses share one scope. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) return node.clauses.flatMap((clause) => clause.statements);
  return isBlock(node) || isModuleBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/** A function, static block or source file owns its nested vars; nested functions and classes do not. */
function hoistedBinding(node: Node, within: Node, name: string): FrameBinding | undefined {
  let roots: readonly Node[];
  if (isSourceFile(node)) roots = node.statements;
  else if ('body' in node && node.body === within) roots = [within];
  else return undefined;
  return hoistedIn(roots).find((declaration) =>
    bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
  );
}

/** A block-scoped loop header binding shadows outer names throughout its body. */
function loopBinding(node: Node, name: string): FrameBinding | undefined {
  if (!isForStatement(node) && !isForOfStatement(node) && !isForInStatement(node)) return undefined;
  const list = node.initializer;
  return list !== undefined && isVariableDeclarationList(list) && isBlockScoped(list)
    ? list.declarations.find((declaration) =>
        bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
      )
    : undefined;
}

/** The variable a block declares, with named functions and classes stopping outer lookup. */
function statementBinding(
  statements: readonly Statement[],
  name: string,
): FrameDeclaration | undefined {
  for (const statement of statements) {
    if (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name?.text === name
    )
      return statement;
    if (!isVariableStatement(statement) || !isBlockScoped(statement.declarationList)) continue;
    const found = statement.declarationList.declarations.find((declaration) =>
      bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A declaration's binding path for one of the identifiers it binds. */
function selectedBinding(binding: FrameBinding, name: string): FrameSelection | undefined {
  if (isIdentifier(binding.name)) return { binding, keys: [] };
  const identifier = bindingIdentifiers(binding.name).find((bound) => bound.text === name);
  return identifier !== undefined && isBindingElement(identifier.parent)
    ? elementSelection(identifier.parent)
    : undefined;
}

/** The literal object and tuple keys from a binding's declared whole to one selected field. */
function elementSelection(element: BindingElement): FrameSelection | undefined {
  const keys: string[] = [];
  let each = element;
  for (;;) {
    if (each.dotDotDotToken !== undefined) return undefined;
    const pattern = each.parent;
    const key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(each))
      : frameMemberName(each);
    if (key === undefined) return undefined;
    keys.unshift(key);
    const owner = pattern.parent;
    if (isParameterDeclaration(owner) || isVariableDeclaration(owner))
      return { binding: owner, keys };
    if (!isBindingElement(owner)) return undefined;
    each = owner;
  }
}
