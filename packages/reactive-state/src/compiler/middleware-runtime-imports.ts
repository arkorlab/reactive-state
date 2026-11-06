import {
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteral,
  type SourceFile,
} from 'typescript/ast';

/** Static module evaluation follows ordinary runtime imports and reexports, including empty clauses. */

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
  return specifiers;
}
