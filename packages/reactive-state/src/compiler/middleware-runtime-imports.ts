import {
  type Expression,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { declarationOf } from './framed.ts';
import { constantValue, type Resolve } from './numbers.ts';

/**
 * Module evaluation follows ordinary runtime imports and reexports, including empty clauses, and the
 * modules a file loads as it runs: `import('./state')` and CommonJS's `require('./state')`, wherever
 * they are written, by the specifier they write or a `const` of the file gives them.
 */

/**
 * What a module names where it loads one under a name it computes (`import(name)`, `require(name)`),
 * which no walk reads a file of: every part that reaches one is read as reaching the same.
 */
export const COMPUTED_IMPORT = 'import(…)';

/**
 * What a name holds where a `const` of its file gives it: the initializer of that declaration, so
 * `const name = './state'; import(name)` names the module `'./state'`. A `let`, a parameter and a name
 * the file does not declare hold nothing the file gives.
 */
const constants: Resolve = (name) => {
  const declared = declarationOf(name);
  return declared !== undefined &&
    isVariableDeclaration(declared) &&
    /^const\s/u.test(declared.parent.getText(name.getSourceFile()))
    ? declared.initializer
    : undefined;
};

/**
 * Whether `callee` loads the module its call is given: `import(…)`, or CommonJS's own `require(…)`
 * and `module.require(…)`, by those names, where the file declares one of its own of them or not.
 */
function loads(callee: Expression): boolean {
  return (
    callee.kind === SyntaxKind.ImportKeyword ||
    (isIdentifier(callee) && callee.text === 'require') ||
    (isPropertyAccessExpression(callee) &&
      isIdentifier(callee.expression) &&
      callee.expression.text === 'module' &&
      callee.name.text === 'require')
  );
}

/** Ordinary value declarations evaluate their dependency even when individual names are types. */
export function runtimeModuleSpecifiers(sourceFile: SourceFile): readonly string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      if (
        statement.importClause?.phaseModifier === undefined &&
        isStringLiteral(statement.moduleSpecifier)
      )
        specifiers.push(statement.moduleSpecifier.text);
    } else if (isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.moduleSpecifier !== undefined &&
        isStringLiteral(statement.moduleSpecifier)
      )
        specifiers.push(statement.moduleSpecifier.text);
    } else if (
      isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      isExternalModuleReference(statement.moduleReference) &&
      isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  const visit = (node: Node): void => {
    if (isCallExpression(node) && loads(node.expression)) {
      const [specifier] = node.arguments;
      const named = specifier === undefined ? undefined : constantValue(specifier, constants);
      specifiers.push(typeof named === 'string' ? named : COMPUTED_IMPORT);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return specifiers;
}
