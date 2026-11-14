import {
  type Identifier,
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isEnumDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isIdentifier,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isMetaProperty,
  isModuleBlock,
  isModuleDeclaration,
  isParameterDeclaration,
  isPropertyDeclaration,
  isSourceFile,
  isTypeAliasDeclaration,
  isVariableStatement,
  type ModuleDeclaration,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped, readsBinding } from './scope.ts';

/**
 * A component's server part — its code before its state, or the whole of a component of none — is
 * the application's own: the authority runs it as written, with the application's modules, for
 * every render and every write, so a revoked permission stops an old binding too. It is not
 * summarised, nor held to a vocabulary — the authority trusts the application's code as the
 * application's server does — and the compiler guards the boundary with the browser alone: none of
 * it, nor any value it computes, reaches the Client Component (`sides.ts`). What it may not hold is
 * what Node cannot run with its types stripped, and an import made at run time, whose path the
 * program, written elsewhere, would read from there.
 */

/**
 * The names the server part declares for the component as a whole: its own top-level declarations,
 * types included, and the `var`s anywhere in it outside its own functions, which JavaScript scopes
 * to the component. In the order they are written.
 */
export function prefixDeclarations(prefix: readonly Statement[]): readonly Identifier[] {
  const found: Identifier[] = [];
  for (const statement of prefix) {
    if (isVariableStatement(statement) && isBlockScoped(statement.declarationList)) {
      for (const declaration of statement.declarationList.declarations) {
        found.push(...bindingIdentifiers(declaration.name));
      }
    } else if (
      (isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isEnumDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isInterfaceDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      found.push(statement.name);
    }
  }
  for (const declaration of hoistedIn(prefix)) {
    found.push(...bindingIdentifiers(declaration.name));
  }
  return found.toSorted((a, b) => a.pos - b.pos);
}

/**
 * Refuses what the authority's program cannot hold, wherever it is in the server part. `declared`
 * is every name the component's file declares.
 */
export function checkServerNode(node: Node, declared: ReadonlySet<string>, fail: Fail): void {
  checkStrippable(node, fail);
  checkModuleSyntax(node, fail);
  checkRunTimeImport(node, declared, fail);
}

/** The modifiers that make a constructor's parameter a property: TypeScript's, not JavaScript's. */
const PARAMETER_PROPERTY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.OverrideKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.ReadonlyKeyword,
]);

/**
 * Node runs the authority's program with its types stripped, and nothing more: what only a
 * transform turns into JavaScript — an `enum`, a parameter property — fails to load there
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and a decorator, and an `accessor` field, are no JavaScript
 * yet: stripping leaves the field as written and the engine fails to parse it. The Durable Object's
 * bundler would transform them, and the browser's code is compiled by Next.js: the server part
 * alone is refused them. Within a `declare` all of it is erased: an `enum`, an `accessor` field, and
 * a decorator of what the declaration holds, though not one written before a `declare`d class, nor
 * a parameter property. An `abstract` `accessor` field is erased wherever it is written, with the
 * class's other abstract members.
 */
function checkStrippable(node: Node, fail: Fail): void {
  if (isEnumDeclaration(node) && !ambient(node)) {
    fail(
      'The server part is run with its types stripped, which leaves an `enum` nothing to run: declare an object of constants instead.',
      node,
    );
  }
  if (
    isParameterDeclaration(node) &&
    node.modifiers?.some((modifier) => PARAMETER_PROPERTY.has(modifier.kind)) === true
  ) {
    fail(
      "The server part is run with its types stripped, which leaves a parameter property nothing to run: assign the field in the constructor's body instead.",
      node,
    );
  }
  if (isDecorator(node) && !ambient(node.parent, false)) {
    fail(
      'The server part is run with its types stripped, and a decorator is not yet JavaScript: call the function on the class instead.',
      node,
    );
  }
  if (isRunTimeAccessor(node)) {
    fail(
      'The server part is run with its types stripped, and an `accessor` field is not yet JavaScript: write a getter and a setter over a private field instead.',
      node,
    );
  }
}

/**
 * Whether `node` is an `accessor` field that stripping leaves in the program: not an `abstract`
 * one, which goes with the class's abstract members, nor one within a `declare`d class or
 * namespace. A `declare` written on the field alone erases nothing.
 */
