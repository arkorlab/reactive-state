import {
  type CallExpression,
  type Expression,
  type Identifier,
  type ImportDeclaration,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportDeclaration,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceImport,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
  isTypeOfExpression,
  isTypeParameterDeclaration,
  isVariableStatement,
  type ModuleDeclaration,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { holdsValues, mergedExports, namespaceStatements } from './local-type-namespaces.ts';
import { bindingIdentifiers, freeReads, hoistedIn, readsBinding } from './scope.ts';

/**
 * What of a module's code makes code of the text it is given — the globals `eval` and `Function`,
 * what made a function, Node's `require` and what loads its modules — or reaches it otherwise than
 * by the name the code reads it by: the global object, or Node's `process`, held or handed on.
 * A module that runs anywhere alike holds none (`modules.ts`): a dynamic site's code calls a
 * `shared` module's functions of what a view sends, on the authority.
 */

/** The objects whose members are the globals: `globalThis`, `self`, `window`, Node's `global`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);

/**
 * What makes code of text, or loads a module of a name, by the names a global's read goes by:
 * `eval`, `Function`; Node's `require`, and what of `process` loads a module or binds one.
 */
const CODE_PATHS: ReadonlySet<string> = new Set([
  'eval',
  'Function',
  'process._linkedBinding',
  'process.binding',
  'process.dlopen',
  'process.getBuiltinModule',
  'process.mainModule',
  'require',
]);

/** The globals that hold what makes code of text, by a member of a name: the global object, `process`. */
const HOLDERS: ReadonlySet<string> = new Set([...GLOBAL_OBJECTS, 'process']);

/** The functions of globals that read a member of what they are given by the key given next. */
const KEY_READERS: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
]);

/** The methods of a function that call it on what they are given after the `this` they take. */
const BORROWING: ReadonlySet<string> = new Set(['apply', 'call']);

/** The operators that compare what they are given, which hold neither. */
const COMPARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Whether `node` reads what makes code of text as it runs (`CODE_PATHS`) — by its name, as a member
 * of the global object, `globalThis.eval`, by the key a pattern takes it apart by, `const { eval:
 * run } = globalThis`, or by one a read of the language's is given, `Reflect.get(…, 'eval')` — and
 * calls it, holds it, hands it on, but to test what a value is, `typeof Function`, `value
 * instanceof Function`; holds or hands on what holds it (`HOLDERS`) — `const globals = globalThis`,
 * `globalThis[key]` — but to read a member of it by a name; or reads what made a value,
 * `fn.constructor`, but to compare it, or read its name.
 */
export function readsCodeGlobal(node: Node): boolean {
  // The holder's own read answers whether taking it apart reaches code. A property of another
  // value, `const { self } = options`, is that value's, but its constructor still reaches code.
  if (patternKey(node) === 'constructor' || readsCodeKey(node)) {
    return true;
  }
  const path = globalPathOf(node)?.join('.');
  if (path !== undefined && CODE_PATHS.has(path)) {
    const { at, parent } = useOf(node);
    return !(
      isTypeOfExpression(parent) ||
      (isBinaryExpression(parent) &&
        parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword &&
        parent.right === at)
    );
  }
  if (path !== undefined && HOLDERS.has(path)) {
    return escapes(node);
  }
  return readsConstructor(node);
}

/**
 * The names a read of a global goes by, the global first — `crypto`, `subtle` of `crypto.subtle`,
 * of `globalThis.crypto.subtle` too, the global object read past — by its name or by text in
 * brackets, past a comma's first operands, `(0, Reflect.get)`, and a cast in angle brackets, which
 * `unwrapped` leaves, `(<any>globalThis).eval`; none of what reads no global, or by a key the code
 * computes. A name is the global's
 * where no declaration in scope gives it, though one elsewhere in the module does (`scopedGlobal`).
 */
export function globalPathOf(node: Node): readonly string[] | undefined {
  const names: string[] = [];
  let each = node;
  for (;;) {
    if (isPropertyAccessExpression(each)) {
      names.unshift(each.name.text);
      each = unwrapped(each.expression);
    } else if (isElementAccessExpression(each)) {
      const key = textOf(unwrapped(each.argumentExpression));
      if (key === undefined) {
        return undefined;
      }
      names.unshift(key);
      each = unwrapped(each.expression);
    } else if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.CommaToken) {
      // A comma's value is its last operand: `(0, Reflect.get)` is `Reflect.get`.
      each = unwrapped(each.right);
    } else if (isTypeAssertion(each)) {
      // `unwrapped` leaves a cast in angle brackets: `(<any>globalThis).eval` is `globalThis.eval`.
      each = unwrapped(each.expression);
    } else {
      break;
    }
  }
  const root = globalRootOf(each);
  if (root === undefined) {
    return undefined;
  }
  const path = [root, ...names];
  // `globalThis.window.eval` is `eval`.
  while (path.length > 1 && GLOBAL_OBJECTS.has(path[0] ?? '')) {
    path.shift();
  }
  return path;
}

