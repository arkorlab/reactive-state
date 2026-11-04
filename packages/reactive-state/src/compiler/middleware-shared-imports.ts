import type { ImportBinding } from './imports.ts';
import type { MiddlewareNames } from './middleware-reads.ts';
import { runtimeModuleSpecifiers } from './middleware-runtime-imports.ts';
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
      includeModule(imported, binding, modules);
    }
  }
  return imported;
}

/** Every reachable static runtime module retains the selected middleware binding for its diagnostic. */
function includeModule(
  imported: Map<string, ImportBinding>,
  binding: ImportBinding,
  modules: Modules,
): void {
  const pending = [{ file: binding.module.target.file, specifier: binding.module.specifier }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const identity = next.file ?? next.specifier;
    if (imported.has(identity)) continue;
    imported.set(identity, binding);
    const { file } = next;
    if (file === undefined) continue;
    const parsed = modules.parse(file, false);
    for (const specifier of runtimeModuleSpecifiers(parsed.sourceFile)) {
      pending.push({ file: modules.resolve(specifier, file), specifier });
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
