import {
  type Identifier,
  type ImportDeclaration,
  isNamespaceImport,
  SyntaxKind,
} from 'typescript/ast';

/** The local names that import a module's default value, in either equivalent import spelling. */
export function defaultImportNames(statement: ImportDeclaration): readonly Identifier[] {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) return [];
  const names: Identifier[] = clause.name === undefined ? [] : [clause.name];
  const named = clause.namedBindings;
  if (named === undefined || isNamespaceImport(named)) return names;
  for (const element of named.elements) {
    if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'default') {
      names.push(element.name);
    }
  }
  return names;
}