/**
 * The global `node` names, where it reads a binding and no declaration in scope gives the name
 * (`globalOf`, `scopedGlobal`); none of another node.
 */
function globalRootOf(node: Node): string | undefined {
  return isIdentifier(node) && readsBinding(node)
    ? (globalOf(node) ?? scopedGlobal(node))
    : undefined;
}

/** Each module's reads of a name no declaration where they stand gives (`globalReadsOf`). */
const GLOBAL_READS = new WeakMap<SourceFile, ReadonlySet<Identifier>>();

/**
 * The global `name` reads where no declaration in scope gives its name, though one elsewhere in the
 * module does — `Function` of `run` beside `function unrelated(Function: unknown) {}` — as a `shared`
 * module may: `globalOf` reads a module whole, of which a component's walk refuses such a read.
 * None of a read a declaration in scope gives.
 */
function scopedGlobal(name: Identifier): string | undefined {
  const file = name.getSourceFile();
  let reads = GLOBAL_READS.get(file);
  if (reads === undefined) {
    reads = globalReadsOf(file);
    GLOBAL_READS.set(file, reads);
  }
  return reads.has(name) ? name.text : undefined;
}

/**
 * The reads in `file`'s code of a name no declaration where they stand gives: none around them
 * (`freeReads`), nor the module's own (`scopeNames`), nor, in a namespace's body, the namespace's
 * (`namespaceReads`).
 */
function globalReadsOf(file: SourceFile): ReadonlySet<Identifier> {
  const reads = new Set<Identifier>();
  readsIn(file.statements, scopeNames(file.statements, file.statements), reads);
  return reads;
}

/**
 * The reads in `file`'s code of a name no function, block, `catch` or namespace's body around them
 * declares (`freeReads`, `namespaceReads`): a read of the module's own name — an import's — is one,
 * where no namespace declares the name again; and a read of a global.
 */
export function unshadowedReads(file: SourceFile): ReadonlySet<Identifier> {
  const reads = new Set<Identifier>();
  readsIn(file.statements, new Set(), reads);
  return reads;
}

/**
 * Into `reads`, the reads in `statements` of a name none of `names` is, nor a declaration around
 * them gives (`freeReads`): of a namespace's, the names in its body's scope too (`namespaceReads`).
 */
function readsIn(
  statements: readonly Statement[],
  names: ReadonlySet<string>,
  reads: Set<Identifier>,
): void {
  for (const statement of statements) {
    if (isModuleDeclaration(statement)) {
      namespaceReads(statement, names, reads);
    } else if (!isErased(statement)) {
      for (const read of freeReads(statement)) {
        if (!names.has(read.text)) {
          reads.add(read);
        }
      }
    }
  }
}

/**
 * Into `reads`, the reads in `namespace`'s body of a name none of `names` is, nor the body gives:
 * what it declares, what the bodies it merges with export (`namespaceStatements`), and of a dotted
 * name, `namespace A.B {}`, the namespace it declares within another, `B`, and what the bodies of
 * `A` export, which are all that `A`'s body, this one, sees.
 */
function namespaceReads(
  namespace: ModuleDeclaration,
  names: ReadonlySet<string>,
  reads: Set<Identifier>,
): void {
  const { body } = namespace;
  if (body !== undefined && isModuleDeclaration(body)) {
    const outer = scopeNames(mergedExports(namespace), []);
    namespaceReads(body, widened(names, [...namesOf(body), ...outer]), reads);
  } else if (body !== undefined && isModuleBlock(body)) {
    const own = scopeNames(namespaceStatements(body), body.statements);
    readsIn(body.statements, widened(names, own), reads);
  }
}

/** `names` and `more`, of an inner scope of names more than the outer one's. */
function widened(names: ReadonlySet<string>, more: Iterable<string>): ReadonlySet<string> {
  const all = new Set(names);
  for (const name of more) {
    all.add(name);
  }
  return all;
}

