import {
  type ArrowFunction,
  type BindingName,
  type Block,
  type CaseBlock,
  type CatchClause,
  type ClassDeclaration,
  type ClassStaticBlockDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  type EnumDeclaration,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type Identifier,
  isArrowFunction,
  isBindingElement,
  isBlock,
  isBreakStatement,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isContinueStatement,
  isDecorator,
  isEnumDeclaration,
  isEnumMember,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportTypeNode,
  isIndexSignatureDeclaration,
  isInterfaceDeclaration,
  isJsxAttribute,
  isJsxClosingElement,
  isJsxNamespacedName,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isLabeledStatement,
  isLiteralTypeNode,
  isMetaProperty,
  isMethodDeclaration,
  isObjectBindingPattern,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isQualifiedName,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeNode,
  isTypeParameterDeclaration,
  isTypeQueryNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  NodeFlags,
  type ParameterDeclaration,
  type SetAccessorDeclaration,
  type Statement,
  type VariableDeclaration,
  type VariableDeclarationList,
} from 'typescript/ast';

import type { Fail } from './errors.ts';

/**
 * Names, followed lexically through a part of the component — the code before the state, the
 * state's arguments, the browser's constants and the returned JSX — each name in the scope that
 * declares it. A name is readable where it is declared and below, not wherever a declaration of
 * that spelling happens to exist: `(user) => …` in one handler does not let `user` be read in
 * another.
 *
 * Every part sees the component's top-level names — its imports, its own name, `id`, what the code
 * before the state declares, the state and the browser's constants — and no declaration nested in
 * any part may take one of them, so what a name is, wherever it is read, is told by the name: the
 * compiler finds a server value, a setter or a module by it. A read that no declaration in scope
 * answers is a global only when nothing in the file declares that name; `arguments` never is one.
 */

/** Where a name is read: at run time, or in a type, which is erased from what runs. */
export type Space = 'type' | 'value';

/** The component's names, which a part of it is walked with. */
export interface Names {
  /** The component's top-level names, which every part sees and no declaration nested in it takes. */
  readonly topLevel: ReadonlySet<string>;
  /** The identifiers that declare them, which alone may. */
  readonly declaring: ReadonlySet<Node>;
  /** Every name a declaration anywhere in the file gives: a read of none of them is a global. */
  readonly declared: ReadonlySet<string>;
  /**
   * Names the outputs write within the code walked — `$`, which the authority's program renders
   * with — which the code may neither declare nor read, why given by the message.
   */
  readonly reserved?: ReadonlyMap<string, string>;
  /**
   * Names the code around the part declares, which the part reads as that code does: the parameter
   * of the `.map()` callback a site's element stands in.
   */
  readonly outer?: ReadonlySet<string>;
}

/** What a part makes of what the walk finds in it. */
export interface Visitor {
  /**
   * A read of one of the component's top-level names; `scope`, for a read at run time, the names in
   * scope where it stands — the top-level names, and those the code around it declares.
   */
  readonly read: (identifier: Identifier, space: Space, scope?: ReadonlySet<string>) => void;
  /** Each node of the part that runs, before what it holds. */
  readonly node?: (node: Node) => void;
  /** A read that no declaration in scope answers, and that is not a global. */
  readonly unresolved?: (identifier: Identifier) => void;
  /** A read of a global: a name no declaration in the file gives. */
  readonly global?: (identifier: Identifier) => void;
  /** A name a declaration nested in the part gives: a parameter, a variable of a block. */
  readonly declare?: (identifier: Identifier) => void;
}

