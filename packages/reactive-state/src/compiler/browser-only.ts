import {
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportSpecifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isModuleBlock,
  isModuleDeclaration,
  isNamedExports,
  isNamespaceImport,
  isNonNullExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type JsxAttribute,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { unshadowedReads } from './code-globals.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/**
 * What of a Client Component's code runs in the browser alone, never as the server renders the
 * document (`reach.ts`): a function a JSX attribute of an event or of a ref of an element of the
 * platform's is handed — `<button onClick={() => …}>`, `<p ref={(node) => …}>` — the callback an
 * effect of React's own is called with first, `useEffect(() => …)`, and a function of the file's own
 * that nothing but such code reaches by its name — `signIn`, which only `onClick={() => signIn(id)}`
 * calls — or what React's `useCallback` is handed of one. Everything else of it may run as the
 * server renders it: its body, its helpers, a hook's initializer, `useState(() => …)`,
 * `useMemo(() => …)`, a form's action, which may run on the server too, what a component is handed
 * of any prop, `onValue` or `ref` among them, which it may call as it renders, and what a function
 * of an effect's name is handed that is no hook of React's — the file's own, another module's —
 * which may call it as it runs.
 */

/** The module React's hooks are imported from. */
const REACT = 'react';

/** React's hooks whose callback runs in the browser alone, after a render: its effects. */
const EFFECTS: ReadonlySet<string> = new Set([
  'useEffect',
  'useInsertionEffect',
  'useLayoutEffect',
]);

/** React's hook that hands back the function it is given, to be called later. */
const CALLBACKS: ReadonlySet<string> = new Set(['useCallback']);

/** The name of a JSX attribute of an event, `on` then a capital, `onClick`; and of a ref. */
const EVENT = /^on[A-Z]/u;
const REF = 'ref';

/** Each file's code of the browser alone, as `browserOnlyIn` reads it once. */
const SKIPPED = new WeakMap<SourceFile, (node: Node) => boolean>();

/** A function of the file's own, which only the browser's code may reach, and what runs of it. */
interface Candidate {
  readonly name: string;
  /** The function, its declaration, or what `useCallback` is handed. */
  readonly body: Node;
}

/** What `node` stands in, past the parentheses, the casts, in angle brackets too, and the `!` around it. */
function holderOf(node: Node): Node {
  let at = node.parent;
  while (
    isParenthesizedExpression(at) ||
    isAsExpression(at) ||
    isSatisfiesExpression(at) ||
    isNonNullExpression(at) ||
    isTypeAssertion(at)
  ) {
    at = at.parent;
  }
  return at;
}

/** `node` past what `unwrapped` strips and the casts in angle brackets it leaves, `<any>useEffect`. */
function uncast(node: Expression): Expression {
  let each = unwrapped(node);
  while (isTypeAssertion(each)) {
    each = unwrapped(each.expression);
  }
  return each;
}

/** What a file reads React's own hooks by, as `reactNamesOf` reads it once. */
interface ReactNames {
  /** Each name the file imports a value of `react`'s by, with `react`'s: `useEffect` of `onMount`. */
  readonly hooks: ReadonlyMap<string, string>;
  /** The names `react` is imported by whole: `React` of `import * as React`, of `import React`. */
  readonly whole: ReadonlySet<string>;
  /**
   * The reads of a name no function, block, `catch` or namespace around them declares
   * (`unshadowedReads`).
   */
  readonly free: ReadonlySet<Identifier>;
}

/** Each file's names of React's hooks, as `reactNamesOf` reads them once. */
const REACT_NAMES = new WeakMap<SourceFile, ReactNames>();

/** What `statement`, where it imports values of `react`, names of React's: into `hooks`, `whole`. */
function readReact(statement: Statement, hooks: Map<string, string>, whole: Set<string>): void {
  const clause =
    isImportDeclaration(statement) &&
    isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === REACT
      ? statement.importClause
      : undefined;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return;
  }
  if (clause.name !== undefined) {
    whole.add(clause.name.text);
  }
  const named = clause.namedBindings;
  if (named === undefined) {
    return;
  }
  if (isNamespaceImport(named)) {
    whole.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    if (!element.isTypeOnly) {
      hooks.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
}

/** The names `sourceFile` reads React's hooks by: what it imports of `react`, and where it reads it. */
function reactNamesOf(sourceFile: SourceFile): ReactNames {
  let names = REACT_NAMES.get(sourceFile);
  if (names === undefined) {
    const hooks = new Map<string, string>();
    const whole = new Set<string>();
    for (const statement of sourceFile.statements) {
      readReact(statement, hooks, whole);
    }
    names = { free: unshadowedReads(sourceFile), hooks, whole };
    REACT_NAMES.set(sourceFile, names);
  }
  return names;
}

/**
 * Whether `callee` names one of React's own hooks of `names`, as the file imports it of `react` and
 * no scope around the read declares the name again: by name, `useEffect`, or another,
 * `onMount` of `{ useEffect as onMount }`; or a member of `react` imported whole, `React.useEffect`
 * — none of a function of the file's own, nor of another module's, of the name.
 */
function namesHook(callee: Expression, names: ReadonlySet<string>): boolean {
  const named = uncast(callee);
  const react = reactNamesOf(named.getSourceFile());
  if (isIdentifier(named)) {
    return react.free.has(named) && names.has(react.hooks.get(named.text) ?? '');
  }
  const whole = isPropertyAccessExpression(named) ? uncast(named.expression) : undefined;
  return (
    whole !== undefined &&
    isPropertyAccessExpression(named) &&
    names.has(named.name.text) &&
    isIdentifier(whole) &&
    react.whole.has(whole.text) &&
    react.free.has(whole)
  );
}

/**
 * Whether `attribute` is one of an element of the platform's, which React renders itself, calling
 * none of what it is handed as it renders: of a tag in lower case, `button`, or of a dash,
 * `stamp-button` — none of a component's, which may call any of its props as it renders, a ref too.
 */
function ofPlatformElement(attribute: JsxAttribute): boolean {
  const element = attribute.parent.parent;
  const tag =
    isJsxOpeningElement(element) || isJsxSelfClosingElement(element) ? element.tagName : undefined;
  return (
    tag !== undefined && isIdentifier(tag) && (/^[a-z]/u.test(tag.text) || tag.text.includes('-'))
  );
}

/**
 * Whether `node` — a function, or a name of one — is handed to the browser alone where it stands: a
 * JSX attribute's value of an event or of a ref of an element of the platform's
 * (`ofPlatformElement`), or what an effect is called with first.
 */
function isHandedToBrowser(node: Node): boolean {
  const holder = holderOf(node);
  if (isJsxExpression(holder)) {
    const attribute = holder.parent;
    return (
      isJsxAttribute(attribute) &&
      isIdentifier(attribute.name) &&
      (EVENT.test(attribute.name.text) || attribute.name.text === REF) &&
      ofPlatformElement(attribute)
    );
  }
  const [first] = isCallExpression(holder) ? holder.arguments : [];
  return (
    isCallExpression(holder) &&
    first !== undefined &&
    uncast(first) === node &&
    namesHook(holder.expression, EFFECTS)
  );
}

/** Whether `node` is a function written where it is handed to the browser alone. */
function isBrowserFunction(node: Node): boolean {
  return (isArrowFunction(node) || isFunctionExpression(node)) && isHandedToBrowser(node);
}

/** Whether `node` names a value where it is declared: a variable, a parameter, an import. */
function declaresValue(node: Identifier): boolean {
  const { parent } = node;
  return (
    (isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent) ||
      isFunctionDeclaration(parent) ||
      isFunctionExpression(parent) ||
      isClassDeclaration(parent) ||
      isClassExpression(parent) ||
      isEnumDeclaration(parent) ||
      isImportClause(parent) ||
      isImportSpecifier(parent) ||
      isNamespaceImport(parent)) &&
    parent.name === node
  );
}

/** `node` within the parentheses, casts and `!` that wrap it, which `uncast` reads past. */
function wrapperOf(node: Node): Node {
  let at = node;
  while (
    isParenthesizedExpression(at) ||
    isAsExpression(at) ||
    isSatisfiesExpression(at) ||
    isNonNullExpression(at) ||
    isTypeAssertion(at)
  ) {
    at = at.parent;
  }
  return at;
}

/** Whether `node` is a call of `useCallback` that is handed `fn`, past casts, as its function. */
function isCallbackOf(node: Node, fn: Node): boolean {
  const [first] = isCallExpression(node) ? node.arguments : [];
  return (
    isCallExpression(node) &&
    first !== undefined &&
    uncast(first) === fn &&
    namesHook(node.expression, CALLBACKS)
  );
}

/**
 * Whether `node` is the name of a function or class expression that the constant of that name
 * holds, `const handler = function handler() {}`, past the parentheses, casts and `!` that
 * `constantBody` reads past, and the call of `useCallback` it is handed to, `const handler =
 * useCallback(function handler() {}, [])`: within it, it is that value, as the constant's name is
 * — one name, one value. None of a function another call is handed, or one `useCallback` is given
 * among its dependencies, whose answer is not the function.
 */
function namesItsHolder(node: Identifier): boolean {
  const { parent } = node;
  if (!(isFunctionExpression(parent) || isClassExpression(parent)) || parent.name !== node) {
    return false;
  }
  let holder = wrapperOf(parent.parent);
  if (isFunctionExpression(parent) && isCallbackOf(holder, parent)) {
    holder = wrapperOf(holder.parent);
  }
  return (
    isVariableDeclaration(holder) && isIdentifier(holder.name) && holder.name.text === node.text
  );
}

/** Whether `statement` is exported: `export`, `export default`. */
function isExported(statement: FunctionDeclaration | VariableStatement): boolean {
  return statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true;
}

/** The names `statement` exports of the file's own: `export function`, `export { name }`. */
function exportedBy(statement: Statement): readonly string[] {
  if (isFunctionDeclaration(statement)) {
    return isExported(statement) && statement.name !== undefined ? [statement.name.text] : [];
  }
  if (isVariableStatement(statement)) {
    return isExported(statement)
      ? statement.declarationList.declarations.map(({ name }) =>
          isIdentifier(name) ? name.text : '',
        )
      : [];
  }
  if (isExportAssignment(statement)) {
    return isIdentifier(statement.expression) ? [statement.expression.text] : [];
  }
  const clause =
    isExportDeclaration(statement) && statement.moduleSpecifier === undefined
      ? statement.exportClause
      : undefined;
  return clause !== undefined && isNamedExports(clause)
    ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
    : [];
}

/**
 * The names `statements` export of the file's own (`exportedBy`), and those a namespace's body
 * exports, which the code reads as members of the namespace, `Helpers.read()`, by no name of theirs.
 */
function exportedIn(statements: readonly Statement[]): readonly string[] {
  return statements.flatMap((statement) => {
    if (!isModuleDeclaration(statement)) {
      return exportedBy(statement);
    }
    const { body } = statement;
    if (body !== undefined && isModuleDeclaration(body)) {
      return exportedIn([body]);
    }
    return body !== undefined && isModuleBlock(body) ? exportedIn(body.statements) : [];
  });
}

/** What runs when a `const` is called: its function, or what `useCallback` is handed of one. */
function constantBody(initializer: Expression): Node | undefined {
  const value = uncast(initializer);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return value;
  }
  const [handed] = isCallExpression(value) ? value.arguments : [];
  const given = handed === undefined ? undefined : uncast(handed);
  return given !== undefined &&
    isCallExpression(value) &&
    namesHook(value.expression, CALLBACKS) &&
    (isArrowFunction(given) || isFunctionExpression(given))
    ? given
    : undefined;
}

