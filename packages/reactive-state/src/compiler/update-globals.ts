import { freeReads } from './scope.ts';
import type { Registered } from './updaters.ts';

/**
 * The names a program may not give an import: `taken` — which it declares or reads as a global in a
 * site's function — and the names its updates read as globals, each what the update reads that is
 * none of its own imports or captures. The program writes each update as it is, so an import it
 * writes for another update, under one of these names, would take the global from the update that
 * reads it.
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
  }
  return reserved;
}
