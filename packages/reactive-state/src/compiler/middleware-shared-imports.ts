import path from 'node:path';

import type { ImportBinding } from './imports.ts';
import type { MiddlewareNames } from './middleware-reads.ts';
import { COMPUTED_IMPORT, runtimeModuleSpecifiers } from './middleware-runtime-imports.ts';
import type { Modules } from './modules.ts';

/** Runtime imports whose module identity would be read in both extracted runtimes. */

/** A path below a `node_modules` directory, written with either separator. */
const NODE_MODULES = /[/\\]node_modules[/\\]/u;

interface RuntimePart {
  readonly values: ReadonlySet<string>;
}

interface SplitParts {
  readonly guard: RuntimePart | undefined;
  readonly before: RuntimePart | undefined;
  readonly after: RuntimePart | undefined;
}

/** What a walk of one part's modules holds: where it started, the modules, the files it has read. */
interface Reached {
  readonly importer: string;
  readonly modules: Modules;
  readonly walked: Set<string>;
}

/** Each selected runtime import, by its resolved local module or unresolved package specifier. */
function importedBy(
  part: RuntimePart | undefined,
  names: MiddlewareNames,
  modules: Modules,
): ReadonlyMap<string, ImportBinding> {
  const imported = new Map<string, ImportBinding>();
  if (part === undefined) return imported;
  const walked = new Set<string>();
  for (const name of part.values) {
    const binding = names.imports.get(name);
    if (binding !== undefined && !binding.typeOnly) {
      includeModule(imported, binding, { importer: names.sourceFile.fileName, modules, walked });
    }
  }
  return imported;
}

/** A module reached: its file, where it is the application's, the file that names it, and its specifier. */
interface Reaching {
  readonly file: string | undefined;
  readonly from: string;
  readonly specifier: string;
}

/**
 * What names a module: its file, where the application's own; and of a package's, or a built-in's,
 * the files its specifier resolves to — a package's `exports` may name one file by two specifiers,
 * `state` and `state/state` — and the specifier itself, `process` and `node:process` among them
 * (`Modules.identities`). One computed under a name stands for itself.
 */
function identitiesOf(next: Reaching, modules: Modules): readonly string[] {
  if (next.file !== undefined) return [next.file];
  return next.specifier === COMPUTED_IMPORT
    ? [next.specifier]
    : modules.identities(next.specifier, next.from, 'authority');
}

/**
 * The files whose imports are read where `next` is reached: its own, where it is the application's;
 * and of a `#` import of the application's package, which names the files of it that it resolves to,
 * as a package's `exports` names another's.
 */
function filesOf(next: Reaching, identities: readonly string[]): readonly string[] {
  if (next.file !== undefined) return [next.file];
  return next.specifier.startsWith('#')
    ? identities.filter((each) => path.isAbsolute(each) && !NODE_MODULES.test(each))
    : [];
}

/** What the file `file` loads: each module named by its imports, reached from it. */
function importsOf(file: string, modules: Modules): readonly Reaching[] {
  const { sourceFile } = modules.parse(file, false);
  return runtimeModuleSpecifiers(sourceFile).map((specifier) => {
    return {
      file: specifier === COMPUTED_IMPORT ? undefined : modules.resolve(specifier, file),
      from: file,
      specifier,
    };
  });
}

/**
 * Every reachable runtime module retains the selected middleware binding for its diagnostic. A
 * module is reached under each of its identities, and its imports are read once, `walked`, whichever
 * name reaches it first: a file a `#` import named is read when a path names it later too.
 */
function includeModule(
  imported: Map<string, ImportBinding>,
  binding: ImportBinding,
  { importer, modules, walked }: Reached,
): void {
  const pending: Reaching[] = [
    { file: binding.module.target.file, from: importer, specifier: binding.module.specifier },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const identities = identitiesOf(next, modules);
    for (const identity of identities) {
      if (!imported.has(identity)) imported.set(identity, binding);
    }
    for (const file of filesOf(next, identities)) {
      if (walked.has(file)) continue;
      walked.add(file);
      pending.push(...importsOf(file, modules));
    }
  }
}

/** A selected module cannot communicate its state between the authority guard and host envelope. */
export function checkSharedImports(
  parts: SplitParts,
  names: MiddlewareNames,
  modules: Modules,
): void {
  const guarded = importedBy(parts.guard, names, modules);
  if (guarded.size === 0) return;
  for (const part of [parts.before, parts.after]) {
    for (const [identity, binding] of importedBy(part, names, modules)) {
      if (guarded.has(identity)) {
        names.fail(
          `The runtime import \`${binding.name.text}\` is read by both the guard and the envelope: its module is evaluated separately in the authority and host, so imported state cannot carry what the guard changes into the envelope. Keep the import in one part alone.`,
          binding.name,
        );
      }
    }
  }
}
