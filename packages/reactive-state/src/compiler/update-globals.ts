import { type Identifier, isIdentifier, type Node, type Statement } from 'typescript/ast';

import type { Component } from './analyze.ts';
import type { Fail } from './errors.ts';
import { isJsx } from './jsx.ts';
import { freeReads } from './scope.ts';
import type { Sides } from './sides.ts';
import type { ApplySite, Registered } from './updaters.ts';

/** The shape of an alias an import is written under (`unusedName`): its name and `$2`, `$3`… */
const ALIAS = /\$\d+$/u;

/**
 * The globals that the text a program writes of its own reads at run time: `Object` of
 * `Object.freeze`, and the `undefined` that an optional chain of a site is written with. No import
 * may take either name, whatever reads it.
 */
const PROGRAM_READS: ReadonlySet<string> = new Set(['Object', 'undefined']);

/**
 * The names a program declares itself, or reads as a global in what it writes of its own — the
 * `PROGRAM_READS`, and `Readonly` and `Record` of the types it writes — which an import it writes
 * for an update may not take.
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
  'undefined',
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

/** The names `update` reads as globals: what it reads that is none of its own imports or captures. */
function globalsOf(update: ApplySite['update']): readonly string[] {
  const own = new Set(update.imports.map((binding) => binding.name.text));
  for (const capture of update.captures) {
    own.add(capture.name);
  }
  return freeReads(update.fn)
    .map((read) => read.text)
    .filter((name) => !own.has(name));
}

/**
 * Every name `update` holds, whatever it does with it — declares it as a parameter, a pattern, a
 * constant, a function or a `catch` binding, at any depth, captures it, reads it, or names a
 * property by it — and each name it captures.
 */
export function namesHeld(update: ApplySite['update']): ReadonlySet<string> {
  const held = new Set(update.captures.map((capture) => capture.name));
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      held.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(update.fn);
  return held;
}

/** The names `update` reads as globals, and the names it holds that an alias would equal. */
function reserveUpdate(update: ApplySite['update'], reserved: Set<string>): void {
  const imported = new Set(update.imports.map((binding) => binding.name.text));
  for (const name of globalsOf(update)) {
    reserved.add(name);
  }
  for (const name of namesHeld(update)) {
    if (ALIAS.test(name) && !imported.has(name)) {
      reserved.add(name);
    }
  }
}

/** Each name an update reads as a global, with the keys the updates that read it write. */
export function updateGlobals(
  updaters: ReadonlyMap<string, Registered>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const found = new Map<string, Set<string>>();
  for (const { keys, site } of updaters.values()) {
    if (site.kind !== 'apply') {
      continue;
    }
    for (const name of globalsOf(site.update)) {
      const written = found.get(name) ?? new Set<string>();
      for (const key of keys) {
        written.add(key);
      }
      found.set(name, written);
    }
  }
  return found;
}

/** Whether the server part holds JSX, which it renders with `$`. */
export function renders(statements: readonly Statement[]): boolean {
  let found = false;
  const visit = (node: Node): void => {
    found ||= isJsx(node);
    if (!found) {
      node.forEachChild(visit);
    }
  };
  for (const statement of statements) {
    visit(statement);
  }
  return found;
}

/** What the program's own text does with names an import might take, for `refuseShadowing`. */
export interface OwnText {
  /** Each name an update reads as a global, with the keys the updates that read it write. */
  readonly readers: ReadonlyMap<string, ReadonlySet<string>>;
  /** The parameters its function declares, where nothing of the component's holds the name. */
  readonly declared: ReadonlySet<string>;
}

/** The program's own text: what the updates read, and the parameters of `evaluate` it declares for itself. */
export function ownText(component: Component, updaters: ReadonlyMap<string, Registered>): OwnText {
  const declared = new Set<string>();
  if (component.parameter === undefined) {
    declared.add('_props');
  }
  if (component.returned === undefined && !renders(component.server)) {
    declared.add('_$');
  }
  return { declared, readers: updateGlobals(updaters) };
}

/**
 * Refuses a name the server part declares that `evaluate` declares as a parameter, where the
 * component holds neither: the server part is copied into `evaluate`, where a `const` of the name
 * would redeclare the parameter and the module would not parse.
 */
export function refuseRedeclared(component: Component, own: OwnText, fail: Fail): void {
  for (const [name, entry] of component.names) {
    if (entry.kind === 'server' && own.declared.has(name)) {
      const at = [...component.declaring].find((node) => isIdentifier(node) && node.text === name);
      fail(
        `\`${name}\` is declared by the server part, and the program for the authority declares a parameter of that name in the function it copies the server part into: the module would not parse. Declare it under another name.`,
        at,
      );
    }
  }
}

/**
 * Refuses an import the program writes under its own name — its server part reads it, or the
 * authority renders or binds it by reference — where an update, or the text the program writes of
 * its own, reads a global of that name, or declares a parameter of it: the import cannot be written
 * under another name, the code that reads it reads it as it is, and what reads the global, written
 * as it is, would read the import, or the code that reads the import would read the parameter.
 */
export function refuseShadowing(name: Identifier, own: OwnText, fail: Fail): void {
  const keys = own.readers.get(name.text);
  let because =
    keys === undefined
      ? undefined
      : `the update of \`${[...keys].join('`, `')}\` reads the global \`${name.text}\`: it would read the import`;
  if (PROGRAM_READS.has(name.text)) {
    because = `the program's own code reads the global \`${name.text}\`: it would read the import`;
  }
  if (own.declared.has(name.text)) {
    because = `its own function declares a parameter \`${name.text}\`: the code that reads the import would read the parameter`;
  }
  if (because !== undefined) {
    fail(
      `\`${name.text}\` is imported here, and the program for the authority writes it under its own name, where ${because}. Import it under another name.`,
      name,
    );
  }
}
