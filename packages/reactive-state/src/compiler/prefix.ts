import {
  type Identifier,
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMetaProperty,
  isParameterDeclaration,
  isTypeAliasDeclaration,
  isVariableStatement,
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
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and a decorator is no JavaScript yet. The Durable Object's
 * bundler would transform them, and the browser's code is compiled by Next.js: the server part
 * alone is refused them.
 */
function checkStrippable(node: Node, fail: Fail): void {
  if (isEnumDeclaration(node)) {
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
  if (isDecorator(node)) {
    fail(
      'The server part is run with its types stripped, and a decorator is not yet JavaScript: call the function on the class instead.',
      node,
    );
  }
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
