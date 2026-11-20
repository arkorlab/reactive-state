import {
  type BindingElement,
  type FunctionDeclaration,
  type Identifier,
  type ImportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isObjectBindingPattern,
  isReturnStatement,
  type Node,
  type ParameterDeclaration,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import type { HookDefinition } from './hooks.ts';
import { type ImportBinding, type ImportedModule, INTRINSIC, readImports } from './imports.ts';
import type { ModuleClass } from './modules.ts';
import { isNodeProp } from './nodes.ts';
import { prefixDeclarations } from './prefix.ts';
import { bindingIdentifiers, declaredWithin } from './scope.ts';
import {
  constantOf,
  type HookCallStatement,
  type Reading,
  type StateDeclaration,
  stateStatementOf,
} from './statements.ts';

/**
 * The shape a `.reactive.tsx` component must have, read off its syntax: imports, and one
 * default-exported function — async or not — taking its props as one destructured parameter, whose
 * body is its server part — any code, which the authority runs, `return`s of JSX among it — then,
 * where it has state, its states, then the constants the browser computes, then one `return` of
 * JSX. Without state, the whole body is the server part, and the component renders on the
 * authority alone. Anything else is refused where it stands, never compiled around.
 */

/** The longest name a component has: its client part is named by it. */
const MAX_NAME_LENGTH = 128;

/** One prop the component destructures: its name, and the name the component reads it by. */
interface Prop {
  readonly name: string;
  readonly local: Identifier;
  readonly element: BindingElement;
  /** Whether it holds nodes, which the authority renders: `children`, or an element (`nodes.ts`). */
  readonly node: boolean;
}

/** A custom hook's call, with the hook it calls. */
export interface HookCall extends HookCallStatement {
  readonly hook: HookDefinition;
  /** Which call of the hook it is in its caller, from 0: its states are keyed by it. */
  readonly index: number;
  /** What its states' keys begin with in the caller: `useEstimate#0.`. */
  readonly prefix: string;
}

/** What one of the names a component's — or a hook's — body sees at its top level is. */
export type TopLevel =
  | { readonly kind: 'constant'; readonly declaration: VariableDeclaration }
  | { readonly kind: 'hooked'; readonly call: HookCall; readonly item: string }
  | { readonly kind: 'import'; readonly binding: ImportBinding }
  | { readonly kind: 'intrinsic' }
  /** A declaration of a module of hooks beside its hooks, which the copy of it holds as written. */
  | { readonly kind: 'module' }
  | { readonly kind: 'param'; readonly parameter: ParameterDeclaration; readonly index: number }
  | { readonly kind: 'prop'; readonly prop: Prop }
  /** A prop that holds nodes, which the authority renders, and the browser shows in a slot alone. */
  | { readonly kind: 'node'; readonly prop: Prop }
  | { readonly kind: 'self' }
  /** Something the server part declares, which the authority alone has. */
  | { readonly kind: 'server' }
  | { readonly kind: 'setter'; readonly state: StateDeclaration }
  | { readonly kind: 'state'; readonly state: StateDeclaration };

/** A state statement, a custom hook's call resolved to the hook it calls. */
export type OwnedState = HookCall | StateDeclaration;

export interface Component {
  /** Its id: its path in the source directory, without `.reactive.tsx`. */
  readonly id: string;
  /** How what is refused names it. */
  readonly fileName: string;
  readonly sourceFile: SourceFile;
  readonly name: string;
  readonly declaration: FunctionDeclaration;
  readonly isAsync: boolean;
  readonly modules: readonly ImportedModule[];
  readonly parameter: ParameterDeclaration | undefined;
  readonly props: readonly Prop[];
  /** The props' type, as the component annotates them. */
  readonly propsType: TypeNode | undefined;
  /** What runs before the state: the code the authority runs. Without state, the whole body. */
  readonly server: readonly Statement[];
  readonly states: readonly OwnedState[];
  /** What the browser computes after the state. */
  readonly constants: readonly VariableStatement[];
  /** The `return` of the browser's JSX, for a component with state. */
  readonly returned: ReturnStatement | undefined;
  readonly names: ReadonlyMap<string, TopLevel>;
  /** The identifiers that declare the top-level names. */
  readonly declaring: ReadonlySet<Node>;
  /** Every name a declaration in the file gives. */
  readonly declared: ReadonlySet<string>;
  readonly fail: Fail;
}

/** What a component is read with. */
export interface ComponentReading {
  readonly id: string;
  readonly fileName: string;
  readonly sourceFile: SourceFile;
  readonly classify: (specifier: string) => ModuleClass;
  /** The custom hook `binding` imports, where it is one that declares state. */
  readonly hookOf: (binding: ImportBinding) => HookDefinition | undefined;
  readonly fail: Fail;
}

export function analyzeComponent(reading: ComponentReading): Component {
  const fail: Fail = reading.fail;
  const { sourceFile } = reading;
  const { body, declaration, name } = componentOf(sourceFile, fail);
  const declarations: ImportDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (statement === declaration) {
      continue;
    }
    if (!isImportDeclaration(statement)) {
      fail(
        "Code beside the component runs in neither the authority nor the browser; only imports are allowed there: declare what the component uses in a module of the application's, and import it.",
        statement,
      );
    }
    declarations.push(statement);
  }
  const { intrinsic, modules } = readImports(declarations, sourceFile, reading.classify, fail);
  const bindings = new Map(
    modules.flatMap((module) => module.bindings.map((binding) => [binding.name.text, binding])),
  );
  const hookOf = (identifier: Identifier): HookDefinition | undefined => {
    const binding = bindings.get(identifier.text);
    return binding === undefined ? undefined : reading.hookOf(binding);
  };
  const statementReading = {
    isHook: (identifier: Identifier) => hookOf(identifier) !== undefined,
    sourceFile,
  };
  const parts = splitBody(body.statements, { hookOf, reading: statementReading }, fail);
  if (intrinsic === undefined) {
    const declared = parts.states.find((state) => state.kind === 'state');
    if (declared !== undefined) {
      fail(
        `\`${INTRINSIC}\` is imported from \`framework/react\`: \`import { ${INTRINSIC} } from 'framework/react'\`.`,
        declared.statement,
      );
    }
  }
  const { parameter, props, propsType } = propsOf(declaration, bindings, fail);
  const names = topLevelNames(
    { ...parts, intrinsic, modules, name: declaration.name, props },
    fail,
  );
  const declared = new Set(declaredWithin(body));
  for (const topName of names.names.keys()) {
    declared.add(topName);
  }
  return {
    ...parts,
    declaration,
    declared,
    declaring: names.declaring,
    fail,
    fileName: reading.fileName,
    id: reading.id,
    isAsync:
      declaration.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true,
    modules,
    name,
    names: names.names,
    parameter,
    props,
    propsType,
    sourceFile,
  };
}