/**
 * The names a scope gives a value — the module's top level, a namespace's body: what `declared`
 * declare — a variable, a function, a class, an enum, a namespace — or import, and the `var`s of
 * the blocks of `own`, the scope's own statements, which are the scope's. A nested namespace's
 * `var`s are that namespace's.
 */
function scopeNames(
  declared: readonly Statement[],
  own: readonly Statement[],
): ReadonlySet<string> {
  const names = new Set(declared.flatMap((statement) => namesOf(statement)));
  const code = own.filter((statement) => !isModuleDeclaration(statement));
  for (const declaration of hoistedIn(code)) {
    for (const name of bindingIdentifiers(declaration.name)) {
      names.add(name.text);
    }
  }
  return names;
}

/** The names a statement of a module's top level, or of a namespace's body, declares or imports. */
function namesOf(statement: Statement): readonly string[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifiers(declaration.name).map((name) => name.text),
    );
  }
  if (isImportDeclaration(statement)) {
    return importedNames(statement);
  }
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && holdsValues(statement) ? [statement.name.text] : [];
  }
  if (
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isEnumDeclaration(statement) ||
    isImportEqualsDeclaration(statement)
  ) {
    return statement.name !== undefined && isIdentifier(statement.name)
      ? [statement.name.text]
      : [];
  }
  return [];
}

/** The names an import gives a value: none of an import of a type alone, `import type`, `{ type T }`. */
function importedNames(declaration: ImportDeclaration): readonly string[] {
  const clause = declaration.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return [];
  }
  const own = clause.name === undefined ? [] : [clause.name.text];
  const named = clause.namedBindings;
  if (named === undefined) {
    return own;
  }
  if (isNamespaceImport(named)) {
    return [...own, named.name.text];
  }
  return [
    ...own,
    ...named.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text),
  ];
}

/**
 * Where `node` is used: past what wraps it alike — parentheses, a cast, `!` — what it stands in
 * (`parent`), as `at`.
 */
export function useOf(node: Node): { readonly at: Node; readonly parent: Node } {
  let at = node;
  while (
    isParenthesizedExpression(at.parent) ||
    isAsExpression(at.parent) ||
    isSatisfiesExpression(at.parent) ||
    isNonNullExpression(at.parent) ||
    isTypeAssertion(at.parent)
  ) {
    at = at.parent;
  }
  return { at, parent: at.parent };
}

/**
 * The reads in `node` of a name no declaration inside it gives: none a function's, a block's or a
 * `catch`'s (`freeReads`), nor, where `node` is a namespace, its body's or a nested one's
 * (`namespaceReads`) — what reads a constant of the module, where nothing inside declares it again.
 */
export function unshadowedReadsIn(node: Node): readonly Identifier[] {
  if (!isModuleDeclaration(node)) {
    return freeReads(node);
  }
  const reads = new Set<Identifier>();
  namespaceReads(node, new Set(), reads);
  return [...reads];
}

/**
 * Whether `node`, what holds what makes code of text (`HOLDERS`), is held or handed on where it
 * stands — but read a member of by a name, `globalThis.crypto`, tested, `typeof process`, compared,
 * or asked of a name, `'x' in globalThis` — so that what the code reaches of it, it reaches by a key
 * the compile cannot read.
 */
function escapes(node: Node): boolean {
  const { at, parent } = useOf(node);
  if (isPropertyAccessExpression(parent) && parent.expression === at) {
    return false;
  }
  if (isElementAccessExpression(parent) && parent.expression === at) {
    return textOf(unwrapped(parent.argumentExpression)) === undefined;
  }
  if (isTypeOfExpression(parent)) {
    return false;
  }
  return !(
    isBinaryExpression(parent) &&
    (COMPARING.has(parent.operatorToken.kind) ||
      (parent.operatorToken.kind === SyntaxKind.InKeyword && parent.right === at))
  );
}

/**
 * Whether `node` reads what made a value — `fn.constructor`, `fn['constructor']`, `Function` of a
 * function — but to compare it, or to read its name, `value.constructor.name`.
 */
function readsConstructor(node: Node): boolean {
  let key: string | undefined;
  if (isPropertyAccessExpression(node)) {
    key = node.name.text;
  } else if (isElementAccessExpression(node)) {
    key = textOf(unwrapped(node.argumentExpression));
  }
  if (key !== 'constructor') {
    return false;
  }
  const { at, parent } = useOf(node);
  const isNamed =
    isPropertyAccessExpression(parent) && parent.expression === at && parent.name.text === 'name';
  return !(isNamed || (isBinaryExpression(parent) && COMPARING.has(parent.operatorToken.kind)));
}

