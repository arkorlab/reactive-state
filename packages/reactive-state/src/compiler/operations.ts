import {
  type FunctionDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isNamedExports,
  isVariableStatement,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { failIn } from './errors.ts';
import type { ParsedModule } from './modules.ts';
import type { OperationCallable } from './operation-callables.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * A `'use server'` module a component, or a hook, imports: the authority runs it as an operation
 * module, as the application wrote it, and the host calls each of its functions through a stub of
 * the same name (`actions/…`), which asks the authority to run it.
 */
export interface OperationModule {
  /** Its id: its path in the source directory, without its extension. */
  readonly id: string;
  /** How the authority's registry imports it: as the first component that imports it writes it. */
  readonly written: string;
  readonly fileName: string;
  /** The names of the functions it exports, in the order it declares them. */
  readonly exports: readonly string[];
  /** Finite written callable overloads retained by the asynchronous stub. */
  readonly callables?: ReadonlyMap<string, OperationCallable>;
}

/**
 * Whether `statement` re-exports another module's exports without naming them — `export * from`,
 * `export * as name from` — which the compile cannot list.
 */
function isStarExport(statement: Statement): boolean {
  return (
    isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    (statement.exportClause === undefined || !isNamedExports(statement.exportClause))
  );
}

/** The functions a `'use server'` module exports, by the name each is exported under. */
export function operationExports(parsed: ParsedModule): readonly string[] {
  const fail = failIn(parsed.sourceFile, parsed.name);
  const names: string[] = [];
  for (const statement of parsed.sourceFile.statements) {
    if (isStarExport(statement)) {
      fail(
        "A `'use server'` module exports its operations by name — `export { more } from './more'`: what `export *` re-exports, the compile cannot list, and the host would have no Server Function for it.",
        statement,
      );
    }
    for (const name of exportedBy(statement)) {
      if (names.includes(name)) {
        fail(`\`${name}\` is exported twice.`, statement);
      }
      names.push(name);
    }
  }
  return names;
}

/** Whether a declaration carries `modifier`: `export`, `default`, `declare`. */
function carries(
  statement: FunctionDeclaration | VariableStatement,
  modifier: SyntaxKind,
): boolean {
  return statement.modifiers?.some((each) => each.kind === modifier) === true;
}

/** Whether a declaration exports a runtime binding rather than an erased `declare` signature. */
function exportsRuntime(statement: FunctionDeclaration | VariableStatement): boolean {
  return (
    carries(statement, SyntaxKind.ExportKeyword) && !carries(statement, SyntaxKind.DeclareKeyword)
  );
}

function exportedFunction(statement: FunctionDeclaration): readonly string[] {
  if (statement.body === undefined || !exportsRuntime(statement)) {
    return [];
  }
  if (carries(statement, SyntaxKind.DefaultKeyword)) {
    return ['default'];
  }
  return statement.name === undefined ? [] : [statement.name.text];
}

function exportedBy(statement: Statement): readonly string[] {
  if (isFunctionDeclaration(statement)) {
    return exportedFunction(statement);
  }
  if (isVariableStatement(statement)) {
    return exportsRuntime(statement)
      ? statement.declarationList.declarations.flatMap((declaration) =>
          bindingIdentifiers(declaration.name).map((bound) => bound.text),
        )
      : [];
  }
  if (isExportAssignment(statement) && !statement.isExportEquals) {
    return ['default'];
  }
  if (
    isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause !== undefined &&
    isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => element.name.text);
  }
  return [];
}
