import {
  type FunctionDeclaration,
  type Identifier,
  isFunctionTypeNode,
  isIdentifier,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isParenthesizedExpression,
  isTypeReferenceNode,
  type Node,
  type ParameterDeclaration,
  type ReturnStatement,
  type TypeNode,
  type VariableStatement,
} from 'typescript/ast';

import type { OwnedState, TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import { argumentAt, spreadThrough } from './frames.ts';
import { type Held, heldThroughHooks, itemOf, itemsOf } from './hook-items.ts';
import type { Fed, HookModule, Item } from './hooks.ts';
import { INTRINSIC } from './imports.ts';
import { checkParameterKinds } from './kinds.ts';
import type { Modules } from './modules.ts';
import { checkBrowserNode } from './reads.ts';
import { declaredWithin, type Space, walk } from './scope.ts';
import { functionOf } from './statements.ts';
import { constantType, rewrittenType, startedType, type TypeScope } from './types.ts';
import { collectWrites, type UpdaterSite, updaterId, type Writes } from './updaters.ts';

/**
 * What a custom hook reads and writes, as its callers and its copy need it: which of its parameters
 * declare a state as they are, what each item it returns is, and the updates its setters register —
 * once, for every caller. A hook runs in the browser: it reads no module only the authority runs.
 */

/** The framework's module a field reference's type is imported from. */
const PROGRAM = '@arkorlab/reactive-state/program';

export interface HookSides {
  /** For each parameter a state is declared with as it is, by its index: the state's key in the hook. */
  readonly feeds: ReadonlyMap<number, string>;
  readonly fed: ReadonlyMap<string, Fed>;
  readonly items: ReadonlyMap<string, Item>;
  readonly writes: Writes;
  /** Every updater it, and each hook it calls, registers, by id. */
  readonly sites: ReadonlyMap<string, UpdaterSite>;
  /**
   * The parameters its copy takes as a state's input, each with what the copy types the input by:
   * `number` of `ref: FieldRef<number>`, which the copy writes `ref: StateInput<number>`.
   */
  readonly inputs: ReadonlyMap<ParameterDeclaration, TypeNode>;
  /** The names its body is walked with, as a dynamic site that reads one of its items walks it. */
  readonly scope: HookScope;
}

export interface HookInput {
  readonly module: HookModule;
  /** The compile's modules, which the types its parameters name are read of. */
  readonly modules: Modules;
  readonly fn: FunctionDeclaration;
  readonly name: string;
  readonly owner: string;
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly states: readonly OwnedState[];
  readonly constants: readonly VariableStatement[];
  readonly returned: ReturnStatement;
}

/** The names a hook's body is walked with: every name its file declares, and its own declarations. */
interface HookScope {
  readonly declared: ReadonlySet<string>;
  readonly declaring: ReadonlySet<Node>;
}

export function hookSides(input: HookInput): HookSides {
  const { fn, module, names } = input;
  const scope = scopeOf(input);
  const feeding = feedsOf(input);
  const feeds = new Map([...feeding].map(([index, feed]) => [index, feed.key] as const));
  const reads = readHook(input, scope);
  const { fed, inputs } = fedOf(input, { feeds: feeding, reads });
  const held = heldThroughHooks(input.states);
  for (const state of input.states) {
    if (state.kind !== 'state' || state.setter === undefined) {
      continue;
    }
    const key = state.value.text;
    const declared = fed.get(key);
    // A local state's setter is React's, which the page alone applies: called from a handler alone,
    // as any setter is, it registers nothing.
    if (declared !== undefined) {
      const set = updaterId(input.owner, key, 'set');
      const setter = { key, set, site: key, type: declared.type };
      held.setters.set(
        state.setter.text,
        declared.persistent ? setter : { ...setter, local: true },
      );
    }
  }
  const returned = itemsOf(input.returned, module.fail);
  const writes = collectWrites({
    captureType: (identifier) => captureTypeOf(identifier, { fed, input }),
    declaration: fn,
    declared: scope.declared,
    declaring: scope.declaring,
    fail: module.fail,
    holdsFunction: (identifier) => holdsFunction(identifier, names, held),
    id: input.owner,
    items: returned,
    names,
    reads,
    setters: held.setters,
    sites: held.sites,
    sourceFile: module.sourceFile,
    writing: held.writing,
  });
  const sites = new Map(held.sites);
  for (const [id, registered] of writes.updaters) {
    sites.set(id, registered.site);
  }
  const items = new Map<string, Item>();
  for (const [key, node] of returned) {
    items.set(key, itemOf(node, { fed, held, names, writes }));
  }
  return { fed, feeds, inputs, items, scope, sites, writes };
}

function scopeOf(input: HookInput): HookScope {
  const { fn } = input;
  const declared = new Set(declaredIn(input.module));
  for (const name of input.names.keys()) {
    declared.add(name);
  }
  const declaring = new Set<Node>(fn.parameters.map((parameter) => parameter.name));
  if (fn.name !== undefined) {
    declaring.add(fn.name);
  }
  for (const state of input.states) {
    for (const identifier of declaringOf(state)) {
      declaring.add(identifier);
    }
  }
  const declarations = input.constants.flatMap(
    (statement) => statement.declarationList.declarations,
  );
  for (const declaration of declarations) {
    declaring.add(declaration.name);
  }
  return { declared, declaring };
}

/** The identifiers a state statement declares. */
function declaringOf(state: OwnedState): readonly Identifier[] {
  if (state.kind === 'state') {
    return state.setter === undefined ? [state.value] : [state.value, state.setter];
  }
  return state.binding.kind === 'whole' ? [state.binding.name] : [...state.binding.names.values()];
}

/** The parameter `node` is, as it is: the one a state of the hook's, or a hook it calls, is declared with. */
function parameterIn(
  node: Node | undefined,
  names: ReadonlyMap<string, TopLevel>,
): number | undefined {
  let argument = node;
  while (argument !== undefined && isParenthesizedExpression(argument)) {
    argument = argument.expression;
  }
  const entry =
    argument !== undefined && isIdentifier(argument) ? names.get(argument.text) : undefined;
  return entry?.kind === 'param' ? entry.index : undefined;
}

/** A parameter a state is declared with as it is: the state's key, and the hook's that declares it. */
interface Feed {
  readonly key: string;
  /** For a state of a hook this one calls, whether that hook takes a field there. */
  readonly persistent?: boolean;
}

/** For each parameter a state is declared with as it is, by its index, the state it declares. */
function feedsOf(input: HookInput): ReadonlyMap<number, Feed> {
  const { names } = input;
  const fail: Fail = input.module.fail;
  const feeds = new Map<number, Feed>();
  const feed = (index: number | undefined, fed: Feed, node: Node): void => {
    if (index === undefined) {
      return;
    }
    if (feeds.has(index)) {
      fail(
        `\`${node.getText()}\` declares one state as it is, not two: each is a field of its own.`,
        node,
      );
    }
    feeds.set(index, fed);
  };
  for (const state of input.states) {
    if (state.kind === 'state') {
      feed(parameterIn(state.input, names), { key: state.value.text }, state.input);
      continue;
    }
    for (const [index, key] of state.hook.feeds) {
      // A refusal points at the spread that displaces the argument, which is what to change.
      const argument = spreadThrough(state.call.arguments, index) ?? state.call.arguments[index];
      const parameter = parameterIn(argumentAt(state.call.arguments, index), names);
      if (parameter === undefined) {
        fail(
          `\`${state.callee.text}\` declares a state with this argument as it is, which the authority evaluates for the browser: within a hook, that is one of the hook's own parameters, given as it is.`,
          argument ?? state.call,
        );
      }
      const persistent = state.hook.fed.get(key)?.persistent ?? false;
      feed(parameter, { key: `${state.prefix}${key}`, persistent }, argument ?? state.call);
    }
  }
  return feeds;
}

/**
 * Refuses `parameter`, which declares a state as it is, where the authority would start that state
 * otherwise than the browser's hook: read elsewhere too (`uses`), taking a default, or optional.
 */
function checkFeeding(
  parameter: ParameterDeclaration,
  uses: readonly Identifier[],
  fail: Fail,
): void {
  const name = parameter.name.getText();
  if (uses.length !== 1) {
    fail(
      `\`${name}\` declares a state as it is — the authority evaluates it for the hook's caller — so it is read by that state alone.`,
      uses[1] ?? parameter,
    );
  }
  if (parameter.initializer !== undefined) {
    fail(
      `\`${name}\` declares a state, and takes a default, which the browser's hook applies where its call gives \`undefined\`, and the authority, which starts the state of what the call gives, would not. Leave the default out, and give the value in the call.`,
      parameter,
    );
  }
  if (parameter.questionToken !== undefined) {
    fail(
      `\`${name}\` declares a state, and is optional: a call may give it nothing, of which the authority starts no state while the browser's hook starts one of \`undefined\`. Make it required, and give the value in each call.`,
      parameter,
    );
  }
}

/**
 * Refuses the local state `fed.key` a hook declares of its parameter `fed.name`, as `useReactiveState`
 * does, where the parameter's type, or the state's own type argument —
 * `useReactiveState<string | undefined>(initial)` — is of more than one kind of JSON, of
 * `undefined`, or of a kind the compile cannot tell (`checkParameterKinds`).
 */
function checkFedKinds(
  input: HookInput,
  fed: { readonly key: string; readonly name: string; readonly type: TypeNode },
  fail: Fail,
): void {
  const at = { file: input.module.file, sourceFile: input.module.sourceFile };
  const context = { at, modules: input.modules, parameters: input.fn.typeParameters ?? [] };
  checkParameterKinds(fed.name, fed.type, context, fail);
  const declared = input.states.find(
    (state) => state.kind === 'state' && state.value.text === fed.key,
  );
  const [argument] = declared?.kind === 'state' ? (declared.call.typeArguments ?? []) : [];
  if (argument !== undefined && declared?.kind === 'state') {
    checkParameterKinds(declared.value.text, argument, context, fail);
  }
}

/** The states a hook's callers have the authority evaluate, and the type of each parameter the copy writes. */
function fedOf(
  input: HookInput,
  read: {
    readonly feeds: ReadonlyMap<number, Feed>;
    readonly reads: ReadonlyMap<string, readonly Identifier[]>;
  },
): {
  readonly fed: ReadonlyMap<string, Fed>;
  readonly inputs: ReadonlyMap<ParameterDeclaration, TypeNode>;
} {
  const { fn, names } = input;
  const fail: Fail = input.module.fail;
  const inputs = new Map<ParameterDeclaration, TypeNode>();
  const fed = new Map<string, Fed>();
  for (const [index, feed] of read.feeds) {
    const { key } = feed;
    const parameter = fn.parameters[index];
    if (parameter === undefined) {
      continue;
    }
    const name = parameter.name.getText();
    checkFeeding(parameter, read.reads.get(name) ?? [], fail);
    const type =
      parameter.type ??
      fail(
        `\`${name}\` declares a state: its type is written, which the copy of the hook types the state's input by.`,
        parameter,
      );
    const untyped = (): never => {
      return fail(
        `\`${name}\` is typed \`FieldRef\` of no value's type, which the copy of the hook types the state's input by: type it \`FieldRef<T>\`, naming the type of the field's value.`,
        parameter,
      );
    };
    const field = fieldValueType(type, names, untyped);
    const persistent = field !== undefined;
    if (feed.persistent !== undefined && feed.persistent !== persistent) {
      fail(
        persistent
          ? `\`${name}\` is typed \`FieldRef<T>\`, a field of the database, and gives it on to a hook that declares a local state of it, whose setter is React's: type it as the value itself.`
          : `\`${name}\` declares a local state, of a value of the page's, and gives it on to a hook that takes a field of the database there: type it \`FieldRef<T>\`, as that hook does.`,
        parameter,
      );
    }
    if (!persistent) {
      checkFedKinds(input, { key, name, type }, fail);
    }
    const value = field ?? type;
    inputs.set(parameter, value);
    fed.set(key, { index, persistent, type: rewrittenType(value, typeScopeOf(input)) });
  }
  return { fed, inputs };
}

/**
 * Walks a hook's code as the browser's, refusing what the browser cannot run, and answers what it
 * reads of its names.
 */
function readHook(input: HookInput, scope: HookScope): ReadonlyMap<string, readonly Identifier[]> {
  const { fn, module, names } = input;
  const fail: Fail = module.fail;
  const reads = new Map<string, Identifier[]>();
  const calls = new Set<Node>(input.states.map((state) => state.call));
  walk(
    fn,
    { declared: scope.declared, declaring: scope.declaring, topLevel: new Set(names.keys()) },
    {
      global: (identifier) => {
        if (identifier.text === INTRINSIC) {
          fail(
            `\`${INTRINSIC}\` is imported from \`framework/react\` to declare a state.`,
            identifier,
          );
        }
      },
      node: (node) => {
        if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) {
          fail("A custom hook renders nothing: JSX belongs in a component's `return`.", node);
        }
        checkBrowserNode(node, fn, scope.declared, fail);
      },
      read: (identifier, space) => {
        readName(identifier, space, { calls, input });
        if (space === 'value') {
          reads.set(identifier.text, [...(reads.get(identifier.text) ?? []), identifier]);
        }
      },
      unresolved: (identifier) => {
        fail(
          `\`${identifier.text}\` is not in the hook's scope here: the declaration of that name is in another of its scopes.`,
          identifier,
        );
      },
    },
    fail,
  );
  return reads;
}