/** Walks `root`, a part of the component, telling `visitor` what it reads and what it holds. */
export function walk(root: Node, names: Names, visitor: Visitor, fail: Fail): void {
  /** What `identifier` is where it stands: a declaration, a read, or neither. */
  const identify = (identifier: Identifier, scope: ReadonlySet<string>): void => {
    const reserved = names.reserved?.get(identifier.text);
    if (reserved !== undefined && (isDeclaredName(identifier) || readsBinding(identifier))) {
      fail(reserved, identifier);
    }
    if (isDeclaredName(identifier)) {
      if (
        names.topLevel.has(identifier.text) &&
        !names.declaring.has(identifier) &&
        !namesItsHolder(identifier)
      ) {
        fail(declaredAgain(identifier.text), identifier);
      }
      if (!names.declaring.has(identifier)) {
        visitor.declare?.(identifier);
      }
      return;
    }
    if (!readsBinding(identifier)) {
      return;
    }
    if (scope.has(identifier.text)) {
      if (names.topLevel.has(identifier.text)) {
        visitor.read(identifier, 'value', scope);
      }
      return;
    }
    if (identifier.text === 'arguments' || names.declared.has(identifier.text)) {
      visitor.unresolved?.(identifier);
      return;
    }
    visitor.global?.(identifier);
  };
  const visit = (node: Node, scope: ReadonlySet<string>, outside?: ReadonlySet<string>): void => {
    // A type is erased from what runs, and a signature of no body with it (`isTypeOnly`), so the
    // names in either are no reads, nor declarations; but each output names the types it uses, and
    // so is told of them.
    if (isTypeOnly(node)) {
      visitType(node, names, visitor, fail);
      return;
    }
    visitor.node?.(node);
    if (isIdentifier(node)) {
      identify(node, scope);
    }
    eachInScope(node, scope, visit, outside);
  };
  visit(
    root,
    names.outer === undefined ? names.topLevel : new Set([...names.topLevel, ...names.outer]),
  );
}

function declaredAgain(name: string): string {
  return `\`${name}\` is one of the top-level names of the component — or of the hook — declared again inside it; give it a name of its own: the compiler tells what each name is by the name.`;
}

/**
 * Whether `node` is erased from what runs, with the types: a type — but `f<T>`, an instantiation
 * expression, and a class's `extends`, which TypeScript counts among the type nodes but which read
 * their expression — an alias, an interface, a type parameter, or a signature of no body: an
 * overload's, an abstract method's, a class's index signature. A parameter of any of them declares
 * nothing that runs, whatever it is named.
 */
export function isTypeOnly(node: Node): boolean {
  return (
    (isTypeNode(node) && !isExpressionWithTypeArguments(node)) ||
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeParameterDeclaration(node) ||
    isIndexSignatureDeclaration(node) ||
    (isFunctionLikeDeclaration(node) && node.body === undefined)
  );
}

/**
 * Whether a function or class expression's name is the one of the constant that holds it, as in
 * `const retry = function retry() {}`: within it, it is that very value.
 */
function namesItsHolder(identifier: Identifier): boolean {
  const fn = identifier.parent;
  if (!(isFunctionExpression(fn) || isClassExpression(fn)) || fn.name !== identifier) {
    return false;
  }
  let holder = fn.parent;
  while (isParenthesizedExpression(holder)) {
    holder = holder.parent;
  }
  return (
    isVariableDeclaration(holder) &&
    isIdentifier(holder.name) &&
    holder.name.text === identifier.text
  );
}

/**
 * The names a type uses: what a type reference names, leftmost (`Foo` of `Foo.Bar<T>`, `db` of
 * `typeof db.todos`). A type declared inside the component — an alias, an interface, a type
 * parameter — takes none of its top-level names, so a top-level name a type uses is that name.
 */
function visitType(node: Node, names: Names, visitor: Visitor, fail: Fail): void {
  if (
    (isTypeAliasDeclaration(node) ||
      isInterfaceDeclaration(node) ||
      isTypeParameterDeclaration(node)) &&
    names.topLevel.has(node.name.text) &&
    !names.declaring.has(node.name)
  ) {
    fail(declaredAgain(node.name.text), node.name);
  }
  // An import type is resolved from where the output is written, where a relative path names
  // another module.
  if (
    isImportTypeNode(node) &&
    isLiteralTypeNode(node.argument) &&
    isStringLiteral(node.argument.literal) &&
    node.argument.literal.text.startsWith('.')
  ) {
    fail(
      `\`import(${JSON.stringify(node.argument.literal.text)})\` names a module by a relative path, which names another one from where the outputs are written: name it by a path of the application's, as \`@/…\`.`,
      node,
    );
  }
  const reference = referenceOf(node);
  if (reference !== undefined && names.topLevel.has(reference.text)) {
    visitor.read(reference, 'type');
  }
  node.forEachChild((child) => {
    visitType(child, names, visitor, fail);
  });
}

