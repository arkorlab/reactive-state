import path from 'node:path';

import { isTypeLiteralNode } from 'typescript/ast';

import { PROTOCOL_VERSION } from '../program.ts';
import type { Component } from './analyze.ts';
import { header } from './emit-authority.ts';
import {
  type HostOptions,
  type PrefetchLife,
  prefetchParts,
  REQUEST_SESSION,
} from './emit-host.ts';
import { operationCallableType } from './emit-operation-types.ts';
import { registryExports, registryImports, routingManifest } from './emit-routes.ts';
import type { SiteInput } from './frames.ts';
import type { HookModule } from './hooks.ts';
import { importDeclarations } from './imports.ts';
import type { ComponentManifest, Manifest } from './manifest.ts';
import type { OperationModule } from './operations.ts';
import { NO_ROUTING, type Routing } from './routes.ts';
import type { Ref, Sides } from './sides.ts';
import type { Site } from './sites.ts';
import { byCodeUnits, literal, specifierLiteral, unusedName } from './splice.ts';
import { typeNames } from './type-names.ts';
import type { Writes } from './updaters.ts';

/**
 * What a compile writes for the application as a whole, beside each component's programs: each
 * component's root entry, which a page reaches when it imports the component; the elements the host
 * renders the authority's tree with; the Server Functions a page writes a field with, and has a root
 * rendered again for the dynamic sites it shows with; a stub of each `'use server'` module; the
 * authority's registry of programs; the route a page follows its roots by; and the build's manifest.
 */

/** A component as the compile made it. */
export interface CompiledComponent {
  readonly component: Component;
  readonly sides: Sides;
  readonly writes: Writes;
  /** The updaters its program lists, by id, with the keys each writes. */
  readonly updaters: Writes['updaters'];
  readonly writable: readonly string[];
}

export interface AppInput {
  readonly components: readonly CompiledComponent[];
  readonly hooks: readonly HookModule[];
  readonly operations: readonly OperationModule[];
  /** The application's database: the module and the export the authority is given it by. */
  readonly database: { readonly specifier: string; readonly name: string };
  readonly buildId: string;
  /** What each module the components and the hooks import is to the compile, by specifier. */
  readonly classes: ReadonlyMap<string, string>;
  /** The routes the app directory registers, and its route middleware (`routes.ts`). */
  readonly routing?: Routing;
  /** What the host tells the compile beside the sources: the session source, the prefetch. */
  readonly host?: HostOptions | undefined;
}

const NEXT = '@arkorlab/reactive-state/next';

const APPLICATION = "the application's components";

/**
 * The specifier one output imports another by: a relative path, without its extension, as an import
 * writes it — in single quotes, or escaped where a name in the path asks for it.
 */
export function relativeSpecifier(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join('/');
  const named = relative.startsWith('.') ? relative : `./${relative}`;
  return specifierLiteral(named);
}

/** The specifier of an output of the file `id`, beside the module that imports it. */
function siblingSpecifier(id: string, suffix: string): string {
  return specifierLiteral(`./${id}${suffix}`);
}

/** A name for each key that no other key of the same kind takes: its segments joined by `$`. */
function localNames(keys: readonly string[], prefix: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const key of keys) {
    const segments = key.replaceAll('/', '$').replaceAll(/[^\w$]/gu, '_');
    const name = unusedName(`${prefix}$${segments}`, (each) => taken.has(each));
    taken.add(name);
    names.set(key, name);
  }
  return names;
}

/** An export's name as an import names it: as it is, or quoted where it is no identifier. */
function exportName(name: string): string {
  return /^[$A-Z_a-z][\w$]*$/u.test(name) ? name : literal(name);
}

/**
 * A component's root entry (`<id>.root.tsx`): what a page renders it as, through the authority. A
 * page renders a root with its JSON props alone: the props that hold nodes are none of its own —
 * those its parameter's type literal types as nodes, or, where its parameter names the type of its
 * props, which the compile does not read, those TypeScript types as nodes (`RootProps`).
 */
