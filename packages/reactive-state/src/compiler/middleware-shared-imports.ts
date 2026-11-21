import type { ImportBinding } from './imports.ts';
import type { MiddlewareNames } from './middleware-reads.ts';
import { COMPUTED_IMPORT, runtimeModuleSpecifiers } from './middleware-runtime-imports.ts';
import type { Modules } from './modules.ts';

/** Runtime imports whose module identity would be read in both extracted runtimes. */

interface RuntimePart {
  readonly values: ReadonlySet<string>;
}

interface SplitParts {
  readonly guard: RuntimePart | undefined;
  readonly before: RuntimePart | undefined;
  readonly after: RuntimePart | undefined;
}

/** Each selected runtime import, by its resolved local module or unresolved package specifier. */
function importedBy(
  part: RuntimePart | undefined,
  names: MiddlewareNames,
  modules: Modules,
): ReadonlyMap<string, ImportBinding> {
  const imported = new Map<string, ImportBinding>();
  if (part === undefined) return imported;
  for (const name of part.values) {
    const binding = names.imports.get(name);
    if (binding !== undefined && !binding.typeOnly) {
      includeModule(imported, binding, { importer: names.sourceFile.fileName, modules });
    }
  }
  return imported;
}

/**
 * What names a module: its file, where the application's own; and of a package's, or a built-in's,
 * the files its specifier resolves to — a package's `exports` may name one file by two specifiers,
 * `state` and `state/state` — and the specifier itself, `process` and `node:process` among them
 * (`Modules.identities`). One computed under a name stands for itself.
 */
function identitiesOf(
  next: { readonly file: string | undefined; readonly from: string; readonly specifier: string },
  modules: Modules,
): readonly string[] {
  if (next.file !== undefined) return [next.file];
  return next.specifier === COMPUTED_IMPORT
    ? [next.specifier]
    : modules.identities(next.specifier, next.from, 'authority');
}

/** Every reachable runtime module retains the selected middleware binding for its diagnostic. */
function includeModule(
  imported: Map<string, ImportBinding>,
  binding: ImportBinding,
  { importer, modules }: { readonly importer: string; readonly modules: Modules },
): void {
  const pending = [
    { file: binding.module.target.file, from: importer, specifier: binding.module.specifier },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const identities = identitiesOf(next, modules);
    if (identities.some((identity) => imported.has(identity))) continue;
    for (const identity of identities) imported.set(identity, binding);
    const { file } = next;
    if (file === undefined) continue;
    const parsed = modules.parse(file, false);
    for (const specifier of runtimeModuleSpecifiers(parsed.sourceFile)) {
      pending.push({
        file: specifier === COMPUTED_IMPORT ? undefined : modules.resolve(specifier, file),
        from: file,
        specifier,
      });
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
