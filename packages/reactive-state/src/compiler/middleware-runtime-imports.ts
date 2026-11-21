import {
  type Expression,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

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

/**
 * Whether `callee` loads the module its call is given: `import(…)`, or `require(…)` and
 * `module.require(…)`, by those names and whatever the file declares of them — in a helper a
 * `require` loads relative to the file in every ordinary case: CommonJS's own, a bundler's, and the
 * `const require = createRequire(import.meta.url)` of ES modules. One made with another base, or a
 * function or a parameter the file names `require`, is read the same, which may refuse a split that
 * loads other modules: the refusing side, for forms nothing writes.
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