export function emitRoot(
  compiled: CompiledComponent,
  file: string,
  outDir: string,
  {
    prefetch,
    route,
  }: {
    /** The route the root is registered by, whose guards are run wherever it renders. */
    readonly route?: string | undefined;
    /** The private cache the root renders inside, for a link's prefetch to carry it, where it does. */
    readonly prefetch?: PrefetchLife | undefined;
  } = {},
): string {
  const { component } = compiled;
  const { parameter, propsType, sourceFile } = component;
  const types = typeNames(propsType);
  const lines = component.modules.flatMap((module) => {
    const typed = module.bindings.filter((binding) => types.has(binding.name.text));
    return typed.map((binding) => ({ binding, from: module.written, typeOnly: true }));
  });
  let signature = '()';
  let props = 'props: {}';
  const named = propsType !== undefined && !isTypeLiteralNode(propsType);
  if (parameter !== undefined) {
    const annotation = propsType?.getText(sourceFile) ?? 'Readonly<Record<string, unknown>>';
    const nodes = component.props.filter((prop) => prop.node).map((prop) => literal(prop.name));
    if (named) {
      const read = nodes.length === 0 ? '' : `, ${nodes.join(' | ')}`;
      signature = `(props: RootProps<${annotation}${read}>)`;
    } else {
      signature =
        nodes.length === 0
          ? `(props: ${annotation})`
          : `(props: Omit<${annotation}, ${nodes.join(' | ')}>)`;
    }
    props = 'props';
  }
  const elements = relativeSpecifier(file, path.join(outDir, 'elements'));
  const serverFunctions = relativeSpecifier(file, path.join(outDir, 'server-functions'));
  // The route a root is registered by, whose guards are run wherever it renders.
  const routed = route === undefined ? '' : `route: ${literal(route)}, `;
  const cached = prefetchParts(prefetch);
  return [
    header(`${component.id}.reactive.tsx`),
    ...cached.imports,
    named
      ? `import { renderRoot, type RootProps } from '${NEXT}';`
      : `import { renderRoot } from '${NEXT}';`,
    ...importDeclarations(lines),
    `import { elements } from ${elements};`,
    `import { update, view } from ${serverFunctions};`,
    '',
    `export default async function ${component.name}${signature} {`,
    ...cached.body,
    `  return renderRoot({ component: ${literal(component.id)}, elements, ${props}, ${routed}${cached.field}update, view });`,
    '}',
    '',
  ].join('\n');
}

/**
 * A key of a map the compile writes, as an object literal writes it: computed for `__proto__` — a
 * component's or a module's id may be one — which, written as it is, sets the object's prototype.
 */
function keyOf(key: string): string {
  return key === '__proto__' ? `[${literal(key)}]` : literal(key);
}

/** An object literal of `keys`, each the value its local name holds, one to a line. */
function entriesOf(keys: readonly string[], names: ReadonlyMap<string, string>): string {
  if (keys.length === 0) {
    return '{}';
  }
  const lines = keys.map((key) => `    ${keyOf(key)}: ${names.get(key) ?? ''},`);
  return ['{', ...lines, '  }'].join('\n');
}

/** The components the host renders by reference, by `<specifier>#<export>`. */
function moduleRefs(input: AppInput): ReadonlyMap<string, Ref> {
  const modules = new Map<string, Ref>();
  for (const { sides } of input.components) {
    for (const ref of sides.refs.modules.values()) {
      modules.set(`${ref.module}#${ref.name}`, ref);
    }
  }
  return modules;
}

/** The import of the component a module ref names, under `local`. */
function moduleImport(ref: Ref, local: string): string {
  return ref.name === 'default'
    ? `import ${local} from ${specifierLiteral(ref.module)};`
    : `import { ${exportName(ref.name)} as ${local} } from ${specifierLiteral(ref.module)};`;
}

/** The import of an operation module's stubs, each under its local name. */
function stubImport(operation: OperationModule, names: ReadonlyMap<string, string>): string {
  const named = operation.exports.map((name) => {
    const local = names.get(`${operation.id}#${name}`) ?? '';
    return `${exportName(name)} as ${local}`;
  });
  return named.length === 0
    ? ''
    : `import { ${named.join(', ')} } from ${siblingSpecifier(operation.id, '')};`;
}

