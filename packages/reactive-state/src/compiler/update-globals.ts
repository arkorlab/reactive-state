import { isIdentifier, type Node } from 'typescript/ast';

import type { Component } from './analyze.ts';
import { freeReads } from './scope.ts';
import type { Sides } from './sides.ts';
import type { ApplySite, Registered } from './updaters.ts';

/** The shape of an alias an import is written under (`unusedName`): its name and `$2`, `$3`… */
const ALIAS = /\$\d+$/u;

/**
 * The names a program declares itself, or reads as a global in what it writes of its own — `Object`
 * of `Object.freeze`, `Readonly` and `Record` of the types it writes — which an import it writes for
 * an update may not take.
 */
export const OWN_NAMES: ReadonlySet<string> = new Set([
  '_$',
  '_props',
  'actionRef',
  'buildId',
  'component',
  'componentRef',
  'evaluate',
  'moduleRef',
  'Object',
  'ProgramUpdater',
  'protocolVersion',
  'Readonly',
  'Record',
  'RenderScope',
  'States',
  'StatesOf',
  'updaters',
  'writable',
]);

/**
 * The names a program may not give an import: what it declares or reads as a global in a site's
 * function (`derive.ts`) and, of the code it writes as it is, which an import of the name would take
 * from the code that reads the global:
 *
 * - each name the server part, a state's initializer or a slot reads that nothing it binds is — the
 *   component's own names bind the rest — a global;
 * - each name an update reads as a global — what it reads that is none of its own imports or
 *   captures;
 * - each identifier an update holds that is shaped as an alias is (`name$2`, `name$3`…), whether it
 *   declares it, captures it, reads it or names a property by it, which the alias an import is
 *   written under would equal, and the update would read as its own. An update's import under its
 *   own name is the import's, and no alias.
 */
export function reservedNames(
  component: Component,
  sides: Sides,
  updaters: ReadonlyMap<string, Registered>,
): ReadonlySet<string> {
  const reserved = new Set(sides.derivation.taken);
  const body: Node[] = [...component.server];
  for (const state of sides.evaluated) {
    body.push(state.input);
  }
  for (const slot of sides.slots) {
    body.push(slot.unit);
  }
  for (const node of body) {
    for (const read of freeReads(node)) {
      if (!component.names.has(read.text)) {
        reserved.add(read.text);
      }
    }
  }
  for (const { site } of updaters.values()) {
    if (site.kind === 'apply') {
      reserveUpdate(site.update, reserved);
    }
  }
  return reserved;
}

/** The names `update` reads as globals, and the identifiers it holds that an alias would equal. */
function reserveUpdate(update: ApplySite['update'], reserved: Set<string>): void {
  const { captures, fn, imports } = update;
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
