import {
  type Identifier,
  isFunctionTypeNode,
  isPropertySignatureDeclaration,
  isTypeLiteralNode,
} from 'typescript/ast';

import { analyzeComponent, type Component, type TopLevel } from './analyze.ts';
import type { CompiledComponent } from './emit-app.ts';
import { failIn } from './errors.ts';
import { type Held, heldThroughHooks } from './hook-items.ts';
import type { HookModules } from './hooks.ts';
import type { Modules } from './modules.ts';
import { resolveSides, type Sides } from './sides.ts';
import { literal } from './splice.ts';
import { functionOf } from './statements.ts';
import { constantType, propType, startedType, type TypeScope } from './types.ts';
import { collectWrites, type Owner, updaterId } from './updaters.ts';

/**
 * One component, compiled: read, its sides told apart, and what its setters write registered —
 * with the hooks it calls, which are read once for every component that calls them.
 */

export interface ComponentContext {
  readonly modules: Modules;
  readonly hooks: HookModules;
}

export function compileComponent(file: string, context: ComponentContext): CompiledComponent {
  const { hooks, modules } = context;
  const parsed = modules.parse(file, true);
  const fail = failIn(parsed.sourceFile, parsed.name);
  const id =
    modules.idOf(file, 'component') ?? fail("A component is in the compile's source directory.");
  const component = analyzeComponent({
    classify: (specifier) => modules.targetOf(specifier, file),
    fail,
    fileName: parsed.name,
    hookOf: (binding) => hooks.hookOf(binding),
    id,
    sourceFile: parsed.sourceFile,
  });
  const sides = resolveSides({ component, file, modules });
  checkKeys(sides, component);
  const writes = collectWrites(ownerOf(component, sides));
  const written = new Set(
    [...writes.updaters.values()].flatMap((registered) => [...registered.keys]),
  );
  const writable = sides.evaluated.map((state) => state.key).filter((key) => written.has(key));
  return { component, sides, updaters: writes.updaters, writable, writes };
}

/** Refuses two states of one key: two hooks of one name, called by one component. */
function checkKeys(sides: Sides, component: Component): void {
  const seen = new Set<string>();
  for (const state of sides.evaluated) {
    if (seen.has(state.key)) {
      component.fail(
        `Two states of the component are keyed \`${state.key}\`: each hook a component calls is named by a name of its own.`,
        state.state.statement,
      );
    }
    seen.add(state.key);
  }
}

/**
 * The component's browser part, as what its setters write is read from it: the setters of the states
 * the authority starts. A local state's setter is React's, which the page alone applies, whatever it
 * is called with, and registers nothing; it is called from a handler alone all the same.
 */
function ownerOf(component: Component, sides: Sides): Owner {
  const evaluated = new Set(sides.evaluated.map((state) => state.key));
  const local = new Set(sides.evaluated.filter((state) => state.local).map((state) => state.key));
  const held = heldThroughHooks(component.states);
  for (const state of component.states) {
    if (state.kind !== 'state' || state.setter === undefined) {
      continue;
    }
    const key = state.value.text;
    // A state the browser starts, which no site reads, is local too: its setter registers nothing.
    const started = sides.local.has(state);
    if (started || evaluated.has(key)) {
      const set = updaterId(component.id, key, 'set');
      const setter = { key, set, site: key, type: undefined };
      held.setters.set(
        state.setter.text,
        started || local.has(key) ? { ...setter, local: true } : setter,
      );
    }
  }
  const typing: Typing = {
    component,
    evaluated,
    scope: { names: component.names, sourceFile: component.sourceFile },
  };
  return {
    captureType: (identifier) => {
      return (
        captureType(identifier, typing) ??
        component.fail(
          `\`${identifier.text}\` is captured by an update, which the authority types by the value's type: annotate it with one of the component's own imports or of the language's — \`const step: number = …\`.`,
          identifier,
        )
      );
    },
    declaration: component.declaration,
    declared: component.declared,
    declaring: component.declaring,
    fail: component.fail,
    holdsFunction: (identifier) => holdsFunction(identifier, component, held),
    id: component.id,
    items: new Map(),
    names: component.names,
    reads: sides.browser.values,
    setters: held.setters,
    sites: held.sites,
    sourceFile: component.sourceFile,
    writing: held.writing,
  };
}

interface Typing {
  readonly component: Component;
  readonly evaluated: ReadonlySet<string>;
  readonly scope: TypeScope;
}

/** The type of a value of the component's an update captures, as the authority's program writes it. */
function captureType(identifier: Identifier, typing: Typing): string | undefined {
  const { component, evaluated, scope } = typing;
  const entry: TopLevel | undefined = component.names.get(identifier.text);
  if (entry?.kind === 'prop') {
    return propType(component.propsType, entry.prop.name, scope);
  }
  if (entry?.kind === 'state') {
    const key = entry.state.value.text;
    return evaluated.has(key) ? `States[${literal(key)}]` : startedType(entry.state, scope);
  }
  if (entry?.kind === 'hooked') {
    const value = entry.call.hook.items.get(entry.item)?.value;
    const key = value === undefined ? undefined : `${entry.call.prefix}${value}`;
    return key !== undefined && evaluated.has(key) ? `States[${literal(key)}]` : undefined;
  }
  return entry?.kind === 'constant' ? constantType(entry.declaration, scope) : undefined;
}

/** Whether a name of the component's holds a function, which an update captures none of. */
function holdsFunction(identifier: Identifier, component: Component, held: Held): boolean {
  if (held.setters.has(identifier.text) || held.writing.has(identifier.text)) {
    return true;
  }
  const entry = component.names.get(identifier.text);
  if (entry?.kind === 'constant') {
    return functionOf(entry.declaration) !== undefined;
  }
  const { propsType, sourceFile } = component;
  if (propsType !== undefined && entry?.kind === 'prop' && isTypeLiteralNode(propsType)) {
    const member = propsType.members.find(
      (each) =>
        isPropertySignatureDeclaration(each) && each.name.getText(sourceFile) === entry.prop.name,
    );
    return (
      member !== undefined &&
      isPropertySignatureDeclaration(member) &&
      isFunctionTypeNode(member.type)
    );
  }
  return entry?.kind === 'setter';
}
