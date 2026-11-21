import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

/**
 * Module evaluation follows ordinary runtime imports and reexports, including empty clauses, and the
 * modules a file loads as it runs: `import('./state')`, wherever it is written.
 */

/**
 * What a module names where it loads one under a name it computes (`import(name)`), which no walk
 * reads a file of: every part that reaches one is read as reaching the same.
 */
export const COMPUTED_IMPORT = 'import(…)';

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
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
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
