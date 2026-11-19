import {
  isClassDeclaration,
  isIdentifier,
  isInferTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { localTypeBinding } from '../src/compiler/local-type-aliases.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the class merged with an error interface', () => {
  it.each([
    'interface Failure {} class Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'class Failure extends Error {} interface Failure {} function read(error: Failure) { return error.stack; }',
    'function within() { interface Failure {} class Failure extends Error {} function read(error: Failure) { return error.stack; } }',
    'switch (value) { case 0: interface Failure {} break; default: class Failure extends Error {} function read(error: Failure) { return error.stack; } }',
    'declare namespace Types { interface Failure {} class Failure extends Error {} } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { export interface Failure {} export class Failure extends Error {} } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { interface Failure {} } declare namespace Types { class Failure extends Error {} } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { interface Failure {} } declare namespace Types { class Failure extends Error {} type Alias = Failure } function read(error: Types.Alias) { return error.stack; }',
  ])('retains the class base in either declaration order: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'merged-error-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'interface Failure { stack: string } function read(error: Failure) { return error.stack; }',
    'interface Failure {} class Failure { stack = "data"; } function read(error: Failure) { return error.stack; }',
    'class Failure { stack = "data"; } interface Failure {} function read(error: Failure) { return error.stack; }',
    'class Failure extends Error {} function within() { interface Failure { stack: string } function read(error: Failure) { return error.stack; } }',
    'interface Failure {} class Failure extends Error {} function read<Failure extends { stack: string }>(error: Failure) { return error.stack; }',
    'import type { Failure } from "./data.ts"; function read(error: Failure) { return error.stack; }',
    'declare namespace Types { interface Failure {} class Failure { stack: string } } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { class Failure extends Error {} } namespace Inner { export namespace Types { export interface Failure { stack: string } } function read(error: Types.Failure) { return error.stack; } }',
    'import type * as Types from "./data.ts"; function read(error: Types.Failure) { return error.stack; }',
  ])('preserves data classes and nearer opaque bindings: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'merged-data-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });
});

describe('the type parameters a conditional infers', () => {
  it.each([
    'type Wrapped<T> = T extends infer Inferred ? Inferred : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Error ? Error : never; function read(error: Wrapped<TypeError>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred ? (Inferred extends infer Inferred ? Inferred : never) : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Identity<T> = T; type Wrapped<T> = T extends infer Inferred ? Identity<Inferred> : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends (infer Inferred) ? Inferred : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred extends Error ? Inferred : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Inferred = Error; type Wrapped<T> = T extends infer Inferred extends string ? { stack: string } : Inferred; function read(error: Wrapped<number>) { return error.stack; }',
    'type Inferred = Error; type Wrapped<T> = T extends infer Inferred ? Inferred : never; function read(error: Wrapped<Inferred>) { return error.stack; }',
  ])('retains an error carried by an inferred parameter: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inferred-error-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'type Wrapped<T> = T extends infer Inferred ? Inferred : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Error ? Error : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Inferred = Error; type Wrapped<T> = T extends infer Inferred ? Inferred : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred ? ({ stack: string } extends infer Inferred ? Inferred : never) : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends (infer Error) ? Error : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred extends string ? Inferred : { stack: string }; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred extends string ? { stack: string } : Error; function read(error: Wrapped<"data">) { return error.stack; }',
    'type Wrapped<T> = T extends infer Inferred ? Inferred : never; function within() { type Error = { stack: string }; function read(error: Wrapped<Error>) { return error.stack; } }',
  ])('preserves inferred data and inner inference shadows: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inferred-data-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });

  it.each([
    {
      source: 'type Wrapped<T> = T extends infer Inferred ? Inferred : never;',
      bindings: ['infer:0'],
    },
    {
      source:
        'type Inferred = string; type Wrapped<T> = T extends infer Inferred ? Inferred : Inferred;',
      bindings: ['infer:0', 'alias'],
    },
    {
      source:
        'type Inferred = string; type Wrapped<T> = Inferred extends infer Inferred ? Inferred : Inferred;',
      bindings: ['alias', 'infer:0', 'alias'],
    },
    {
      source:
        'type Inferred = string; type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : Inferred;',
      bindings: ['infer:0', 'alias'],
    },
    {
      source:
        'type Wrapped<T> = T extends infer Inferred ? (T extends infer Inferred ? Inferred : Inferred) : never;',
      bindings: ['infer:1', 'infer:0'],
    },
    {
      source:
        'type Inferred = string; type Wrapped<T> = T extends (T extends infer Inferred ? Inferred : never) ? Inferred : never;',
      bindings: ['infer:0', 'alias'],
    },
    {
      source:
        'type Wrapped<T> = T extends infer Inferred ? <Inferred>(value: Inferred) => Inferred : never;',
      bindings: ['parameter', 'parameter'],
    },
    {
      source:
        'type Wrapped<T> = T extends infer Inferred ? (Inferred extends unknown ? Inferred : never) : never;',
      bindings: ['infer:0', 'infer:0'],
    },
    {
      source: 'type Wrapped<T> = T extends infer Inferred ? string : Inferred;',
      bindings: ['unbound'],
    },
    {
      source:
        'type Wrapped<T> = T extends infer Inferred ? Inferred : never; type Outside = Inferred;',
      bindings: ['infer:0', 'unbound'],
    },
  ])('resolves inference in its conditional true branch: $source', ({ source, bindings }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inferred-type-bindings.ts', source);
    const nodes = nodesOf(parsed.sourceFile);
    const inferred = nodes.filter((node) => isInferTypeNode(node));
    const actual = nodes.flatMap((node) => {
      if (
        !isTypeReferenceNode(node) ||
        !isIdentifier(node.typeName) ||
        node.typeName.text !== 'Inferred'
      ) {
        return [];
      }
      const binding = localTypeBinding(node.typeName);
      if (binding === undefined) return ['unbound'];
      if (binding === null) return ['opaque'];
      if (isTypeAliasDeclaration(binding)) return ['alias'];
      if (isClassDeclaration(binding)) return ['class'];
      if (isTypeParameterDeclaration(binding) && isInferTypeNode(binding.parent)) {
        return [`infer:${inferred.indexOf(binding.parent)}`];
      }
      return ['parameter'];
    });

    expect(actual).toStrictEqual(bindings);
  });
});

/** The source's nodes in the order they were written. */
function nodesOf(root: Node): Node[] {
  const nodes: Node[] = [];
  const pending = [root];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    nodes.push(at);
    const children: Node[] = [];
    at.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return nodes;
}

/** Whether the source reads engine error frames. */
function readsFrames(root: Node): boolean {
  return nodesOf(root).some(
    (node) => framedRead(node)?.includes('reads `stack` of an error') === true,
  );
}