/** The import map the host renders the authority's tree with (`elements.ts`). */
export function emitElements(input: AppInput): string {
  const modules = moduleRefs(input);
  const moduleKeys = [...modules.keys()].toSorted(byCodeUnits);
  const moduleNames = localNames(moduleKeys, 'module');
  const clients = input.components
    .filter(({ component }) => component.returned !== undefined)
    .map(({ component }) => component.id)
    .toSorted(byCodeUnits);
  const clientNames = localNames(clients, 'client');
  const actions = input.operations.flatMap((operation) =>
    operation.exports.map((name) => `${operation.id}#${name}`),
  );
  const actionNames = localNames(actions, 'action');
  const imports = [
    ...moduleKeys.flatMap((key) => {
      const ref = modules.get(key);
      return ref === undefined ? [] : [moduleImport(ref, moduleNames.get(key) ?? '')];
    }),
    ...clients.map(
      (id) => `import ${clientNames.get(id) ?? ''} from ${siblingSpecifier(id, '.client')};`,
    ),
    ...input.operations.map((operation) => stubImport(operation, actionNames)),
    ...(input.host?.session === undefined
      ? []
      : [`import { session as session$ } from './${REQUEST_SESSION}';`]),
  ].filter((line) => line !== '');
  return [
    header(APPLICATION, 'components'),
    `import type { Elements } from '${NEXT}';`,
    ...imports,
    '',
    'export const elements: Elements = {',
    `  build: ${literal(input.buildId)},`,
    `  modules: ${entriesOf(moduleKeys, moduleNames)},`,
    `  clients: ${entriesOf(clients, clientNames)},`,
    `  actions: ${entriesOf(actions, actionNames)},`,
    ...(input.host?.session === undefined ? [] : ['  session: session$,']),
    '};',
    '',
  ].join('\n');
}

/**
 * The Server Functions a page writes a field with, and has a root rendered again with for the
 * dynamic sites it shows (`server-functions.ts`).
 */
export function emitServerFunctions(sessions = false): string {
  return [
    header(APPLICATION, 'components'),
    "'use server';",
    '',
    `import { updateField, viewRoot, type ViewAnswer } from '${NEXT}';`,
    "import type { FieldReceipt, Result } from '@arkorlab/reactive-state/program';",
    "import { elements } from './elements';",
    '',
    '/** A write to a field a page holds: the authority checks the binding it names, and runs it. */',
    'export async function update(input: unknown): Promise<Result<FieldReceipt>> {',
    sessions ? '  return updateField(input, elements.session);' : '  return updateField(input);',
    '}',
    '',
    '/** A root rendered again for what a page shows of it: the inputs of each dynamic site it shows. */',
    'export async function view(input: unknown): Promise<Result<ViewAnswer>> {',
    '  return viewRoot(input, elements);',
    '}',
    '',
  ].join('\n');
}

/**
 * The stub of a `'use server'` module (`<module id>.ts`): each function, run by the authority, typed
 * as the module's own — its parameters, and what it answers — through an import of its types alone,
 * so that a page's `<form action={publish.bind(null, id)}>` is checked as the original would be.
 */