/** The body's parts: its server part, its states, its constants and its last `return`. */
interface BodyParts {
  readonly server: readonly Statement[];
  readonly states: readonly OwnedState[];
  readonly constants: readonly VariableStatement[];
  readonly returned: ReturnStatement | undefined;
}

/**
 * The body, split where its first state is declared: before it, the server part; then the states,
 * one after another; then the browser's constants and the `return` of its JSX. A body of no state
 * is its server part whole.
 */
function splitBody(
  statements: readonly Statement[],
  context: {
    readonly reading: Reading;
    readonly hookOf: (identifier: Identifier) => HookDefinition | undefined;
  },
  fail: Fail,
): BodyParts {
  const { hookOf, reading } = context;
  const first = statements.findIndex(
    (statement) => stateStatementOf(statement, reading, fail) !== null,
  );
  if (first === -1) {
    return { constants: [], returned: undefined, server: statements, states: [] };
  }
  const returned = statements.at(-1);
  if (returned === undefined || !isReturnStatement(returned) || returned.expression === undefined) {
    return fail(
      'A component with state ends with `return` and its JSX.',
      returned ?? statements[first],
    );
  }
  const states: OwnedState[] = [];
  const callIndexes = new Map<string, number>();
  let end = first;
  while (end < statements.length - 1) {
    const state = stateStatementOf(statements[end], reading, fail);
    if (state === null) {
      break;
    }
    states.push(state.kind === 'state' ? state : hookCallOf(state, hookOf, callIndexes));
    end += 1;
  }
  return {
    constants: statements.slice(end, -1).map((statement) => constantOf(statement, reading, fail)),
    returned,
    server: statements.slice(0, first),
    states,
  };
}