/** The name a type reference refers by, leftmost; `undefined` for any other node. */
function referenceOf(node: Node): Identifier | undefined {
  let name: Node | undefined;
  if (isTypeReferenceNode(node)) {
    name = node.typeName;
  } else if (isTypeQueryNode(node)) {
    name = node.exprName;
  } else if (isExpressionWithTypeArguments(node) || isComputedPropertyName(node)) {
    name = node.expression;
  }
  while (name !== undefined && (isQualifiedName(name) || isPropertyAccessExpression(name))) {
    name = isQualifiedName(name) ? name.left : name.expression;
  }
  return name !== undefined && isIdentifier(name) ? name : undefined;
}

/** A method's or an accessor's computed name, which runs where the method is defined. */
function computedNameOf(node: Node): Node | undefined {
  return (isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
    ? node.name
    : undefined;
}

/** A function — an arrow, a declaration, a method — whose parameters are its own. */
type FunctionNode =
  | ArrowFunction
  | ConstructorDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | GetAccessorDeclaration
  | MethodDeclaration
  | SetAccessorDeclaration;

/**
 * What opens a scope of its own: a function, a block — a `switch`'s cases are one — a loop's head,
 * a `catch`, a class's static block, and a class expression, whose name is known within it.
 */
type ScopeNode =
  | Block
  | CaseBlock
  | CatchClause
  | ClassExpression
  | ClassStaticBlockDeclaration
  | ForInStatement
  | ForOfStatement
  | ForStatement
  | FunctionNode;

/** What a scope declares: a parameter, a variable, or a function, a class or an enum of a block. */
type Declaration =
  | ClassDeclaration
  | EnumDeclaration
  | FunctionDeclaration
  | ParameterDeclaration
  | VariableDeclaration;

function isFunctionNode(node: Node): node is FunctionNode {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

/**
 * The reads within `root` of a name it does not declare around them: what a value written there
 * reaches of what is around it. A function's parameters, and what it and its blocks declare, are its
 * own where they are in scope, as `walk` reads them — so `(item) => item.id` reads no name around
 * it, and `() => options` reads `options`. What is erased with the types names no read
 * (`isTypeOnly`).
 */
export function freeReads(root: Node): readonly Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node, scope: ReadonlySet<string>, outside?: ReadonlySet<string>): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isIdentifier(node)) {
      if (!isDeclaredName(node) && readsBinding(node) && !scope.has(node.text)) {
        found.push(node);
      }
      return;
    }
    eachInScope(node, scope, visit, outside);
  };
  visit(root, new Set());
  return found;
}

/**
 * Visits each child of `node` in the scope it is in: `scope`, or, within a function, a block, a
 * loop or a `catch`, what it declares as well — a function's `var`s within its body alone, its
 * parameters' defaults being read before the body runs, where a `var` of the body does not reach;
 * a method's computed name in `scope`, where the method is defined; and a decorator in `scope` as
 * well, where the class is defined, outside the parameters of the method it decorates — a
 * parameter's too, which `outside` is the scope of, where `node` is the parameter.
 */
function eachInScope(
  node: Node,
  scope: ReadonlySet<string>,
  visit: (child: Node, scope: ReadonlySet<string>, outside?: ReadonlySet<string>) => void,
  outside?: ReadonlySet<string>,
): void {
  if (!opensScope(node)) {
    node.forEachChild((child) => {
      visit(child, outside !== undefined && isDecorator(child) ? outside : scope);
    });
    return;
  }
  const inner = enter(node, scope);
  const body = varScoped(node) ? declare(hoisted(node), inner) : inner;
  const bodyNode = bodyOf(node);
  const keyNode = computedNameOf(node);
  node.forEachChild((child) => {
    if (child === bodyNode) {
      visit(child, body);
    } else if (child === keyNode || isDecorator(child)) {
      visit(child, scope);
    } else {
      visit(child, inner, isParameterDeclaration(child) ? scope : undefined);
    }
  });
}