export function emitStub(
  operation: OperationModule,
  buildId: string,
  sessionFrom?: string,
): string {
  const source = unusedName(
    'source',
    (name) => name === 'operate' || operation.exports.includes(name),
  );
  // The application's session source, where it signs in itself, under a name no export takes.
  const session = unusedName(
    'session$',
    (name) => name === source || operation.exports.includes(name),
  );
  const by =
    sessionFrom === undefined
      ? literal(buildId)
      : `{ build: ${literal(buildId)}, session: ${session} }`;
  const mirrored = [...(operation.callables?.values() ?? [])].flatMap(
    (callable) => callable.written ?? [],
  );
  const result = unusedName('OperationResult$', (name) => {
    return (
      operation.exports.includes(name) ||
      mirrored.some((signature) => signature.head.includes(name) || signature.answer.includes(name))
    );
  });
  const needsOriginal = operation.exports.some(
    (name) => operation.callables?.get(name)?.written === undefined,
  );
  const functions = operation.exports.flatMap((name) => {
    const original = /^[$A-Z_a-z][\w$]*$/u.test(name)
      ? `typeof ${source}.${name}`
      : `(typeof ${source})[${literal(name)}]`;
    const callable = operation.callables?.get(name);
    if (callable !== undefined) {
      const call = `operate(${literal(operation.id)}, ${literal(name)}, args, ${by})`;
      return [
        '',
        `export const ${name} = (async (...args: unknown[]): Promise<unknown> => {`,
        `  return ${call};`,
        `}) as (${operationCallableType(original, callable, result)});`,
      ];
    }
    const answer = `Promise<Awaited<ReturnType<${original}>>>`;
    const signature = `(...args: Parameters<${original}>): ${answer}`;
    const head =
      name === 'default'
        ? `export default async function operation${signature} {`
        : `export async function ${name}${signature} {`;
    const call = `operate(${literal(operation.id)}, ${literal(name)}, args, ${by})`;
    return ['', head, `  return ${call} as ${answer};`, '}'];
  });
  return [
    header(operation.fileName, 'module'),
    "'use server';",
    '',
    `import { operate } from '${NEXT}';`,
    ...(sessionFrom === undefined ? [] : [`import { session as ${session} } from ${sessionFrom};`]),
    ...(needsOriginal ? [`import type * as ${source} from ${operation.written};`] : []),
    ...(mirrored.length === 0 ? [] : ['', `type ${result}<Value> = Promise<Awaited<Value>>;`]),
    ...functions,
    '',
  ].join('\n');
}

/** The authority's registry (`authority.mts`): every program, every operation module, the database. */
export function emitRegistry(input: AppInput): string {
  const programs = input.components.map(({ component }) => component.id).toSorted(byCodeUnits);
  const programNames = localNames(programs, 'program');
  const operationNames = localNames(
    input.operations.map((operation) => operation.id),
    'operations',
  );
  const { database } = input;
  const local = database.name === 'default' ? 'database$' : database.name;
  const databaseImport =
    database.name === 'default'
      ? `import database$ from ${specifierLiteral(database.specifier)};`
      : `import { ${database.name} } from ${specifierLiteral(database.specifier)};`;
  const operations = input.operations.map(
    (operation) => `${keyOf(operation.id)}: ${operationNames.get(operation.id) ?? ''}`,
  );
  return [
    header(APPLICATION, 'components'),
    ...programs.map(
      (id) =>
        `import * as ${programNames.get(id) ?? ''} from ${siblingSpecifier(id, '.authority.mts')};`,
    ),
    ...input.operations.map(
      (operation) =>
        `import * as ${operationNames.get(operation.id) ?? ''} from ${operation.written};`,
    ),
    databaseImport,
    ...registryImports(input.routing ?? NO_ROUTING),
    '',
    `export const buildId = ${literal(input.buildId)};`,
    `export const programs = [${programs.map((id) => programNames.get(id) ?? '').join(', ')}];`,
    operations.length === 0
      ? 'export const operations = {};'
      : `export const operations = { ${operations.join(', ')} };`,
    `export const database = ${local};`,
    ...(input.host?.session === undefined ? [] : ["export const sessions = 'asserted';"]),
    ...registryExports(input.routing ?? NO_ROUTING),
    '',
  ].join('\n');
}

/**
 * The route a page follows its roots by and signs in with, and a route middleware's route is
 * delivered at (`<app>/api/reactive-state/[...path]/route.ts`, at `file`): handed the host's
 * registry of the routes and their envelopes (`<out>/routes.ts`), and a handler for each method a
 * route handler may be asked with, as a delivered route is asked with any of them.
 */
