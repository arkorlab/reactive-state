import path from 'node:path';

import {
  type FunctionDeclaration,
  type Identifier,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isReturnStatement,
  type Node,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import {
  constantNames,
  type HookCall,
  named,
  type Named,
  type OwnedState,
  stateNames,
  type TopLevel,
} from './analyze.ts';
import { type Fail, failIn } from './errors.ts';
import { checkModuleStatement, declaredAtTop, exportsOf } from './hook-exports.ts';
import { hookSides, type HookSides } from './hook-sides.ts';
import { type ImportBinding, type ImportedModule, readImports } from './imports.ts';
import type { ModuleClass, Modules, ParsedModule } from './modules.ts';
import { byCodeUnits } from './splice.ts';
import { constantOf, type HookCallStatement, stateStatementOf } from './statements.ts';
import type { Setter, Uses, UpdaterSite, Writes } from './updaters.ts';

/**
 * A module of custom hooks: synchronous functions named `use…` that declare state, as a component
 * does after its server part — `useReactiveState`, or another custom hook — and return what their
 * callers read. A hook runs in the browser, so the compile writes a copy of its module that does,
 * each update its setters are given registered (`hooks/…`); its callers have the authority evaluate
 * a state the hook declares with a parameter as it is — `useReactiveState(ref)` — from the argument
 * they give it, and give the hook what the authority made of it in its place.
 */

/** What one item of what a hook returns is to its callers. */
export interface Item {
  readonly node: Node;
  /** The key, in the hook, of the state whose value it is, where the authority may hold it. */
  readonly value: string | undefined;
  /** The setter it is, of a state the authority may hold. */
  readonly setter: Setter | undefined;
  /** What calling it writes. */
  readonly uses: Uses;
}

/** A state a hook declares with a parameter as it is, which its caller has the authority evaluate. */
export interface Fed {
  /** The parameter, by its index. */
  readonly index: number;
  /** The type of the state's value, as the authority's program writes it; none where it is the caller's to say. */
  readonly type: string | undefined;
  /**
   * Whether the state may bind a field of the database: its parameter is typed `FieldRef<T>`, and
   * its setter writes through the updates the hook registers. Any other parameter declares a local
   * state, of a value of the page's its callers give it, whose setter is React's.
   */
  readonly persistent: boolean;
}

export interface HookDefinition {
  readonly module: HookModule;
  /** Its name, which keys its states in its callers: `useEstimate#0.estimate`. */
  readonly name: string;
  /** Whose updates it registers: its module's id and its name. */
  readonly owner: string;
  readonly declaration: FunctionDeclaration;
  /** For each parameter a state is declared with as it is, by its index: the state's key in the hook. */
  readonly feeds: ReadonlyMap<number, string>;
  /** Those states, by key. */
  readonly fed: ReadonlyMap<string, Fed>;
  /** What it returns, item by item: `0`, `1`… of an array, a property's name, or `whole`. */
  readonly items: ReadonlyMap<string, Item>;
  /** Its updaters, by id, with the keys in the hook each writes. */
  readonly writes: Writes;
  /** Every updater it, and each hook it calls, registers, by id. */
  readonly sites: ReadonlyMap<string, UpdaterSite>;
  readonly states: readonly OwnedState[];
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly sides: HookSides;
}

export interface HookModule {
  readonly id: string;
  readonly file: string;
  /** How what is refused names it. */
  readonly fileName: string;
  readonly sourceFile: SourceFile;
  readonly modules: readonly ImportedModule[];
  readonly intrinsic: Identifier | undefined;
  /** Its statements other than its imports, which its copy holds. */
  readonly statements: readonly Statement[];
  /** Its custom hooks that declare state, by the name each is exported under. */
  readonly hooks: ReadonlyMap<string, HookDefinition>;
  /** Every custom hook it declares that declares state, exported or not, by its own name. */
  readonly definitions: ReadonlyMap<string, HookDefinition>;
  readonly fail: Fail;
}

/** The pattern of a hook's name. */
const HOOK_NAME = /^use[A-Z\d]/u;

/** What the hook modules of a compile are read with. */
export interface HookReading {
  readonly modules: Modules;
  /** The module of hooks `binding` imports, read; none where it is no module of hooks. */
  readonly moduleOf: (target: ModuleClass) => HookModule | undefined;
}

/** The hooks a module of hooks exports, analyzed as they are asked for: a hook may call another. */
export class HookModules {
  readonly #reading: Omit<HookReading, 'moduleOf'>;
  readonly #modules = new Map<string, HookModule>();
  readonly #analyzing = new Set<string>();

  constructor(modules: Modules) {
    this.#reading = { modules };
  }

  /** Every module of hooks read so far, by its id. */
  all(): readonly HookModule[] {
    return [...this.#modules.values()].toSorted((a, b) => byCodeUnits(a.id, b.id));
  }

  /** The hook an import names, where it names one that declares state. */
  hookOf(binding: ImportBinding): HookDefinition | undefined {
    const { target } = binding.module;
    if (target.kind !== 'hooks' || binding.form === 'namespace' || binding.typeOnly) {
      return undefined;
    }
    return this.moduleOf(target)?.hooks.get(binding.exported);
  }

  /** The module of hooks `target` is, read and analyzed. */
  moduleOf(target: ModuleClass): HookModule | undefined {
    const { file, id } = target;
    if (file === undefined || target.kind !== 'hooks') {
      return undefined;
    }
    const known = this.#modules.get(file);
    if (known !== undefined) {
      return known;
    }
    const parsed = this.#reading.modules.parse(file, true);
    const fail = failIn(parsed.sourceFile, parsed.name);
    if (id === undefined) {
      return fail(
        "A module of custom hooks is the compile's to copy, so it is in its source directory.",
      );
    }
    if (this.#analyzing.has(file)) {
      return fail(
        'Modules of custom hooks import each other in a cycle, which the compile cannot copy one at a time.',
      );
    }
    this.#analyzing.add(file);
    try {
      const module = readHookModule(parsed, {
        fail,
        hooks: this,
        id,
        modules: this.#reading.modules,
      });
      this.#modules.set(file, module);
      return module;
    } finally {
      // A module refused is read again by the next component that imports it, and refused for what
      // it is, not for a cycle.
      this.#analyzing.delete(file);
    }
  }
}

interface ModuleReading {
  readonly id: string;
  readonly fail: Fail;
  readonly modules: Modules;
  readonly hooks: HookModules;
}

function readHookModule(parsed: ParsedModule, reading: ModuleReading): HookModule {
  const { fail } = reading;
  const { sourceFile } = parsed;
  if (!['.ts', '.tsx'].includes(path.extname(parsed.file))) {
    fail(
      "A module of custom hooks is TypeScript: the copy the compile writes of it types each state's argument.",
    );
  }
  const declarations = sourceFile.statements.filter(isImportDeclaration);
  const statements = sourceFile.statements.filter((statement) => !isImportDeclaration(statement));
  for (const statement of statements) {
    checkModuleStatement(statement, fail);
  }
  const { intrinsic, modules } = readImports(
    declarations,
    sourceFile,
    (specifier) => reading.modules.targetOf(specifier, parsed.file),
    fail,
  );
  const definitions = new Map<string, HookDefinition>();
  const module: HookModule & { hooks: Map<string, HookDefinition> } = {
    definitions,
    fail,
    file: parsed.file,
    fileName: parsed.name,
    hooks: new Map(),
    id: reading.id,
    intrinsic,
    modules,
    sourceFile,
    statements,
  };
  const functions = new Map(
    statements
      .filter(isFunctionDeclaration)
      .flatMap((fn) => (fn.name === undefined ? [] : [[fn.name.text, fn] as const])),
  );
  const reactive = reactiveHooks(module, functions, reading.hooks);
  const defining = new Set<string>();
  const definitionOf = (name: string): HookDefinition | undefined => {
    const fn = reactive.get(name);
    if (fn === undefined) {
      return undefined;
    }
    let definition = definitions.get(name);
    if (definition === undefined) {
      const [first, ...overloads] = statements.filter(
        (statement) => isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      if (first !== undefined && overloads.length > 0) {
        return fail(
          `\`${name}\` is declared over overloads, of which the copy of the module the browser runs would type each parameter a state is declared with apart: declare it once.`,
          first,
        );
      }
      if (defining.has(name)) {
        return fail(
          `\`${name}\` calls itself, through the hooks it calls: a hook declares its states once, in order, as React calls it.`,
          fn,
        );
      }
      defining.add(name);
      definition = defineHook(fn, {
        definitionOf,
        hooks: reading.hooks,
        module,
        modules: reading.modules,
      });
      definitions.set(name, definition);
    }
    return definition;
  };
  for (const name of reactive.keys()) {
    definitionOf(name);
  }
  for (const [exported, local] of exportsOf(statements)) {
    const definition = definitionOf(local);
    if (definition !== undefined) {
      module.hooks.set(exported, definition);
    }
  }
  return module;
}

/**
 * The functions of a module that are hooks declaring state: named `use…`, and holding a state's
 * declaration — `useReactiveState`, or a call of another such hook, of this module or another.
 */
function reactiveHooks(
  module: HookModule,
  functions: ReadonlyMap<string, FunctionDeclaration>,
  hooks: HookModules,
): ReadonlyMap<string, FunctionDeclaration> {
  const bindings = new Map(
    module.modules.flatMap((imported) =>
      imported.bindings.map((binding) => [binding.name.text, binding] as const),
    ),
  );
  const reactive = new Map<string, FunctionDeclaration>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, fn] of functions) {
      if (reactive.has(name) || !HOOK_NAME.test(name) || fn.body === undefined) {
        continue;
      }
      const isHook = (identifier: Identifier): boolean => {
        const binding = bindings.get(identifier.text);
        return (
          reactive.has(identifier.text) ||
          (binding !== undefined && hooks.hookOf(binding) !== undefined)
        );
      };
      const declares = fn.body.statements.some((statement) => {
        try {
          return (
            stateStatementOf(statement, { isHook, sourceFile: module.sourceFile }, module.fail) !==
            null
          );
        } catch {
          return true;
        }
      });
      if (declares) {
        reactive.set(name, fn);
        grew = true;
      }
    }
  }
  return reactive;
}