/** Refuses what a hook's code may not read: the intrinsic but to declare, itself, the authority's modules. */
function readName(
  identifier: Identifier,
  space: Space,
  reading: { readonly input: HookInput; readonly calls: ReadonlySet<Node> },
): void {
  const { module, names } = reading.input;
  const fail: Fail = module.fail;
  const entry = names.get(identifier.text);
  if (space === 'type' || entry === undefined) {
    return;
  }
  if (entry.kind === 'intrinsic' && !reading.calls.has(identifier.parent)) {
    fail(`\`${INTRINSIC}\` is called to declare a state, and for nothing else.`, identifier);
  }
  if (entry.kind === 'self') {
    fail(
      `\`${identifier.text}\` does not call itself: a hook declares its states once, in order, as React calls it.`,
      identifier,
    );
  }
  if (entry.kind !== 'import') {
    return;
  }
  const { binding } = entry;
  if (binding.typeOnly) {
    fail(
      `\`${identifier.text}\` is imported as a type, which has no value at run time.`,
      identifier,
    );
  }
  const { kind } = binding.module.target;
  if (kind === 'server' || kind === 'component') {
    const what = kind === 'server' ? 'a module only the authority runs' : 'a reactive component';
    fail(
      `\`${identifier.text}\` is \`${binding.module.specifier}\`'s, ${what}, which a hook — the browser's — does not read.`,
      identifier,
    );
  }
}