export function emitRoute(file: string, outDir: string, sessions = false): string {
  const session = relativeSpecifier(file, path.join(outDir, REQUEST_SESSION));
  return [
    header(APPLICATION, 'components'),
    `import { routeHandlers } from '${NEXT}/route';`,
    '',
    `import { envelopes, routes } from ${relativeSpecifier(file, path.join(outDir, 'routes'))};`,
    ...(sessions ? [`import { session } from ${session};`] : []),
    '',
    sessions
      ? 'export const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } = routeHandlers({ envelopes, routes, session });'
      : 'export const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } = routeHandlers({ envelopes, routes });',
    '',
  ].join('\n');
}

/** What not to read more into a build than it is, said in every manifest. */
const LIMITATIONS: readonly string[] = [
  // A library's own files are no part of the build's id: the deployment versions them.
  'packages-outside-build-id',
  // A state a hook declares with a parameter as it is is evaluated by the authority at every call:
  // a field of the database where the parameter is typed `FieldRef<T>`, a value of the page's — a
  // local state, whose setter is React's — where it is typed as the value itself.
  'hook-state-parameters-from-the-server',
  // A reactive component the browser's JSX renders is hoisted into a slot, rendered at a dynamic
  // site of the local states it reads — once, or for each item of a keyed `.map()` — or refused.
  'reactive-children-in-slots-or-sites',
  // What a page sends a site is checked for the kind of JSON each state started as — a list's items
  // for their keys, and as JSON — not its type.
  'site-inputs-checked-by-json-kind',
];

/** The keys of the states a site reads. */
function keysOf(states: readonly SiteInput[]): string[] {
  return states.map((input) => input.key);
}

/** A site, as the manifest says it: the states the page sends for it, and those its guard reads. */
function siteEntry(site: Site): readonly [string, ComponentManifest['sites'][string]] {
  return [
    site.name,
    {
      guard: keysOf(site.guarded),
      inputs: keysOf(site.sent),
      ...(site.list !== undefined && { list: true }),
    },
  ];
}

function componentManifest(compiled: CompiledComponent): ComponentManifest {
  const { component, sides, updaters, writable } = compiled;
  return {
    client: component.returned !== undefined,
    name: component.name,
    nodes: component.props.filter((prop) => prop.node).map((prop) => prop.name),
    renders: [...new Set(sides.refs.components.values())].toSorted(byCodeUnits),
    sites: Object.fromEntries(sides.sites.map((site) => siteEntry(site))),
    slots: sides.slots.map((slot) => slot.name),
    source: `${component.id}.reactive.tsx`,
    states: sides.evaluated.map((state) => state.key),
    updaters: Object.fromEntries(
      [...updaters].map(([id, { keys, site }]) => [id, { keys: [...keys], kind: site.kind }]),
    ),
    writable,
  };
}

function hookEntry(module: HookModule): readonly [string, Manifest['hooks'][string]] {
  return [module.id, { hooks: [...module.hooks.keys()], source: module.fileName }];
}

function operationEntry(
  operation: OperationModule,
): readonly [string, Manifest['operations'][string]] {
  return [operation.id, { exports: operation.exports, source: operation.fileName }];
}

export function manifestOf(input: AppInput): Manifest {
  const components = input.components
    .map((compiled) => [compiled.component.id, componentManifest(compiled)] as const)
    .toSorted(([a], [b]) => byCodeUnits(a, b));
  const elements = input.components.flatMap(({ sides }) =>
    [...sides.refs.modules.values()].map((ref) => `${ref.module}#${ref.name}`),
  );
  return {
    buildId: input.buildId,
    components: Object.fromEntries(components),
    database: `${input.database.specifier}#${input.database.name}`,
    elements: [...new Set(elements)].toSorted(byCodeUnits),
    hooks: Object.fromEntries(input.hooks.map((module) => hookEntry(module))),
    limitations: LIMITATIONS,
    middleware: routingManifest(input.routing ?? NO_ROUTING).middleware,
    modules: Object.fromEntries([...input.classes].toSorted(([a], [b]) => byCodeUnits(a, b))),
    operations: Object.fromEntries(input.operations.map((operation) => operationEntry(operation))),
    protocol: PROTOCOL_VERSION,
    routes: routingManifest(input.routing ?? NO_ROUTING).routes,
  };
}
