import {
  type Identifier,
  isCallExpression,
  isTypeReferenceNode,
  type Node,
  type ParameterDeclaration,
  type TypeNode,
} from 'typescript/ast';

import { header } from './emit-authority.ts';
import { compiledCall, REACT } from './emit-client.ts';
import type { HookModule } from './hooks.ts';
import { importDeclarations, type ImportLine } from './imports.ts';
import type { ModuleClass } from './modules.ts';
import { type Space, walk } from './scope.ts';
import { type Rewrite, spliced, splicedFrom } from './splice.ts';
import type { ApplySite } from './updaters.ts';

/**
 * The copy of a module of custom hooks the browser runs (`<module id>.ts`): the module as it is
 * written, save that `useReactiveState` is the framework's, that a parameter a state is declared
 * with as it is takes what the authority made of its caller's argument (`StateInput<number>` of
 * `FieldRef<number>`, `LocalStateInput<T>` of a local state's `T`), and that each registered update
 * names its updater.
 */

export interface HookCopyInput {
  readonly module: HookModule;
  /** Where the copy imports a module the compile writes a copy or a stub of; none for another. */
  readonly outputOf: (target: ModuleClass) => string | undefined;
}

/** A parameter a state is declared with, as the copy types it: the input it takes, of `type`. */
interface Typed {
  readonly type: TypeNode;
  /** `StateInput`, of what may bind a field, or `LocalStateInput`, of a local state's value. */
  readonly wrapper: 'LocalStateInput' | 'StateInput';
}

/**
 * Each parameter a state of the module's hooks is declared with as it is, by its type's node: the
 * value's type, and the input the copy takes — of a local state's value, or of what may bind a field.
 */
function typedOf(module: HookModule): ReadonlyMap<Node, Typed> {
  const typed = new Map<Node, Typed>();
  for (const definition of module.definitions.values()) {
    const { parameters } = definition.declaration;
    const local = new Set(
      [...definition.fed.values()]
        .filter((fed) => !fed.persistent)
        .map((fed) => parameters[fed.index]),
    );
    for (const [parameter, type] of definition.sides.inputs) {
      if (parameter.type !== undefined) {
        typed.set(parameter.type, {
          type,
          wrapper: local.has(parameter) ? 'LocalStateInput' : 'StateInput',
        });
      }
    }
  }
  return typed;
}

export function emitHookModule(input: HookCopyInput): string {
  const { module } = input;
  const { sourceFile } = module;
  const inputs = new Map<ParameterDeclaration, TypeNode>();
  const calls = new Map<Node, ApplySite>();
  for (const definition of module.definitions.values()) {
    for (const [parameter, type] of definition.sides.inputs) {
      inputs.set(parameter, type);
    }
    for (const [call, site] of definition.writes.calls) {
      calls.set(call, site);
    }
  }
  const typed = typedOf(module);
  const rewrite: Rewrite = (node) => {
    const parameter = typed.get(node);
    if (parameter !== undefined) {
      return `${parameter.wrapper}<${spliced(parameter.type, sourceFile, rewrite)}>`;
    }
    const site = calls.get(node);
    return site !== undefined && isCallExpression(node)
      ? compiledCall(node, site, { rewrite, sourceFile })
      : undefined;
  };
  const skipped = new Set<Node>();
  for (const [parameter, type] of inputs) {
    if (
      parameter.type !== undefined &&
      parameter.type !== type &&
      isTypeReferenceNode(parameter.type)
    ) {
      skipped.add(parameter.type.typeName);
    }
  }
  const wrappers = new Set<string>();
  for (const { wrapper } of typed.values()) {
    wrappers.add(wrapper);
  }
  const runtime = [
    wrappers.has('LocalStateInput') ? 'type LocalStateInput' : undefined,
    wrappers.has('StateInput') ? 'type StateInput' : undefined,
    module.intrinsic === undefined ? undefined : 'useReactiveState',
  ].filter((name) => name !== undefined);
  const body = module.statements
    .map((statement) => splicedFrom(statement, statement.pos, sourceFile, rewrite))
    .join('')
    .replace(/^\n+/u, '');
  return [
    header(module.fileName, 'module'),
    ...(runtime.length === 0 ? [] : [`import { ${runtime.join(', ')} } from '${REACT}';`]),
    ...importDeclarations(importsOf(input, skipped)),
    '',
    body,
    '',
  ].join('\n');
}

/** What the copy imports of the module's imports: what its code reads, and the types it names. */
function importsOf(input: HookCopyInput, skipped: ReadonlySet<Node>): readonly ImportLine[] {
  const { module } = input;
  const bindings = new Map(
    module.modules.flatMap((imported) =>
      imported.bindings.map((binding) => [binding.name.text, binding] as const),
    ),
  );
  const values = new Set<string>();
  const types = new Set<string>();
  const declared = new Set(bindings.keys());
  const read = (identifier: Identifier, space: Space): void => {
    if (skipped.has(identifier)) {
      return;
    }
    const binding = bindings.get(identifier.text);
    if (binding === undefined) {
      return;
    }
    if (space === 'type' || binding.typeOnly) {
      types.add(identifier.text);
      return;
    }
    const { kind } = binding.module.target;
    if (kind === 'server' || kind === 'component') {
      module.fail(
        `\`${identifier.text}\` is \`${binding.module.specifier}\`'s, ${kind === 'server' ? 'a module only the authority runs' : 'a reactive component'}, which the copy of the module — the browser's — cannot import.`,
        identifier,
      );
    }
    values.add(identifier.text);
  };
  for (const statement of module.statements) {
    walk(statement, { declared, declaring: new Set(), topLevel: declared }, { read }, module.fail);
  }
  const lines: ImportLine[] = [];
  for (const imported of module.modules) {
    const output = input.outputOf(imported.target);
    for (const binding of imported.bindings) {
      const name = binding.name.text;
      if (values.has(name)) {
        lines.push({ binding, from: output ?? imported.written, typeOnly: false });
      } else if (types.has(name)) {
        const from = imported.target.kind === 'hooks' ? output : undefined;
        lines.push({ binding, from: from ?? imported.written, typeOnly: true });
      }
    }
  }
  return lines;
}
