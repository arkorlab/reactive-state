import {
  type CallExpression,
  type Identifier,
  isCallExpression,
  isIdentifier,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeLiteralNode,
  type Node,
  type SourceFile,
  type VariableStatement,
} from 'typescript/ast';

import { type Component, type HookCall, RESERVED } from './analyze.ts';
import { header } from './emit-authority.ts';
import type { SiteInput } from './frames.ts';
import type { HookDefinition } from './hooks.ts';
import { importDeclarations, type ImportLine } from './imports.ts';
import type { ModuleClass } from './modules.ts';
import { bindingIdentifiers } from './scope.ts';
import { reads, type Sides } from './sides.ts';
import type { Site } from './sites.ts';
import {
  indentAt,
  literal,
  propertyName,
  type Rewrite,
  splicedFrom,
  textOf,
  unusedName,
} from './splice.ts';
import type { StateDeclaration } from './statements.ts';
import { typeNames } from './type-names.ts';
import type { ApplySite, Writes } from './updaters.ts';

/**
 * A component's Client Component (`<id>.client.tsx`), for a component with state: its states, its
 * constants and its JSX as the component wrote them — and nothing of the server part — save that
 * each state the authority evaluates is given what the authority made of it
 * (`stateOf(part, "title")`), each reactive child is the slot the authority rendered it into
 * (`slotOf(part, "s0")`) or the dynamic site it renders at, shown for the inputs the browser holds
 * (`sites.of("d0", { filter })`) under the conditions as written, and each registered update names
 * its updater (`setEstimate.compiled("u_…", { step }, …)`).
 */

/** The module the browser's half of the framework is, which the Client Component imports. */
export const REACT = '@arkorlab/reactive-state/react';

export interface ClientInput {
  readonly component: Component;
  readonly sides: Sides;
  readonly writes: Writes;
  /** Where an output imports a module the compile writes a copy or a stub of, from this one; none for another. */
  readonly outputOf: (target: ModuleClass) => string | undefined;
}

export function emitClient(input: ClientInput): string {
  const { component, sides } = input;
  const { returned, sourceFile } = component;
  if (returned === undefined) {
    throw new Error(`${component.id} has no state, and so no Client Component.`);
  }
  const indent = indentAt(
    sourceFile.text,
    (component.states[0]?.statement ?? returned).getStart(sourceFile),
  );
  const read = component.props.filter((prop) => sides.browser.values.has(prop.local.text));
  const propsType = clientPropsType(
    component,
    read.map((prop) => prop.name),
  );
  const rewrite = clientRewrite(input);
  const runtime = [
    'type ClientPartProps',
    sides.evaluated.some((state) => state.local) ? 'localOf' : undefined,
    sides.slots.length > 0 ? 'slotOf' : undefined,
    sides.evaluated.some((state) => !state.local) ? 'stateOf' : undefined,
    component.states.some((state) => state.kind === 'state') ? 'useReactiveState' : undefined,
    sides.sites.length > 0 ? 'useSites' : undefined,
  ].filter((name) => name !== undefined);
  const name = component.id.split('/').at(-1) ?? component.id;
  return [
    header(`${component.id}.reactive.tsx`),
    "'use client';",
    '',
    `import { ${runtime.join(', ')} } from '${REACT}';`,
    ...importDeclarations(importsOf(input, propsType.names)),
    ...(sides.evaluated.length > 0
      ? [`import type { States } from './${name}.authority.mts';`]
      : []),
    '',
    `export default function ${component.name}({ part }: ClientPartProps) {`,
    ...(read.length === 0
      ? []
      : [
          `${indent}const { ${read.map((prop) => named(prop.name, prop.local.text)).join(', ')} } = part.props as ${propsType.text};`,
        ]),
    ...component.states.map((state) => stateLine(state, input)),
    ...(sides.sites.length === 0 ? [] : [`${indent}const sites = useSites(part);`]),
    ...component.constants
      .filter((statement) => !sides.dropped.has(statement))
      .flatMap((statement) => constantLines(statement, input, rewrite)),
    splicedFrom(returned, returned.pos, sourceFile, rewrite).replace(/^\n(?=\n)/u, ''),
    '}',
    '',
  ].join('\n');
}

