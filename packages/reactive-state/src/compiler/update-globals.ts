import { isIdentifier, type Node } from 'typescript/ast';

import { freeReads } from './scope.ts';
import type { Registered } from './updaters.ts';

/** The shape of an alias an import is written under (`unusedName`): its name and `$2`, `$3`… */
const ALIAS = /\$\d+$/u;

/**
 * The names a program may not give an import: `taken` — which it declares or reads as a global in a
 * site's function — and, of its updates, which it writes as they are:
 *
 * - each name an update reads as a global — what it reads that is none of its own imports or
 *   captures — which an import of that name would take from it;
 * - each identifier an update holds that is shaped as an alias is (`name$2`, `name$3`…), whether it
 *   declares it, captures it, reads it or names a property by it, which the alias an import is
 *   written under would equal, and the update would read as its own. An update's import under its
 *   own name is the import's, and no alias.
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
    const imported = new Set(imports.map((binding) => binding.name.text));
    const own = new Set(imported);
    for (const capture of captures) {
      own.add(capture.name);
    }
    for (const read of freeReads(fn)) {
      if (!own.has(read.text)) {
        reserved.add(read.text);
      }
    }
    const visit = (node: Node): void => {
      if (isIdentifier(node) && ALIAS.test(node.text) && !imported.has(node.text)) {
        reserved.add(node.text);
      }
      node.forEachChild(visit);
    };
    visit(fn);
  }
  return reserved;
}
