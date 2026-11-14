import {
  type ClassDeclaration,
  isClassDeclaration,
  isExpressionWithTypeArguments,
  isTypeQueryNode,
  isTypeReferenceNode,
  type Node,
  type SourceFile,
  SyntaxKind,
  type TypeQueryNode,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { instanceUtilityReading } from '../src/compiler/local-type-instance-utilities.ts';

/**
 * `InstanceType` of a class query, `typeof Box`, as TypeScript infers it: of a construct signature
 * whose own parameters are the class's, closed at each one's constraint, or `unknown` — never at a
 * default, which only a written reference to the class, `Box`, takes. So a class of
 * `T extends Error | string = string` holds `Error | string` here, as a written constructor's own
 * parameters do; an instantiation, `typeof Box<Error>`, keeps what it is given.
 */

const CASES = [
  {
    bindings: ['T: unknown'],
    source:
      'class Box<T = string> extends Map<string, T> {}\ntype Failure = InstanceType<typeof Box>;',
    what: 'a default',
  },
  {
    bindings: ['T: Error | string'],
    source:
      'class Box<T extends Error | string = string> extends Map<string, T> {}\ntype Failure = InstanceType<typeof Box>;',
    what: 'a constraint beside a default',
  },
  {
    bindings: ['T: unknown', 'U: T[] (T: unknown)'],
    source:
      'class Box<T, U extends T[] = T[]> extends Map<string, U> {}\ntype Failure = InstanceType<typeof Box>;',
    what: 'a constraint of an earlier parameter',
  },
  {
    bindings: ['T: Error | string'],
    source:
      'class Box<T extends Error | string = string> extends Map<string, T> {}\nconst Raised = Box;\ntype Failure = InstanceType<typeof Raised>;',
    what: 'a constant of the class',
  },
  {
    bindings: ['T: Error'],
    source:
      'class Box<T extends Error | string = string> extends Map<string, T> {}\ntype Failure = InstanceType<typeof Box<Error>>;',
    what: 'an instantiation',
  },
  {
    bindings: [],
    source: 'class Box extends Map<string, Error> {}\ntype Failure = InstanceType<typeof Box>;',
    what: 'no parameter',
  },
] as const;

describe('the instance InstanceType reads of a class query', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * Each parameter of the class as the body of the instance `instanceUtilityReading` reads binds it,
   * with what the parameters before it are where that binding is read.
   */
  function bindingsOf(source: string): readonly string[] {
    using parsed = api.createSourceFile('instance.ts', source);
    const { sourceFile } = parsed;
    const nodes: Node[] = [];
    const visit = (node: Node): void => {
      nodes.push(node);
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    const declaration = nodes.find((node): node is ClassDeclaration => isClassDeclaration(node));
    const query = nodes.find(
      (node): node is TypeQueryNode => isTypeQueryNode(node) && isTypeReferenceNode(node.parent),
    );
    if (declaration === undefined || query === undefined) {
      throw new Error('The source holds no class, or no InstanceType of a class query.');
    }
    const instance = instanceUtilityReading(initialTypeReading(query), (reading) => [reading]);
    if (instance === undefined || !isExpressionWithTypeArguments(instance.type)) {
      throw new Error('InstanceType of the class query reads no class.');
    }
    const bound = boundTypeBody(declaration, instance.type, instance);
    const parameters = declaration.typeParameters ?? [];
    return parameters.map((parameter, index) => {
      const value = bound?.bindings.get(parameter);
      const before = parameters
        .slice(0, index)
        .map((each) => `${each.name.text}: ${textOf(value?.bindings.get(each), sourceFile)}`);
      const scope = before.length === 0 ? '' : ` (${before.join(', ')})`;
      return `${parameter.name.text}: ${textOf(value, sourceFile)}${scope}`;
    });
  }

  it.each(CASES)('binds the class of $what', ({ bindings, source }) => {
    expect(bindingsOf(source)).toStrictEqual(bindings);
  });
});

/** A reading's type as written, `unknown` as the reader writes it, or `unbound` for none. */
function textOf(reading: TypeReading | undefined, sourceFile: SourceFile): string {
  if (reading === undefined) return 'unbound';
  return reading.type.kind === SyntaxKind.UnknownKeyword
    ? 'unknown'
    : reading.type.getText(sourceFile);
}