/** Eager-only values are read after initialization so generated locals remain used. */
function constantLines(
  statement: VariableStatement,
  { component, sides }: ClientInput,
  rewrite: Rewrite,
): readonly string[] {
  const { sourceFile } = component;
  const indent = indentAt(sourceFile.text, statement.getStart(sourceFile));
  const unused = statement.declarationList.declarations
    .flatMap((declaration) => bindingIdentifiers(declaration.name))
    .filter((name) => !reads(sides.browser, name.text));
  return [
    splicedFrom(statement, statement.pos, sourceFile, rewrite).replace(/^\n+/u, ''),
    ...unused.map((name) => `${indent}void ${textOf(name, sourceFile, rewrite)};`),
  ];
}

/** The imports the Client Component writes of the component's: what its code reads, and the types it names. */
function importsOf(input: ClientInput, propTypes: ReadonlySet<string>): readonly ImportLine[] {
  const { component, sides } = input;
  const lines: ImportLine[] = [];
  for (const module of component.modules) {
    const output = input.outputOf(module.target);
    for (const binding of module.bindings) {
      const name = binding.name.text;
      if (sides.browser.values.has(name) && !binding.typeOnly) {
        lines.push({ binding, from: output ?? module.written, typeOnly: false });
      } else if (sides.browser.types.has(name) || propTypes.has(name)) {
        const typed = module.target.kind === 'hooks' ? output : undefined;
        lines.push({ binding, from: typed ?? module.written, typeOnly: true });
      }
    }
  }
  return lines;
}

/**
 * The type of the props the Client Component reads, as the component types them: of a type literal,
 * the members it reads, read-only; of a named type, those of its properties.
 */
function clientPropsType(
  component: Component,
  names: readonly string[],
): { readonly text: string; readonly names: ReadonlySet<string> } {
  const { propsType, sourceFile } = component;
  if (propsType === undefined) {
    return { names: new Set(), text: 'Readonly<Record<string, unknown>>' };
  }
  if (!isTypeLiteralNode(propsType)) {
    const text = propsType.getText(sourceFile);
    return {
      names: typeNames(propsType),
      text: `Readonly<Pick<${text}, ${names.map((name) => literal(name)).join(' | ')}>>`,
    };
  }
  const members = propsType.members.filter((member) => {
    return (
      isPropertySignatureDeclaration(member) &&
      (isIdentifier(member.name) || isStringLiteral(member.name)) &&
      names.includes(member.name.text)
    );
  });
  const used = new Set<string>();
  for (const member of members) {
    for (const each of typeNames(member)) {
      used.add(each);
    }
  }
  const text = members.map((member) => {
    const written = member.getText(sourceFile).replace(/[,;]$/u, '');
    return written.startsWith('readonly ') ? written : `readonly ${written}`;
  });
  return { names: used, text: `{ ${text.join('; ')} }` };
}

/** A property destructured under a name: `id`, or `id: todoId`. */
function named(property: string, name: string): string {
  return property === name ? property : `${propertyName(property)}: ${name}`;
}

/**
 * What the Client Component gives `useReactiveState` of a state the authority started: a local
 * one's value (`localOf`), whose setter is React's own, or what may bind a field (`stateOf`).
 */
function inputOf(state: { readonly key: string; readonly local: boolean }): string {
  const key = literal(state.key);
  return `${state.local ? 'localOf' : 'stateOf'}<States[${key}]>(part, ${key})`;
}