/**
 * Whether `node` runs within a function of its own — in a function's body, not merely beneath it,
 * as a method's computed name is — rather than in the body `stop` is the function of.
 */
export function withinFunction(node: Node, stop: Node): boolean {
  let child = node;
  for (let parent = node.parent; parent !== stop; parent = parent.parent) {
    if (bodyOf(parent) === child) {
      return true;
    }
    child = parent;
  }
  return false;
}

function opensScope(node: Node): node is ScopeNode {
  return (
    isFunctionNode(node) ||
    isClassExpression(node) ||
    isClassStaticBlockDeclaration(node) ||
    isBlock(node) ||
    isCaseBlock(node) ||
    isCatchClause(node) ||
    isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node)
  );
}

/** The declarations a scope's node makes for what is inside it. */
function declarationsOf(node: ScopeNode): readonly Declaration[] {
  if (isClassExpression(node)) {
    return [];
  }
  // A static block's `var`s, and a function's, are its body's, declared where the body is entered.
  if (isClassStaticBlockDeclaration(node)) {
    return [];
  }
  if (isFunctionNode(node)) {
    return node.parameters;
  }
  if (isBlock(node)) {
    return declaredIn(node.statements);
  }
  if (isCaseBlock(node)) {
    return declaredIn(node.clauses.flatMap((clause) => clause.statements));
  }
  if (isCatchClause(node)) {
    return node.variableDeclaration === undefined ? [] : [node.variableDeclaration];
  }
  const { initializer } = node;
  return initializer !== undefined &&
    isVariableDeclarationList(initializer) &&
    isBlockScoped(initializer)
    ? initializer.declarations
    : [];
}

/** Whether a list declares with `let`, `const` or `using`, which its block scopes, not `var`. */
export function isBlockScoped(list: VariableDeclarationList): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `let`, `const` or `using` in these flags alone.
  return (list.flags & NodeFlags.BlockScoped) !== 0;
}

/**
 * The `var`s declared anywhere in `nodes` — a block of them, a loop's head — which JavaScript
 * scopes to the whole function rather than to the block that holds them. A function or a class
 * within them keeps its own.
 */
export function hoistedIn(nodes: readonly Node[]): readonly VariableDeclaration[] {
  const found: VariableDeclaration[] = [];
  const visit = (node: Node): void => {
    if (isFunctionNode(node) || isClassDeclaration(node) || isClassExpression(node)) {
      return;
    }
    if (isVariableDeclarationList(node) && !isBlockScoped(node)) {
      found.push(...node.declarations);
    }
    node.forEachChild(visit);
  };
  for (const node of nodes) {
    visit(node);
  }
  return found;
}

/**
 * The `var`s a function declares anywhere in its body. The body itself is visited, not only what it
 * holds: an arrow's body may be a function of its own, whose `var`s are its own.
 */
function hoisted(fn: ClassStaticBlockDeclaration | FunctionNode): readonly VariableDeclaration[] {
  return fn.body === undefined ? [] : hoistedIn([fn.body]);
}

/**
 * What a block's statements declare: its `let`s and `const`s, and its functions, classes and enums
 * too, wherever in it they are. Its `var`s are the function's.
 */
function declaredIn(statements: readonly Statement[]): readonly Declaration[] {
  return statements.flatMap((statement): readonly Declaration[] => {
    if (isVariableStatement(statement)) {
      return isBlockScoped(statement.declarationList) ? statement.declarationList.declarations : [];
    }
    return isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement)
      ? [statement]
      : [];
  });
}

/**
 * The scope inside a function — the outer one and its parameters — inside a block, a loop or a
 * `catch`: the outer one and what they declare.
 */