/**
 * Whether `node` is a read of the language's that reads a member by the key it is given — of what
 * made what it is given: `Reflect.get(fn, 'constructor')`, borrowed too, `Reflect.get.call(null, fn,
 * 'constructor')`. A global holder's own read is checked where it is handed on; the same key on
 * another object is that object's ordinary entry.
 */
function readsCodeKey(node: Node): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  const path = globalPathOf(unwrapped(node.expression));
  const last = path?.at(-1) ?? '';
  const borrowing = BORROWING.has(last) ? last : undefined;
  const reader = (borrowing === undefined ? path : path?.slice(0, -1))?.join('.');
  const [, key] = givenTo(node, borrowing);
  return (
    reader !== undefined &&
    KEY_READERS.has(reader) &&
    key !== undefined &&
    textOf(unwrapped(key)) === 'constructor'
  );
}

/**
 * What a call hands to the function it calls: its arguments; of one borrowed, `call` or `apply`,
 * what follows the `this` it takes, up to a spread — of `apply`, the elements of the array written
 * there, up to a spread as well; none of an array the code gives by a name, nor where a spread
 * comes before the array.
 */
function givenTo(call: CallExpression, borrowing: string | undefined): readonly Expression[] {
  if (borrowing === undefined) {
    return call.arguments;
  }
  if (borrowing === 'call') {
    return untilSpread(call.arguments).slice(1);
  }
  const [, list] = untilSpread(call.arguments);
  const array = list === undefined ? undefined : unwrapped(list);
  return array !== undefined && isArrayLiteralExpression(array) ? untilSpread(array.elements) : [];
}

/** `items` up to the first spread, past which where a value stands is for the code to tell. */
function untilSpread(items: readonly Expression[]): readonly Expression[] {
  const spread = items.findIndex((each) => isSpreadElement(each));
  return spread === -1 ? items : items.slice(0, spread);
}

/**
 * Whether `node` is erased from what runs, or names what it imports or exports alone: a type — but
 * `f<T>` and a class's `extends`, which read their expression — an import, an export of names.
 */
export function isErased(node: Node): boolean {
  return (
    (isTypeNode(node) && !isExpressionWithTypeArguments(node)) ||
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeParameterDeclaration(node) ||
    isImportDeclaration(node) ||
    isExportDeclaration(node)
  );
}

/**
 * The key a pattern takes what it binds or assigns apart by — `eval` of `const { eval: run } =
 * globalThis`, of `({ eval: run } = globalThis)`, of `{ ['eval']: run }` — where the code writes
 * it; none of another node.
 */
export function patternKey(node: Node): string | undefined {
  let key: Node | undefined;
  if (isBindingElement(node) && isObjectBindingPattern(node.parent)) {
    key = node.propertyName ?? node.name;
  } else if (
    (isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) &&
    isTakenApart(node.parent)
  ) {
    key = node.name;
  }
  if (key === undefined || isIdentifier(key)) {
    return key?.text;
  }
  return textOf(isComputedPropertyName(key) ? unwrapped(key.expression) : key);
}

/** The text `node` writes, a string, past a cast in angle brackets; none of another node. */
function textOf(node: Node): string | undefined {
  let written = node;
  while (isTypeAssertion(written)) {
    written = unwrapped(written.expression);
  }
  return isStringLiteral(written) || isNoSubstitutionTemplateLiteral(written)
    ? written.text
    : undefined;
}

/**
 * Whether `literal`, an object written, is a pattern: what an assignment takes apart, `({ eval:
 * run } = globalThis)` — within another, a default's target too — or a loop.
 */
export function isTakenApart(literal: Node): boolean {
  let at = literal;
  for (;;) {
    const { parent } = at;
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      return parent.left === at;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) {
      return parent.initializer === at;
    }
    if (!holdsPart(parent)) {
      return false;
    }
    at = parent;
  }
}

/** Whether `node` may hold a part of a pattern: parentheses, an array or an object, an entry, a spread. */
function holdsPart(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isArrayLiteralExpression(node) ||
    isObjectLiteralExpression(node) ||
    isPropertyAssignment(node) ||
    isShorthandPropertyAssignment(node) ||
    isSpreadElement(node) ||
    isSpreadAssignment(node)
  );
}