/** The line a state is declared with in the Client Component. */
function stateLine(state: HookCall | StateDeclaration, input: ClientInput): string {
  const { component, sides } = input;
  const { sourceFile } = component;
  const indent = indentAt(sourceFile.text, state.statement.getStart(sourceFile));
  const browser = (identifier: Identifier | undefined): string =>
    identifier !== undefined && reads(sides.browser, identifier.text) ? identifier.text : '';
  if (state.kind === 'state') {
    const evaluated = sides.evaluated.find((each) => each.state === state);
    const call =
      evaluated === undefined
        ? textOf(state.call, sourceFile, clientRewrite(input))
        : `useReactiveState(${inputOf(evaluated)})`;
    const value = browser(state.value);
    const setter = browser(state.setter);
    const names = setter === '' ? value : `${value}, ${setter}`;
    return names === '' ? `${indent}${call};` : `${indent}const [${names}] = ${call};`;
  }
  const injected = injectedNames(component, sides);
  const args = state.call.arguments.map((argument, index) => {
    const fed = state.hook.feeds.get(index);
    if (fed === undefined) {
      return textOf(argument, sourceFile, clientRewrite(input));
    }
    const key = `${state.prefix}${fed}`;
    const evaluated = sides.evaluated.find((each) => each.key === key);
    return inputOf({ key, local: evaluated?.local ?? false });
  });
  const typeArguments =
    state.call.typeArguments === undefined
      ? ''
      : `<${state.call.typeArguments.map((type) => type.getText(sourceFile)).join(', ')}>`;
  const call = `${state.callee.text}${typeArguments}(${args.join(', ')})`;
  const pattern = hookPattern(state, { browser, injected });
  return pattern === '' ? `${indent}${call};` : `${indent}const ${pattern} = ${call};`;
}

/**
 * The names the Client Component binds of items of hooks' calls that hold a state a site is sent
 * the value of, and that the component binds no name of: by the call's prefix, then by the item.
 */
type Injected = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** What a hook's call binds, as the Client Component reads it. */
interface Binding {
  /** The name it reads, or none. */
  readonly browser: (identifier: Identifier | undefined) => string;
  readonly injected: Injected;
}

/** What a hook's call binds, as the Client Component reads it: the names it reads, and no other. */
function hookPattern(state: HookCall, { browser, injected }: Binding): string {
  const { binding } = state;
  if (binding.kind === 'whole') {
    return browser(binding.name);
  }
  const names = new Map<string, string>();
  for (const [item, name] of binding.names) {
    if (browser(name) !== '') {
      names.set(item, binding.object ? named(item, name.text) : name.text);
    }
  }
  const items = injected.get(state.prefix) ?? new Map<string, string>();
  for (const [item, name] of items) {
    if (!names.has(item)) {
      names.set(item, binding.object ? named(item, name) : name);
    }
  }
  return patternOf(names, binding.object);
}

/** A pattern that binds `names`, each by its item: an object's, or an array's by index. */
function patternOf(names: ReadonlyMap<string, string>, object: boolean): string {
  if (names.size === 0) {
    return '';
  }
  if (object) {
    return `{ ${[...names.values()].join(', ')} }`;
  }
  const last = Math.max(...[...names.keys()].map(Number));
  const slots = Array.from({ length: last + 1 }, (_, index) => names.get(String(index)) ?? '');
  return `[${slots.join(', ')}]`;
}

/**
 * The names the Client Component binds of items of hooks' calls that hold a state a site is sent
 * the value of, and that the component binds no name of: each one no name in its file spells, and
 * none the outputs read within it.
 */
function injectedNames(component: Component, sides: Sides): Injected {
  const injected = new Map<string, Map<string, string>>();
  const taken = spelledIn(component.sourceFile, new Set([...component.declared, ...RESERVED]));
  const inputs = sides.sites.flatMap((site) => site.sent);
  for (const { browser } of inputs) {
    if (browser.kind !== 'item') {
      continue;
    }
    let items = injected.get(browser.call.prefix);
    if (items === undefined) {
      items = new Map();
      injected.set(browser.call.prefix, items);
    }
    if (!items.has(browser.item)) {
      const name = unusedName(itemName(browser.call.hook, browser.item), (each) => taken.has(each));
      taken.add(name);
      items.set(browser.item, name);
    }
  }
  return injected;
}

/**
 * What the item `item` of `hook` is bound by, unless the file spells it: its own name, or, of an
 * array the hook returns, the name of the state it holds — `filter` of `[setFilter, filter]` —
 * else `item` and its index; never the index, which no pattern binds, nor a key no binding is
 * named by — `'my-filter'`, `default` — bound as `item` (`'my-filter': item`).
 */
function itemName(hook: HookDefinition, item: string): string {
  if (!/^\d+$/u.test(item)) {
    return isBindable(item) ? item : 'item';
  }
  const state = hook.items.get(item)?.value?.split('.').at(-1);
  return state !== undefined && isBindable(state) ? state : `item${item}`;
}