function isRunTimeAccessor(node: Node): boolean {
  if (!isPropertyDeclaration(node)) return false;
  const kinds = node.modifiers?.map((modifier) => modifier.kind) ?? [];
  return (
    kinds.includes(SyntaxKind.AccessorKeyword) &&
    !kinds.includes(SyntaxKind.AbstractKeyword) &&
    !ambient(node)
  );
}

/**
 * Node refuses as well what it would have to build from a `namespace` or `module` that holds code,
 * from an `import … =` and from an `export =`: each is TypeScript's, where JavaScript has the
 * module's own forms. A `namespace` of types alone leaves nothing to run, and a `declare`d one is
 * erased whole, an `import … =` or an `export =` within it too: Node runs them all.
 */
function checkModuleSyntax(node: Node, fail: Fail): void {
  if (isModuleDeclaration(node) && !ambient(node) && holdsCode(node)) {
    fail(
      'The server part is run with its types stripped, which leaves a `namespace` that holds more than types nothing to run: declare an object of constants instead.',
      node,
    );
  }
  if (isImportEqualsDeclaration(node) && !ambient(node)) {
    fail(
      "The server part is run with its types stripped, which leaves an `import … =` nothing to run: import the module by name, beside the component's other imports.",
      node,
    );
  }
  if (isExportAssignment(node) && node.isExportEquals && !ambient(node)) {
    fail(
      'The server part is run with its types stripped, which leaves an `export =` nothing to run: export what the module offers by name instead.',
      node,
    );
  }
}

/**
 * Whether a `declare` is on the node or on a namespace, module or class around it, as `self` allows
 * for the node itself: ambient code is erased whole.
 */
function ambient(node: Node, self = true): boolean {
  for (let at = self ? node : node.parent; !isSourceFile(at); at = at.parent) {
    if (declares(at)) return true;
  }
  return false;
}

/**
 * Whether a namespace holds anything but `interface`s, type aliases and namespaces of those, as
 * `namespace A.B` is a namespace of one. Any other statement is code to Node, a `declare`d value
 * and an `import` among them, and a `declare`d namespace within is read for what it holds.
 */
function holdsCode(declaration: ModuleDeclaration): boolean {
  const pending: ModuleDeclaration[] = [declaration];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const { body } = each;
    if (body === undefined) continue;
    if (isModuleDeclaration(body)) {
      pending.push(body);
      continue;
    }
    if (!isModuleBlock(body)) return true;
    for (const statement of body.statements) {
      if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) continue;
      if (!isModuleDeclaration(statement)) return true;
      pending.push(statement);
    }
  }
  return false;
}

/** Whether a declaration of a namespace, a module, a class or an enum is a `declare`d one on its own. */
function declares(declaration: Node): boolean {
  return (
    (isModuleDeclaration(declaration) ||
      isClassDeclaration(declaration) ||
      isEnumDeclaration(declaration)) &&
    declaration.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword) === true
  );
}

/** The names CommonJS gives each of its modules, which an ES module has none of. */
const COMMONJS: ReadonlySet<string> = new Set([
  '__dirname',
  '__filename',
  'exports',
  'module',
  'require',
]);

/**
 * Refuses an import made at run time, and the module's own URL: the outputs are written elsewhere
 * than the component, where a relative path names another module. And CommonJS's own names —
 * `require`, `__dirname` and the rest — unless the file declares one of its own: both outputs are
 * ES modules, which have none of them.
 */
export function checkRunTimeImport(node: Node, declared: ReadonlySet<string>, fail: Fail): void {
  if (
    (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) ||
    (isMetaProperty(node) && node.keywordToken === SyntaxKind.ImportKeyword)
  ) {
    fail(
      'The component imports nothing at run time, nor reads its own URL: its outputs are written elsewhere, where a relative path names another module. Import the module beside the component.',
      node,
    );
  }
  if (
    isIdentifier(node) &&
    COMMONJS.has(node.text) &&
    !declared.has(node.text) &&
    readsBinding(node)
  ) {
    fail(
      `\`${node.text}\` is CommonJS's, and the component's outputs are ES modules, written elsewhere than the component, which have none: import what the component reads by name, beside its other imports.`,
      node,
    );
  }
}