interface Defining {
  readonly module: HookModule;
  readonly hooks: HookModules;
  readonly modules: Modules;
  /** The hook of this module named `name`, analyzed. */
  readonly definitionOf: (name: string) => HookDefinition | undefined;
}

const HOOK_SHAPE =
  'A custom hook declares its states and its constants, each with `const`, and ends with `return` — nothing else: it runs in the browser, so an authorization belongs to the server part of the component that calls it.';

/** Refuses a hook React could not call as it renders, or whose parameters cannot be bound. */
function checkHook(fn: FunctionDeclaration, name: string, fail: Fail): void {
  const isAsync =
    fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true;
  if (isAsync || fn.asteriskToken !== undefined) {
    fail(
      `\`${name}\` is a custom hook, which React calls as it renders: it is neither async nor a generator.`,
      fn,
    );
  }
  for (const parameter of fn.parameters) {
    if (!isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined) {
      fail(
        `\`${name}\` takes each argument as a parameter of its own, named: the compiler binds each to its caller's argument.`,
        parameter,
      );
    }
  }
}

/** A hook's body: its states, its constants, and the `return` it ends with. */
interface HookBody {
  readonly states: readonly OwnedState[];
  readonly constants: readonly VariableStatement[];
  readonly returned: ReturnStatement;
}

