import path from 'node:path';

import type { CompiledComponent } from './emit-app.ts';
import { ReactiveCompileError } from './errors.ts';
import type { HookModule } from './hooks.ts';
import type { ImportedModule } from './imports.ts';
import type { Modules } from './modules.ts';
import { operationCallables } from './operation-callables.ts';
import { type OperationModule, operationExports } from './operations.ts';
import { byCodeUnits, specifierLiteral } from './splice.ts';

/**
 * The `'use server'` modules the authority registers, each read once, by its file: each a component
 * or a hook imports, as its first importer writes it; then each whose file under the source
 * directory is named `*.operations.ts` (`OPERATIONS_SUFFIX`) though nothing imports it, by its path
 * from each output that imports it. A module both imported and so named is one, imported as its
 * importer writes it.
 */

/** Where the compile finds the modules of server operations. */
export interface OperationSources {
  readonly components: readonly CompiledComponent[];
  readonly hooks: readonly HookModule[];
  /** Each `*.operations.ts` under the source directory, by its path. */
  readonly named: readonly string[];
  /**
   * The source directory as the compile was given it — through a link, where it was — as the
   * outputs' directory is: what an output's path to a module nothing imports is measured in.
   */
  readonly srcDir: string;
}

/** What runs a step of the compile, keeping what it refuses: `undefined` where it refused. */
type Attempt = <T>(run: () => T) => T | undefined;

/** What the compile reads of an operation module, refused where it cannot list its operations. */
function operationsOf(
  file: string,
  modules: Modules,
  attempt: Attempt,
): Pick<OperationModule, 'callables' | 'exports' | 'fileName'> | undefined {
  const parsed = modules.parse(file, false);
  const described = attempt(() => {
    const exports = operationExports(parsed);
    const callables = operationCallables(parsed);
    return { callables, exports };
  });
  return described === undefined ? undefined : { ...described, fileName: parsed.name };
}

/** The specifier `from` imports `file` by: its path from `from`'s directory, with its extension. */
function pathSpecifier(from: string, file: string): string {
  const relative = path.relative(path.dirname(from), file).split(path.sep).join('/');
  return specifierLiteral(relative.startsWith('../') ? relative : `./${relative}`);
}

/** The refusal of `file`, named as a module of server operations though it is none. */
function misnamed(file: string, modules: Modules): ReactiveCompileError {
  return new ReactiveCompileError(
    `\`${path.basename(file)}\` is named as a module of server operations and does not open with \`'use server'\`: the authority registers a module of that name though nothing imports it, and runs only a \`'use server'\` module's exports. Open it with the directive, or name it otherwise.`,
    { fileName: modules.nameOf(file), position: { character: 0, line: 0 } },
  );
}

/** The modules of server operations the authority registers, in the order of their ids. */
export function operationModules(
  sources: OperationSources,
  modules: Modules,
  attempt: Attempt,
): readonly OperationModule[] {
  const found = new Map<string, OperationModule>();
  const imported: ImportedModule[] = [
    ...sources.components.flatMap(({ component }) => component.modules),
    ...sources.hooks.flatMap((module) => module.modules),
  ];
  for (const module of imported) {
    const { file, id, kind } = module.target;
    if (file === undefined || kind !== 'operations' || found.has(file)) {
      continue;
    }
    const described = operationsOf(file, modules, attempt);
    if (id !== undefined && described !== undefined) {
      found.set(file, { ...described, id, specifierFrom: () => module.written });
    }
  }
  const importedFiles = new Set(imported.map((module) => module.target.file));
  for (const file of sources.named) {
    // What it is, of its directive: read with what it imports, which the build's id hashes.
    const kind = modules.kindOf(file);
    if (kind !== 'operations') {
      attempt(() => {
        throw misnamed(file, modules);
      });
      continue;
    }
    if (importedFiles.has(file)) {
      continue;
    }
    const id = modules.idOf(file, kind);
    const described = operationsOf(file, modules, attempt);
    if (id !== undefined && described !== undefined) {
      const given = path.join(sources.srcDir, described.fileName);
      found.set(file, {
        ...described,
        id,
        specifierFrom: (output) => pathSpecifier(output, given),
      });
    }
  }
  return [...found.values()].toSorted((a, b) => byCodeUnits(a.id, b.id));
}