/**
 * The type of a field's value a parameter's annotation names — `number` of `FieldRef<number>`, the
 * framework's own — or none where it names something else; `refuse` where it names `FieldRef` of no
 * one value's type, which the copy of the hook could not type the state's input by.
 */
function fieldValueType(
  type: TypeNode,
  names: ReadonlyMap<string, TopLevel>,
  refuse: () => never,
): TypeNode | undefined {
  if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) {
    return undefined;
  }
  const entry = names.get(type.typeName.text);
  const named =
    entry?.kind === 'import' &&
    entry.binding.module.specifier === PROGRAM &&
    entry.binding.exported === 'FieldRef';
  if (!named) {
    return undefined;
  }
  const [argument, ...others] = type.typeArguments ?? [];
  return argument !== undefined && others.length === 0 ? argument : refuse();
}

/** What a hook's types are written against: its module's file and the names its body sees. */
function typeScopeOf(input: HookInput): TypeScope {
  const local = new Set(input.fn.typeParameters?.map(({ name }) => name.text));
  return { local, names: input.names, sourceFile: input.module.sourceFile };
}

/** The type of the value a name of a hook's holds, where the source says it. */
function typeOf(
  entry: TopLevel | undefined,
  context: { readonly fed: ReadonlyMap<string, Fed>; readonly scope: TypeScope },
): string | undefined {
  const { fed, scope } = context;
  if (entry === undefined) {
    return undefined;
  }
  switch (entry.kind) {
    case 'param': {
      return entry.parameter.type === undefined
        ? undefined
        : rewrittenType(entry.parameter.type, scope);
    }
    case 'state': {
      return fed.get(entry.state.value.text)?.type ?? startedType(entry.state, scope);
    }
    case 'hooked': {
      const value = entry.call.hook.items.get(entry.item)?.value;
      return value === undefined ? undefined : entry.call.hook.fed.get(value)?.type;
    }
    case 'constant': {
      return constantType(entry.declaration, scope);
    }
    case 'import':
    case 'intrinsic':
    case 'module':
    case 'node':
    case 'prop':
    case 'self':
    case 'server':
    case 'setter': {
      return undefined;
    }
  }
}