/**
 * The words the language keeps for itself, which no binding is named — `default` of a hook's
 * `{ default: filter }` binds by `default: item`.
 */
const KEPT_WORDS: ReadonlySet<string> = new Set(
  [
    'arguments await break case catch class const continue debugger default delete do else enum',
    'eval export extends false finally for function if implements import in instanceof interface',
    'let new null package private protected public return static super switch this throw true try',
    'typeof var void while with yield',
  ]
    .join(' ')
    .split(' '),
);

/** Whether `text` may name a binding: an identifier, none of the words the language keeps. */
function isBindable(text: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(text) && !KEPT_WORDS.has(text);
}

/** `names`, and each name `node`'s code spells — declared, read, or a property's. */
function spelledIn(node: Node, names: Set<string>): Set<string> {
  if (isIdentifier(node)) {
    names.add(node.text);
  }
  node.forEachChild((child) => {
    spelledIn(child, names);
  });
  return names;
}

/**
 * What a site is shown with: the states it is rendered of, `{ filter }`, and those the conditions it
 * stands under alone read, `{ showDetails }`, where there are any — sent beside them for the
 * authority to check the conditions with, though what the site shows is the same for any of them.
 * Each by its key, the value the Client Component holds of it.
 */
function siteValues(site: Site, injected: Injected): readonly string[] {
  const guarded = site.sent.filter((each) => site.inputs.every((input) => input.key !== each.key));
  const own = objectOf(site.inputs, injected);
  return guarded.length === 0 ? [own] : [own, objectOf(guarded, injected)];
}

/** An object literal of the values `inputs` hold, each by its key: `{ filter }`. */
function objectOf(inputs: readonly SiteInput[], injected: Injected): string {
  if (inputs.length === 0) {
    return '{}';
  }
  const entries = inputs.map((input) => {
    const { browser } = input;
    const value =
      browser.kind === 'name'
        ? browser.name.text
        : (injected.get(browser.call.prefix)?.get(browser.item) ?? '');
    return value === input.key ? value : `${literal(input.key)}: ${value}`;
  });
  return `{ ${entries.join(', ')} }`;
}

/**
 * The rewrite of the browser's code: each slot and each site as what the authority rendered there,
 * each update registered.
 */
function clientRewrite(input: ClientInput): Rewrite {
  const { component, sides, writes } = input;
  const { sourceFile } = component;
  const injected = injectedNames(component, sides);
  const rewrite: Rewrite = (node: Node) => {
    const slot = sides.slots.find((each) => each.unit === node);
    if (slot !== undefined) {
      const shown = `slotOf(part, ${literal(slot.name)})`;
      return slot.child ? `{${shown}}` : shown;
    }
    const dynamic = sides.sites.find((each) => each.element === node);
    if (dynamic !== undefined) {
      const [own = '{}', ...guarded] = siteValues(dynamic, injected);
      const { list } = dynamic;
      const entry =
        list === undefined
          ? []
          : [`{ item: ${list.item.text}, key: ${textOf(list.key, sourceFile, rewrite)} }`];
      const shown = `sites.${list === undefined ? 'of' : 'item'}(${[literal(dynamic.name), own, ...entry, ...guarded].join(', ')})`;
      return dynamic.child ? `{${shown}}` : shown;
    }
    const site = isCallExpression(node) ? writes.calls.get(node) : undefined;
    return site === undefined || !isCallExpression(node)
      ? undefined
      : compiledCall(node, site, { rewrite, sourceFile });
  };
  return rewrite;
}

/** `setEstimate(current => …)` as the browser runs it: `setEstimate.compiled("u_…", { step }, current => …)`. */
export function compiledCall(
  call: CallExpression,
  site: ApplySite,
  context: { readonly rewrite: Rewrite; readonly sourceFile: SourceFile },
): string {
  const { rewrite, sourceFile } = context;
  const [argument] = call.arguments;
  const captures = site.update.captures.map((capture) => capture.name);
  const captured = captures.length === 0 ? '{}' : `{ ${captures.join(', ')} }`;
  const predicted = argument === undefined ? '' : textOf(argument, sourceFile, rewrite);
  return `${textOf(call.expression, sourceFile, rewrite)}.compiled(${literal(site.id)}, ${captured}, ${predicted})`;
}
