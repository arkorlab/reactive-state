import {
  type Expression,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { declaredWithin } from './scope.ts';

/**
 * Module evaluation follows ordinary runtime imports and reexports, including empty clauses, and the
 * modules a file loads as it runs: `import('./state')` and CommonJS's `require('./state')`, wherever
 * they are written.
 */

/**
 * What a module names where it loads one under a name it computes (`import(name)`, `require(name)`),
 * which no walk reads a file of: every part that reaches one is read as reaching the same.
 */
export const COMPUTED_IMPORT = 'import(…)';

/** The names the file's imports bind: a default, a namespace, each named one, `import x = require()`'s. */
function importedNames(sourceFile: SourceFile): readonly string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (isImportEqualsDeclaration(statement)) {
      return [statement.name.text];
    }
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    const bound = clause?.namedBindings;
    const names = clause?.name === undefined ? [] : [clause.name.text];
    if (bound === undefined) {
      return names;
    }
    return isNamespaceImport(bound)
      ? [...names, bound.name.text]
      : [...names, ...bound.elements.map((element) => element.name.text)];
  });
}

/**
 * Whether `callee` loads the module its call is given: `import(…)`, or CommonJS's own `require(…)`
 * and `module.require(…)` — where the file declares no `require`, no `module` of its own, which it
 * may bind to a loader that resolves from another directory (`const require = createRequire(base)`),
 * and which its calls then name no module of the file's own directory by.
 */
function loads(callee: Expression, declared: ReadonlySet<string>): boolean {
  return (
    callee.kind === SyntaxKind.ImportKeyword ||
    (isIdentifier(callee) && callee.text === 'require' && !declared.has('require')) ||
    (isPropertyAccessExpression(callee) &&
      isIdentifier(callee.expression) &&
      callee.expression.text === 'module' &&
      callee.name.text === 'require' &&
      !declared.has('module'))
  );
}

/** Ordinary value declarations evaluate their dependency even when individual names are types. */
export function runtimeModuleSpecifiers(sourceFile: SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const declared = new Set(declaredWithin(sourceFile));
  for (const name of importedNames(sourceFile)) {
    declared.add(name);
  }
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
    if (isCallExpression(node) && loads(node.expression, declared)) {
      const [specifier] = node.arguments;
      specifiers.push(
        specifier !== undefined &&
          (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier))
          ? specifier.text
          : COMPUTED_IMPORT,
      );
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return specifiers;
}