/** `node` as a candidate, where it is a function of the file's own a declaration names. */
function candidateOf(node: Node): Candidate | undefined {
  if (isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
    return { body: node, name: node.name.text };
  }
  if (
    !isVariableDeclaration(node) ||
    !isIdentifier(node.name) ||
    node.initializer === undefined ||
    !isVariableDeclarationList(node.parent) ||
    !/^const\s/u.test(node.parent.getText())
  ) {
    return undefined;
  }
  const body = constantBody(node.initializer);
  return body === undefined ? undefined : { body, name: node.name.text };
}

/** What `sourceFile` declares and reads of values: each declaration's name, each read of one. */
interface Names {
  readonly declared: Map<string, number>;
  readonly reads: Map<string, Identifier[]>;
  readonly candidates: Candidate[];
}

/** The names `sourceFile` declares and reads of values, outside its types, and its candidates. */
function namesOf(sourceFile: SourceFile): Names {
  const names: Names = { candidates: [], declared: new Map(), reads: new Map() };
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    const candidate = candidateOf(node);
    if (candidate !== undefined) {
      names.candidates.push(candidate);
    }
    if (isIdentifier(node) && declaresValue(node)) {
      if (!namesItsHolder(node)) {
        names.declared.set(node.text, (names.declared.get(node.text) ?? 0) + 1);
      }
    } else if (isIdentifier(node) && readsBinding(node)) {
      names.reads.set(node.text, [...(names.reads.get(node.text) ?? []), node]);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return names;
}

/**
 * Whether `read` stands in the browser's code alone: handed to it itself, or within a function
 * written where it is, or within the body of a function of `skipped`.
 */
function readInBrowser(read: Identifier, skipped: ReadonlySet<Node>): boolean {
  if (isHandedToBrowser(read)) {
    return true;
  }
  for (let at: Node = read.parent; !isSourceFile(at); at = at.parent) {
    if (skipped.has(at) || isBrowserFunction(at)) {
      return true;
    }
  }
  return false;
}

/**
 * The code of `sourceFile` that runs in the browser alone, as a predicate of each node: a function
 * handed to the browser where it is written (`isHandedToBrowser`), and a function of the file's
 * own, neither exported — by the module or by a namespace (`exportedIn`) — nor of a name declared
 * twice, each of whose reads stands in such code or in another function so skipped — all of them
 * taken for skipped first, and each a read outside such code is found of dropped, until none is.
 */
export function browserOnlyIn(sourceFile: SourceFile): (node: Node) => boolean {
  let skips = SKIPPED.get(sourceFile);
  if (skips === undefined) {
    const { candidates, declared, reads } = namesOf(sourceFile);
    const exported = new Set(exportedIn(sourceFile.statements));
    let kept = candidates.filter(
      (candidate) => declared.get(candidate.name) === 1 && !exported.has(candidate.name),
    );
    for (let changed = true; changed;) {
      const skipped = new Set(kept.map((candidate) => candidate.body));
      const before = kept.length;
      kept = kept.filter((candidate) =>
        (reads.get(candidate.name) ?? []).every((read) => readInBrowser(read, skipped)),
      );
      changed = kept.length !== before;
    }
    const bodies = new Set(kept.map((candidate) => candidate.body));
    skips = (node) => bodies.has(node) || isBrowserFunction(node);
    SKIPPED.set(sourceFile, skips);
  }
  return skips;
}
