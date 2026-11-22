import {
  type Identifier,
  type ImportDeclaration,
  isNamespaceImport,
  isStringLiteral,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { FRAMEWORK, type ModuleClass } from './modules.ts';

/**
 * What a component, or a module of custom hooks, imports, and what each output imports of it.
 * `framework/react`'s `useReactiveState` is the compiler's one intrinsic; every other module is the
 * application's or a library's, and each output imports what it reads of one as the source wrote
 * it — or, for a module the compile writes a copy or a stub of, from that — and the types it names
 * as types alone, which `verbatimModuleSyntax` erases.
 */

/** The compiler's intrinsic, which declares a state. */
export const INTRINSIC = 'useReactiveState';

/** The modules of the framework a component imported before the second protocol, and what replaces each. */
const RETIRED: ReadonlyMap<string, string> = new Map([
  ['framework/auth', '@/auth'],
  ['framework/db', '@/db'],
]);

/**
 * The names the outputs declare at their own top level or import, which an import of the source's
 * would collide with: the authority's program's, the Client Component's and the root's.
 */
const DECLARED_BY_OUTPUTS: ReadonlySet<string> = new Set([
  'actionRef',
  'buildId',
  'ClientPartProps',
  'component',
  'componentRef',
  'elements',
  'evaluate',
  'localOf',
  'LocalStateInput',
  'moduleRef',
  'ProgramUpdater',
  'props',
  'protocolVersion',
  'renderRoot',
  'RenderScope',
  'slotOf',
  'StateInput',
  'stateOf',
  'States',
  'StatesOf',
  'update',
  'updaters',
  'useSites',
  'view',
  'writable',
]);

/** One name an import declares. */
export interface ImportBinding {
  readonly name: Identifier;
  readonly form: 'default' | 'named' | 'namespace';
  /** What the module exports it as: `default` for a default import, its name for a named one. */
  readonly exported: string;
  /** The export as the source wrote it — `a`, `"a-b"` — where it is named another way than `name`. */
  readonly written: string | undefined;
  /** Imported as a type alone (`import type`, `import { type T }`), which has no value at run time. */
  readonly typeOnly: boolean;
  readonly module: ImportedModule;
}

/** One import declaration. */
export interface ImportedModule {
  readonly declaration: ImportDeclaration;
  /** The module's specifier. */
  readonly specifier: string;
  /** The specifier as the source wrote it, quotes and all, which an output writes again. */
  readonly written: string;
  readonly bindings: readonly ImportBinding[];
  /** What the module is. */
  readonly target: ModuleClass;
}

export interface Imports {
  readonly modules: readonly ImportedModule[];
  /** The name the intrinsic is imported under, when it is. */
  readonly intrinsic: Identifier | undefined;
}

/**
 * The imports `declarations` make, each module classified by `classify`. Refused: what the outputs,
 * written elsewhere, could not import as the source does — a relative path, a module imported for
 * its effect alone, attributes — and a name an output declares itself.
 */
export function readImports(
  declarations: readonly ImportDeclaration[],
  sourceFile: SourceFile,
  classify: (specifier: string) => ModuleClass,
  fail: Fail,
): Imports {
  const modules: ImportedModule[] = [];
  let intrinsic: Identifier | undefined;
  for (const declaration of declarations) {
    const specifier = specifierOf(declaration, sourceFile, fail);
    if (specifier === FRAMEWORK) {
      if (intrinsic !== undefined) {
        fail(`\`${FRAMEWORK}\` is imported once, for \`${INTRINSIC}\`.`, declaration);
      }
      intrinsic = intrinsicOf(declaration, sourceFile, fail);
    } else {
      modules.push(moduleOf(declaration, { classify, sourceFile, specifier }, fail));
    }
  }
  return { intrinsic, modules };
}

function specifierOf(declaration: ImportDeclaration, sourceFile: SourceFile, fail: Fail): string {
  const { attributes, importClause, moduleSpecifier } = declaration;
  if (!isStringLiteral(moduleSpecifier)) {
    return fail('A module is imported by a string.', moduleSpecifier);
  }
  const specifier = moduleSpecifier.text;
  const replacement = RETIRED.get(specifier);
  if (replacement !== undefined) {
    fail(
      `\`${specifier}\` is gone: a component imports the application's own modules — \`${replacement}\`, written with \`@arkorlab/reactive-state/server\` — and the authority runs them as they are.`,
      declaration,
    );
  }
  if (specifier !== FRAMEWORK && specifier.startsWith('framework/')) {
    fail(
      `\`${specifier}\` is not a module of the framework: a component imports \`${INTRINSIC}\` from \`${FRAMEWORK}\`, and the application's own modules.`,
      declaration,
    );
  }
  // The outputs are written into a directory of their own, where a path relative to the source
  // names another module.
  if (specifier.startsWith('.')) {
    fail(
      `\`${specifier}\` is a relative path, which names another module from where the outputs are written: import it by a path of the application's, as \`@/…\`.`,
      moduleSpecifier,
    );
  }
  if (importClause === undefined) {
    fail(
      `\`import ${moduleSpecifier.getText(sourceFile)}\` imports a module for its effect alone, which runs on neither side the compiler can name: import what the component reads, by name.`,
      declaration,
    );
  }
  // An import of no name runs the module all the same, as one for its effect alone does; one of
  // types alone runs nothing.
  const { name, namedBindings, phaseModifier } = importClause;
  if (
    name === undefined &&
    namedBindings !== undefined &&
    phaseModifier !== SyntaxKind.TypeKeyword &&
    !isNamespaceImport(namedBindings) &&
    namedBindings.elements.length === 0
  ) {
    fail(
      `\`import {} from ${moduleSpecifier.getText(sourceFile)}\` names nothing: it imports a module for its effect alone, which runs on neither side the compiler can name: import what the component reads, by name.`,
      declaration,
    );
  }
  if (phaseModifier === SyntaxKind.DeferKeyword || phaseModifier === SyntaxKind.SourceKeyword) {
    fail(
      'An `import defer` or an `import source` is not supported: each output imports the modules it runs as they are.',
      declaration,
    );
  }
  if (attributes !== undefined) {
    fail(
      'An import with attributes is not supported: each output writes its imports anew, some of them as types, which carry none.',
      attributes,
    );
  }
  return specifier;
}

/** `import { useReactiveState } from 'framework/react'`, by name and under that name. */
function intrinsicOf(
  declaration: ImportDeclaration,
  sourceFile: SourceFile,
  fail: Fail,
): Identifier {
  const clause = declaration.importClause;
  const bindings = clause?.namedBindings;
  if (
    bindings === undefined ||
    clause === undefined ||
    clause.name !== undefined ||
    clause.phaseModifier !== undefined ||
    isNamespaceImport(bindings)
  ) {
    return fail(
      `\`${INTRINSIC}\` is imported by name, as a value: \`import { ${INTRINSIC} } from '${FRAMEWORK}'\`.`,
      declaration,
    );
  }
  const [element, ...more] = bindings.elements;
  for (const extra of more) {
    fail(
      `\`${extra.name.text}\` is not of \`${FRAMEWORK}\`, whose one export a component imports is \`${INTRINSIC}\`.`,
      extra,
    );
  }
  if (element?.isTypeOnly !== false || element.propertyName !== undefined) {
    return fail(
      `\`${INTRINSIC}\` is imported under its own name, as a value: the compiler finds the state by it.`,
      element ?? declaration,
    );
  }
  if (element.name.text !== INTRINSIC) {
    return fail(
      `\`${element.name.getText(sourceFile)}\` is not of \`${FRAMEWORK}\`, whose one export a component imports is \`${INTRINSIC}\`.`,
      element,
    );
  }
  return element.name;
}

interface Reading {
  readonly specifier: string;
  readonly sourceFile: SourceFile;
  readonly classify: (specifier: string) => ModuleClass;
}

function moduleOf(declaration: ImportDeclaration, reading: Reading, fail: Fail): ImportedModule {
  const { classify, sourceFile, specifier } = reading;
  const clause = declaration.importClause;
  const typeOnly = clause?.phaseModifier === SyntaxKind.TypeKeyword;
  const bindings: ImportBinding[] = [];
  const imported: ImportedModule = {
    bindings,
    declaration,
    specifier,
    target: classify(specifier),
    written: declaration.moduleSpecifier.getText(sourceFile),
  };
  const add = (binding: Omit<ImportBinding, 'module'>): void => {
    if (DECLARED_BY_OUTPUTS.has(binding.name.text)) {
      fail(
        `\`${binding.name.text}\` is a name an output declares itself: import it under another one.`,
        binding.name,
      );
    }
    bindings.push({ ...binding, module: imported });
  };
  if (clause?.name !== undefined) {
    add({ exported: 'default', form: 'default', name: clause.name, typeOnly, written: undefined });
  }
  const named = clause?.namedBindings;
  if (named !== undefined && isNamespaceImport(named)) {
    add({ exported: '*', form: 'namespace', name: named.name, typeOnly, written: undefined });
  } else if (named !== undefined) {
    for (const element of named.elements) {
      const exportedName = element.propertyName ?? element.name;
      add({
        exported: isStringLiteral(exportedName)
          ? exportedName.text
          : exportedName.getText(sourceFile),
        form: 'named',
        name: element.name,
        typeOnly: typeOnly || element.isTypeOnly,
        written: element.propertyName?.getText(sourceFile),
      });
    }
  }
  return imported;
}

/** One name an output imports: from where, under which name, and whether as a type alone. */
export interface ImportLine {
  /** The specifier as the output writes it, quotes and all. */
  readonly from: string;
  readonly binding: ImportBinding;
  readonly typeOnly: boolean;
  /** The name the output imports it under, where it is not the source's. */
  readonly local?: string;
}

/** The name an output imports a line's binding under. */
function localOf(line: ImportLine): string {
  return line.local ?? line.binding.name.text;
}

/**
 * The import declarations of `lines`, in their order: the names of one module read at run time on
 * one line, and the ones its types alone name on another, as types. A type-only import names a
 * default or named bindings, never both, so each form of them gets its own. A module stands where
 * its first runtime line does — a type-only import is erased, so one before it moves nothing — and
 * a module read as types alone where its first line does.
 */
export function importDeclarations(lines: readonly ImportLine[]): readonly string[] {
  const byModule = new Map<
    string,
    { first: number; run: ImportLine[]; from: string; typed: ImportLine[] }
  >();
  for (const [index, line] of lines.entries()) {
    let entry = byModule.get(line.from);
    if (entry === undefined) {
      entry = { first: index, from: line.from, run: [], typed: [] };
      byModule.set(line.from, entry);
    }
    if (!line.typeOnly && entry.run.length === 0) {
      entry.first = index;
    }
    const into = line.typeOnly ? entry.typed : entry.run;
    if (into.every((other) => localOf(other) !== localOf(line))) {
      into.push(line);
    }
  }
  return [...byModule.values()]
    .toSorted((one, other) => one.first - other.first)
    .flatMap(({ from, run, typed }) => moduleImports(run, typed, from));
}

/** The import declarations of one module's runtime and type-only bindings. */
function moduleImports(
  run: readonly ImportLine[],
  typed: readonly ImportLine[],
  from: string,
): readonly string[] {
  const written: string[] = [];
  // A namespace import is a declaration of its own: `import a, * as b` is the one way to name
  // both, and named bindings cannot join one.
  const namespaces = run.filter((line) => line.binding.form === 'namespace');
  const others = run.filter((line) => line.binding.form !== 'namespace');
  if (others.length > 0) {
    written.push(`import ${clauseOf(others)} from ${from};`);
  }
  for (const namespace of namespaces) {
    written.push(`import * as ${localOf(namespace)} from ${from};`);
  }
  const typedOnly = typed.filter((line) => run.every((other) => localOf(other) !== localOf(line)));
  const defaults = typedOnly.filter((line) => line.binding.form === 'default');
  for (const line of defaults) {
    written.push(`import type ${localOf(line)} from ${from};`);
  }
  const typedNamespaces = typedOnly.filter((line) => line.binding.form === 'namespace');
  for (const line of typedNamespaces) {
    written.push(`import type * as ${localOf(line)} from ${from};`);
  }
  const named = typedOnly.filter((line) => line.binding.form === 'named');
  if (named.length > 0) {
    written.push(`import type ${clauseOf(named)} from ${from};`);
  }
  return written;
}

/** An import clause of `lines`, all of one module's default or named bindings: `a, { b, c as d }`. */
function clauseOf(lines: readonly ImportLine[]): string {
  const byDefault = lines.find(
    (line) => line.binding.form === 'default' && line.local === undefined,
  );
  const named = lines
    .filter(
      (line) =>
        line.binding.form === 'named' || (line.binding.form === 'default' && line !== byDefault),
    )
    .map((line) => {
      const { binding } = line;
      const exported =
        binding.form === 'default' ? 'default' : (binding.written ?? binding.exported);
      const local = localOf(line);
      return binding.written === undefined &&
        binding.form === 'named' &&
        local === binding.name.text
        ? local
        : `${exported} as ${local}`;
    });
  const parts = byDefault === undefined ? [] : [localOf(byDefault)];
  if (named.length > 0) {
    parts.push(`{ ${named.join(', ')} }`);
  }
  return parts.join(', ');
}