function hookCallOf(
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

function componentOf(
  sourceFile: SourceFile,
  fail: Fail,
): {
  readonly body: NonNullable<FunctionDeclaration['body']>;
  readonly declaration: FunctionDeclaration;
  readonly name: string;
} {
  const [declaration, ...others] = sourceFile.statements.filter(isFunctionDeclaration);
  if (declaration?.body === undefined || others.length > 0) {
    return fail('A component file holds one function: the default-exported component.');
  }
  const modifiers = new Set(declaration.modifiers?.map((modifier) => modifier.kind));
  if (!modifiers.has(SyntaxKind.DefaultKeyword) || !modifiers.has(SyntaxKind.ExportKeyword)) {
    return fail(
      'The component is declared `export default function`, or `export default async function`.',
      declaration,
    );
  }
  if (declaration.asteriskToken !== undefined) {
    return fail(
      'The component is a function, not a generator: what it yields would be lost.',
      declaration,
    );
  }
  if (declaration.name === undefined) {
    return fail(
      'The component needs a name: it names what the compile writes for it.',
      declaration,
    );
  }
  if (declaration.name.text.length > MAX_NAME_LENGTH) {
    return fail(
      `The component's name is ${String(MAX_NAME_LENGTH)} characters long at most: every binding the authority signs for it names it.`,
      declaration.name,
    );
  }
  if (declaration.typeParameters !== undefined) {
    return fail(
      'The component takes no type parameters: its props are what a page renders it with.',
      declaration.typeParameters[0],
    );
  }
  return { body: declaration.body, declaration, name: declaration.name.text };
}

const PROPS_SHAPE =
  'The component takes its props as one destructured parameter, each prop by its name or renamed — `{ projectId, id }: { projectId: string; id: string }` — or takes none.';

/** The props: one destructured parameter, or none; `imports` are the component's, by name. */
function propsOf(
  declaration: FunctionDeclaration,
  imports: ReadonlyMap<string, ImportBinding>,
  fail: Fail,
): {
  readonly parameter: ParameterDeclaration | undefined;
  readonly props: readonly Prop[];
  readonly propsType: TypeNode | undefined;
} {
  const [parameter, ...others] = declaration.parameters;
  if (parameter === undefined) {
    return { parameter, props: [], propsType: undefined };
  }
  const pattern = parameter.name;
  if (
    others.length > 0 ||
    parameter.initializer !== undefined ||
    parameter.dotDotDotToken !== undefined ||
    parameter.questionToken !== undefined ||
    !isObjectBindingPattern(pattern)
  ) {
    return fail(PROPS_SHAPE, parameter);
  }
  const props = pattern.elements.map((element): Prop => {
    const property = element.propertyName ?? element.name;
    if (
      property === undefined ||
      element.name === undefined ||
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      !isIdentifier(element.name) ||
      !isIdentifier(property)
    ) {
      return fail(PROPS_SHAPE, element);
    }
    const node = isNodeProp(property.text, parameter.type, imports);
    return { element, local: element.name, name: property.text, node };
  });
  return { parameter, props, propsType: parameter.type };
}

interface Parts {
  readonly modules: readonly ImportedModule[];
  readonly intrinsic: Identifier | undefined;
  readonly name: Identifier | undefined;
  readonly props: readonly Prop[];
  readonly server: readonly Statement[];
  readonly states: readonly OwnedState[];
  readonly constants: readonly VariableStatement[];
}

/** Names no output lets a component's code take: what the outputs read within its code. */
export const RESERVED: ReadonlySet<string> = new Set([
  '$',
  '__proto__',
  'localOf',
  'part',
  'sites',
  'slotOf',
  'stateOf',
  'useSites',
]);

/** Why a component's code does not take `$` in particular, which the outputs read most. */
export const DOLLAR =
  "`$` is what the authority's program renders with, within the component's own code: the component neither declares nor reads it.";

/** A name the component, or a hook, declares at its top level, and what it is. */
export type Named = readonly [Identifier | undefined, TopLevel];

export function named(identifier: Identifier | undefined, entry: TopLevel): Named {
  return [identifier, entry];
}

/** The names a state statement declares, each what it is. */
export function stateNames(state: OwnedState): readonly Named[] {
  if (state.kind === 'state') {
    return [
      [state.value, { kind: 'state', state }],
      [state.setter, { kind: 'setter', state }],
    ];
  }
  if (state.binding.kind === 'whole') {
    return [named(state.binding.name, hooked(state, 'whole'))];
  }
  return [...state.binding.names].map(([item, name]) => named(name, hooked(state, item)));
}

function hooked(call: HookCall, item: string): TopLevel {
  return { call, item, kind: 'hooked' };
}

/** The names a constant statement declares. */
export function constantNames(statement: VariableStatement): readonly Named[] {
  return statement.declarationList.declarations.flatMap((declaration) => {
    const entry: TopLevel = { declaration, kind: 'constant' };
    return bindingIdentifiers(declaration.name).map((identifier) => named(identifier, entry));
  });
}

/**
 * The component's top-level names, pairwise distinct: two of one name would leave one of them
 * unaddressable, and the compiler tells a server value from the browser's by its name.
 */
function topLevelNames(
  parts: Parts,
  fail: Fail,
): { readonly names: ReadonlyMap<string, TopLevel>; readonly declaring: ReadonlySet<Node> } {
  const names = new Map<string, TopLevel>();
  const declaring = new Set<Node>();
  const bindings = parts.modules.flatMap((module) => module.bindings);
  const entries: readonly Named[] = [
    [parts.intrinsic, { kind: 'intrinsic' }],
    ...bindings.map((binding) => named(binding.name, { binding, kind: 'import' })),
    [parts.name, { kind: 'self' }],
    ...parts.props.map((prop) => named(prop.local, { kind: prop.node ? 'node' : 'prop', prop })),
    ...prefixDeclarations(parts.server).map((identifier) => named(identifier, { kind: 'server' })),
    ...parts.states.flatMap((state) => stateNames(state)),
    ...parts.constants.flatMap((statement) => constantNames(statement)),
  ];
  for (const [identifier, entry] of entries) {
    if (identifier === undefined) {
      continue;
    }
    if (RESERVED.has(identifier.text)) {
      fail(
        identifier.text === '$'
          ? DOLLAR
          : `\`${identifier.text}\` is a name the compile's outputs read within the component's code, which the component does not take: give it another one.`,
        identifier,
      );
    }
    if (names.has(identifier.text)) {
      fail(
        `\`${identifier.text}\` is declared twice among the component's top-level names — its imports, its own name, its props, what its server part declares, its states and the browser's constants — each of which is its own.`,
        identifier,
      );
    }
    names.set(identifier.text, entry);
    declaring.add(identifier);
  }
  return { declaring, names };
}