function bodyOf(
  fn: FunctionDeclaration,
  defining: Defining,
  hookOf: (identifier: Identifier) => HookDefinition | undefined,
): HookBody {
  const { fail, sourceFile } = defining.module;
  const name = fn.name?.text ?? '';
  const statements = fn.body?.statements ?? [];
  const returned = statements.at(-1);
  if (returned === undefined || !isReturnStatement(returned) || returned.expression === undefined) {
    return fail(`\`${name}\` ends with \`return\` and what its callers read.`, returned ?? fn);
  }
  const reading = {
    isHook: (identifier: Identifier) => hookOf(identifier) !== undefined,
    sourceFile,
  };
  const shaped: Fail = (reason, node) =>
    fail(reason.startsWith('After the state') ? HOOK_SHAPE : reason, node);
  const states: OwnedState[] = [];
  const constants: VariableStatement[] = [];
  const callIndexes = new Map<string, number>();
  const before = statements.slice(0, -1);
  for (const statement of before) {
    const state = stateStatementOf(statement, reading, fail);
    if (state === null) {
      constants.push(constantOf(statement, reading, shaped));
    } else {
      states.push(state.kind === 'state' ? state : nestedCall(state, hookOf, callIndexes));
    }
  }
  return { constants, returned, states };
}

function defineHook(fn: FunctionDeclaration, defining: Defining): HookDefinition {
  const { module } = defining;
  if (fn.body === undefined) {
    return module.fail(HOOK_SHAPE, fn);
  }
  const name = fn.name?.text ?? '';
  checkHook(fn, name, module.fail);
  const bindings = bindingsOf(module);
  const hookOf = (identifier: Identifier): HookDefinition | undefined => {
    const binding = bindings.get(identifier.text);
    if (binding !== undefined) {
      return defining.hooks.hookOf(binding);
    }
    return identifier.text === name ? undefined : defining.definitionOf(identifier.text);
  };
  const { constants, returned, states } = bodyOf(fn, defining, hookOf);
  const names = hookNames({ constants, fn, module, states }, module.fail);
  const owner = `${module.id}#${name}`;
  const sides = hookSides({
    constants,
    fn,
    module,
    modules: defining.modules,
    name,
    names,
    owner,
    returned,
    states,
  });
  return {
    declaration: fn,
    fed: sides.fed,
    feeds: sides.feeds,
    items: sides.items,
    module,
    name,
    names,
    owner,
    sides,
    sites: sides.sites,
    states,
    writes: sides.writes,
  };
}

