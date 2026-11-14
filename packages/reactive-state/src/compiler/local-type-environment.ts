import {
  type ClassDeclaration,
  type ClassExpression,
  type InterfaceDeclaration,
  isIdentifier,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  type ExpressionWithTypeArguments,
  type Node,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeReferenceNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { capturedSequencePositions, capturedTypeReading } from './local-type-captured-sequences.ts';

/** The argument environments carried while reading only written local type syntax. */

export type GenericDeclaration =
  | TypeAliasDeclaration
  | InterfaceDeclaration
  | ClassDeclaration
  | ClassExpression;

export interface TypeReading {
  readonly type: TypeNode | ExpressionWithTypeArguments;
  /** Actual arguments, identified by each parameter declaration and their original scope. */
  readonly bindings: ReadonlyMap<TypeParameterDeclaration, TypeReading>;
  /** Declaration and argument environments already expanded on this path. */
  readonly aliases: ReadonlySet<string>;
}

const IDENTITIES = new WeakMap<Node, number>();
const SEQUENCE = { identity: 0 };

/**
 * The longest alias path read. Arguments made of inferred tuple positions (`[H, H, ...R]`) grow
 * without any syntax repeating, so a recursion of them never meets an environment it has met; and
 * what it costs to read one more level grows with the path. A path this long ends as a repeat does.
 */
const ALIAS_PATH = { limit: 32 } as const;

/** A syntax node's identity, without retaining the tree after its compile. */
function identityOf(node: Node): number {
  const previous = IDENTITIES.get(node);
  if (previous !== undefined) return previous;
  SEQUENCE.identity += 1;
  IDENTITIES.set(node, SEQUENCE.identity);
  return SEQUENCE.identity;
}

/**
 * A declaration together with its written argument environment. Re-entering with changed arguments
 * may terminate; the same argument syntax growing around itself is an unresolved cycle.
 */
export function typeBindingKey(
  declaration: GenericDeclaration,
  bindings: ReadonlyMap<TypeParameterDeclaration, TypeReading>,
): string {
  const keys = (declaration.typeParameters ?? []).map((parameter) => {
    const value = bindings.get(parameter);
    return value === undefined ? '' : argumentKey(value);
  });
  return JSON.stringify([identityOf(declaration), keys]);
}

/** A written operand and actual bindings, independent of its expanded-alias path. */
export function typeReadingKey(at: TypeReading): string {
  const keys = [...at.bindings]
    .map(([parameter, value]) => [identityOf(parameter), argumentKey(value)] as const)
    .toSorted(([left], [right]) => left - right);
  return JSON.stringify([identityOf(at.type), keys]);
}

/** An argument's syntax with supplied parameters substituted, stopping repeated syntax on a path. */
function argumentKey(value: TypeReading): string {
  const result: (number | string)[] = [];
  const pending: { node: Node; reading: TypeReading; ancestors: ReadonlySet<Node> }[] = [
    { ancestors: new Set(), node: value.type, reading: value },
  ];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const { node, reading, ancestors } = at;
    if (ancestors.has(node)) {
      result.push('cycle', identityOf(node));
      continue;
    }
    const path = new Set([...ancestors, node]);
    const bound = parameterValue(node, reading);
    if (bound !== undefined) {
      pending.push({ ancestors: path, node: bound.type, reading: bound });
      continue;
    }
    const { key, children } = argumentStructure(node, reading);
    result.push(...key);
    for (const child of children.toReversed()) {
      pending.push({ ancestors: path, ...child });
    }
  }
  return JSON.stringify(result);
}

/** Captured tuples are keyed by their original positions and environments, including rest markers. */
function argumentStructure(
  node: Node,
  reading: TypeReading,
): {
  readonly key: readonly (number | string)[];
  readonly children: readonly { readonly node: Node; readonly reading: TypeReading }[];
} {
  const positions = capturedSequencePositions(node);
  if (positions !== undefined) {
    return {
      children: positions.map(({ reading: value }) => ({ node: value.type, reading: value })),
      key: [
        'captured-sequence',
        node.kind,
        positions.length,
        ...positions.map((position) => {
          if (position.rest) return 'rest';
          return position.optional === true ? 'optional' : 'fixed';
        }),
      ],
    };
  }
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  return {
    children: children.map((child) => ({ node: child, reading })),
    key: [identityOf(node), children.length],
  };
}

/** The actual value of a bare parameter reference, where that reference was written. */
function parameterValue(node: Node, reading: TypeReading): TypeReading | undefined {
  const captured = capturedTypeReading(node);
  if (captured !== undefined) return captured;
  if (!isTypeReferenceNode(node) || !isIdentifier(node.typeName)) return undefined;
  const binding = localTypeBinding(node.typeName);
  return binding !== undefined && binding !== null && isTypeParameterDeclaration(binding)
    ? reading.bindings.get(binding)
    : undefined;
}

const CONSTRAINT_KEY = 'constraint:';

/** The entries of a path that stand for generic parameters whose constraints it has been read through. */
export function constraintKeys(at: TypeReading): string[] {
  return [...at.aliases].filter((key) => key.startsWith(CONSTRAINT_KEY));
}

/** A generic parameter's explicit constraint, with unresolved constraint cycles cut on this path. */
export function constraintReading(
  parameter: TypeParameterDeclaration,
  at: TypeReading,
): TypeReading | undefined {
  const { constraint } = parameter;
  const key = `${CONSTRAINT_KEY}${identityOf(parameter)}`;
  return constraint === undefined || at.aliases.has(key)
    ? undefined
    : { ...at, aliases: new Set([...at.aliases, key]), type: constraint };
}

/** The initial lexical type environment, before following local declarations. */
export function initialTypeReading(type: TypeNode): TypeReading {
  return { aliases: new Set(), bindings: new Map(), type };
}

/**
 * A declaration's parameters bound to caller arguments, or defaults in its own scope. Explicit
 * nested uses and re-entry with changed arguments may be finite; repeated environments, and paths
 * longer than `ALIAS_PATH`, are cycles.
 */
export function boundTypeBody(
  declaration: GenericDeclaration,
  reference: TypeReferenceNode | ExpressionWithTypeArguments,
  at: TypeReading,
): Omit<TypeReading, 'type'> | undefined {
  const aliases = new Set(at.aliases);
  const bindings = new Map(at.bindings);
  const parameters = declaration.typeParameters ?? [];
  for (const [index, parameter] of parameters.entries()) {
    const argument = reference.typeArguments?.[index];
    const value = argument ?? parameter.defaultType;
    if (value === undefined) {
      bindings.delete(parameter);
    } else {
      bindings.set(
        parameter,
        argument === undefined ? { aliases, bindings, type: value } : { ...at, type: argument },
      );
    }
  }
  const key = typeBindingKey(declaration, bindings);
  if (at.aliases.has(key) || at.aliases.size >= ALIAS_PATH.limit) return undefined;
  aliases.add(key);
  return { aliases, bindings };
}
