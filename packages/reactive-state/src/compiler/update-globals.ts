import { declaredWithin, freeReads } from './scope.ts';
import type { Registered } from './updaters.ts';

/**
 * The names a program may not give an import: `taken` — which it declares or reads as a global in a
 * site's function — the names its updates read as globals, each what the update reads that is none
 * of its own imports or captures, and the names its updates declare, a parameter's, a local's, a
 * function's, at any depth. The program writes each update as it is, so an import it writes for
 * another update, under a name an update reads as a global, would take the global from that update,
 * and under a name an update declares, an alias would be taken by the local of the update that
 * reads the import.
 */
export function reservedNames(
  taken: ReadonlySet<string>,
  updaters: ReadonlyMap<string, Registered>,
): ReadonlySet<string> {
  const reserved = new Set(taken);
  for (const { site } of updaters.values()) {
    if (site.kind !== 'apply') {
      continue;
    }
    const { captures, fn, imports } = site.update;
    const own = new Set(imports.map((binding) => binding.name.text));
    for (const capture of captures) {
      own.add(capture.name);
    }
    for (const read of freeReads(fn)) {
      if (!own.has(read.text)) {
        reserved.add(read.text);
      }
    }
    for (const name of declaredWithin(fn)) {
      reserved.add(name);
    }
  }
  return reserved;
}