/** The type of a value of the hook's an update captures, as the authority's program writes it. */
function captureTypeOf(
  identifier: Identifier,
  context: { readonly fed: ReadonlyMap<string, Fed>; readonly input: HookInput },
): string {
  const { fed, input } = context;
  const scope = typeScopeOf(input);
  const entry = input.names.get(identifier.text);
  return (
    typeOf(entry, { fed, scope }) ??
    input.module.fail(
      `\`${identifier.text}\` is captured by an update, which the authority types by the value's type: annotate it with one of the module's own imports or of the language's — \`const step: number = …\`.`,
      identifier,
    )
  );
}

/** Whether a name of the hook's holds a function, which an update captures none of. */
function holdsFunction(
  identifier: Identifier,
  names: ReadonlyMap<string, TopLevel>,
  held: Held,
): boolean {
  if (held.setters.has(identifier.text) || held.writing.has(identifier.text)) {
    return true;
  }
  const entry = names.get(identifier.text);
  if (entry?.kind === 'param') {
    return entry.parameter.type !== undefined && isFunctionTypeNode(entry.parameter.type);
  }
  return (
    entry?.kind === 'setter' ||
    (entry?.kind === 'constant' && functionOf(entry.declaration) !== undefined)
  );
}

/** Every name a declaration of a hook's module gives, at any depth. */
function declaredIn(module: HookModule): ReadonlySet<string> {
  const found = new Set<string>(
    module.modules.flatMap((imported) => imported.bindings.map((binding) => binding.name.text)),
  );
  for (const statement of module.statements) {
    for (const name of declaredWithin(statement)) {
      found.add(name);
    }
  }
  if (module.intrinsic !== undefined) {
    found.add(module.intrinsic.text);
  }
  return found;
}