function enter(node: ScopeNode, names: ReadonlySet<string>): ReadonlySet<string> {
  const inner = new Set(names);
  // A function or class expression is known by its name within itself, and nowhere else.
  const own = isFunctionExpression(node) || isClassExpression(node) ? node.name?.text : undefined;
  if (own !== undefined) {
    inner.add(own);
  }
  // A function other than an arrow has its own `arguments`, which no outer one reaches.
  if (isFunctionNode(node) && !isArrowFunction(node)) {
    inner.add('arguments');
  }
  return declare(declarationsOf(node), inner);
}

/** `scope` with what `declarations` declare added to it. */
function declare(
  declarations: readonly Declaration[],
  scope: ReadonlySet<string>,
): ReadonlySet<string> {
  const inner = new Set(scope);
  for (const declaration of declarations) {
    if (declaration.name !== undefined) {
      for (const name of bindingIdentifiers(declaration.name)) {
        inner.add(name.text);
      }
    }
  }
  return inner;
}

/** What keeps `var`s of its own: a function, and a class's static block. */
function varScoped(node: Node): node is ClassStaticBlockDeclaration | FunctionNode {
  return isFunctionNode(node) || isClassStaticBlockDeclaration(node);
}

/** The body of a node that keeps `var`s of its own, where they are known. */
function bodyOf(node: Node): Node | undefined {
  return varScoped(node) ? node.body : undefined;
}

/** The identifiers a binding declares: the name itself, or each name a pattern destructures. */
export function bindingIdentifiers(name: BindingName): readonly Identifier[] {
  if (isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => {
    return isOmittedExpression(element) || !isBindingElement(element) || element.name === undefined
      ? []
      : bindingIdentifiers(element.name);
  });
}

/**
 * Whether an identifier is the name a declaration gives: a variable's wherever it is declared — a
 * block, a `for` head, a `catch` clause — a parameter's, a destructured name, a function's, a
 * class's or an enum's.
 */
function isDeclaredName(node: Identifier): boolean {
  const parent = node.parent;
  if (
    isVariableDeclaration(parent) ||
    isParameterDeclaration(parent) ||
    isBindingElement(parent) ||
    isFunctionDeclaration(parent) ||
    isFunctionExpression(parent) ||
    isClassDeclaration(parent) ||
    isClassExpression(parent) ||
    isEnumDeclaration(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

/** Every name a declaration within `root` gives, at any depth. */
export function declaredWithin(root: Node): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (node: Node): void => {
    if (isIdentifier(node) && isDeclaredName(node)) {
      found.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/**
 * Whether an identifier is no binding's name at all: a label, the `target` of `new.target`, a part
 * of a namespaced JSX name, or the name of a class's or an object's member or of an enum's.
 */
function isGivenName(node: Identifier): boolean {
  const parent = node.parent;
  if (
    isLabeledStatement(parent) ||
    isBreakStatement(parent) ||
    isContinueStatement(parent) ||
    isMetaProperty(parent) ||
    isJsxNamespacedName(parent)
  ) {
    return true;
  }
  return (
    (isMethodDeclaration(parent) ||
      isGetAccessorDeclaration(parent) ||
      isSetAccessorDeclaration(parent) ||
      isPropertyDeclaration(parent) ||
      isEnumMember(parent)) &&
    parent.name === node
  );
}

/**
 * Whether an identifier reads a binding, as opposed to naming a property, an attribute, an element
 * the browser knows, or nothing at all. A tag that names a component reads it: `<TextInput>` reads
 * `TextInput`, and `<ui.TextInput>` reads `ui`.
 */
export function readsBinding(node: Identifier): boolean {
  const parent = node.parent;
  if (
    isPropertyAccessExpression(parent) ||
    isPropertyAssignment(parent) ||
    isJsxAttribute(parent)
  ) {
    return parent.name !== node;
  }
  if (isGivenName(node)) {
    return false;
  }
  if (isBindingElement(parent)) {
    return !(isObjectBindingPattern(parent.parent) && parent.propertyName === node);
  }
  if (
    (isJsxOpeningElement(parent) ||
      isJsxClosingElement(parent) ||
      isJsxSelfClosingElement(parent)) &&
    parent.tagName === node
  ) {
    return !/^[a-z]/u.test(node.text);
  }
  return true;
}