/** A module's imports, by the name each declares. */
function bindingsOf(module: HookModule): ReadonlyMap<string, ImportBinding> {
  const bindings = module.modules.flatMap((imported) => imported.bindings);
  return new Map(bindings.map((binding) => [binding.name.text, binding] as const));
}

function nestedCall(
  statement: HookCallStatement,
  hookOf: (identifier: Identifier) => HookDefinition | undefined,
  callIndexes: Map<string, number>,
): HookCall {
  const hook = hookOf(statement.callee);
  if (hook === undefined) {
    throw new Error(`\`${statement.callee.text}\` was read as a custom hook, which it is not.`);
  }
  // Counted by the name, which keys the states: two hooks of one name are two calls of it.
  const index = callIndexes.get(hook.name) ?? 0;
  callIndexes.set(hook.name, index + 1);
  return { ...statement, hook, index, prefix: `${hook.name}#${String(index)}.` };
}

interface HookParts {
  readonly module: HookModule;
  readonly fn: FunctionDeclaration;
  readonly states: readonly OwnedState[];
  readonly constants: readonly VariableStatement[];
}

/** The names a hook's module declares at its top level, each what it is to the hook's body. */
function moduleNames(module: HookModule): Map<string, TopLevel> {
  const names = new Map<string, TopLevel>();
  if (module.intrinsic !== undefined) {
    names.set(module.intrinsic.text, { kind: 'intrinsic' });
  }
  const bindings = module.modules.flatMap((imported) => imported.bindings);
  for (const binding of bindings) {
    names.set(binding.name.text, { binding, kind: 'import' });
  }
  const declared = module.statements.flatMap((statement) => declaredAtTop(statement));
  for (const identifier of declared) {
    names.set(identifier.text, { kind: 'module' });
  }
  return names;
}

/** The names a hook's body sees at its top level: its module's, its own, its parameters', its states', its constants'. */
function hookNames(parts: HookParts, fail: Fail): ReadonlyMap<string, TopLevel> {
  const { fn } = parts;
  const names = moduleNames(parts.module);
  if (fn.name !== undefined) {
    names.set(fn.name.text, { kind: 'self' });
  }
  const own = new Set<string>();
  const declared: readonly Named[] = [
    ...fn.parameters.map((parameter, index) => {
      const identifier = isIdentifier(parameter.name) ? parameter.name : undefined;
      return named(identifier, { index, kind: 'param', parameter });
    }),
    ...parts.states.flatMap((state) => stateNames(state)),
    ...parts.constants.flatMap((statement) => constantNames(statement)),
  ];
  for (const [identifier, entry] of declared) {
    if (identifier === undefined) {
      continue;
    }
    if (names.has(identifier.text) && names.get(identifier.text)?.kind !== 'module') {
      fail(
        `\`${identifier.text}\` is a name of the hook's module, or of the hook, already: give it a name of its own.`,
        identifier,
      );
    }
    if (own.has(identifier.text) || identifier.text === '__proto__') {
      fail(
        `\`${identifier.text}\` is declared twice among the hook's names — its parameters, its states and its constants — each of which is its own.`,
        identifier,
      );
    }
    own.add(identifier.text);
    names.set(identifier.text, entry);
  }
  return names;
}
