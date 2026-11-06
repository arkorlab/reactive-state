import { isTypeReferenceNode, type Node, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capturedSequencePositions } from '../src/compiler/local-type-captured-sequences.ts';
import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { parameterUtilityReading } from '../src/compiler/local-type-parameter-utilities.ts';

/**
 * `Parameters` and `ConstructorParameters` infer from the last matching signature of what they are
 * given, as TypeScript lists them: an interface's own, then each of its bases' in turn, and an
 * intersection's members' in order. A signature the reader reads after a base it reads as nothing,
 * an import's, is still the last: an interface after it in an intersection, or a base after it. Where
 * none follows that base, the written signatures outside interfaces keep the reading they give.
 */

const OPAQUE = 'type Base = import("./external.js").Base;\ntype Data = { stack: string };';

const CASES = [
  {
    first: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Error): void }\ntype Selected = Parameters<Maker>;`,
    what: 'an own signature before a base it reads as nothing',
  },
  {
    first: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Data): void }\ntype Selected = Parameters<Maker & { (value: Error): void }>;`,
    what: 'a written signature after an interface it cannot read',
  },
  {
    first: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Data): void }\ntype Selected = Parameters<{ (value: Error): void } & Maker>;`,
    what: 'a written signature before an interface it cannot read',
  },
  {
    first: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Data): void }\ninterface Known { (value: Error): void }\ntype Selected = Parameters<Known & Maker>;`,
    what: 'an interface it reads before one it cannot read',
  },
  {
    first: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Data): void }\ninterface Known { (value: Error): void }\ntype Selected = Parameters<Maker & Known>;`,
    what: 'an interface it reads after one it cannot read',
  },
  {
    first: 'Error',
    source: `${OPAQUE}\ninterface Known { (value: Error): void }\ninterface Maker extends Base, Known {}\ntype Selected = Parameters<Maker>;`,
    what: 'a base it reads after one it reads as nothing',
  },
  {
    first: undefined,
    source: `${OPAQUE}\ninterface Known { (value: Error): void }\ninterface Maker extends Known, Base {}\ntype Selected = Parameters<Maker>;`,
    what: 'a base it reads before one it reads as nothing',
  },
  {
    first: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { (value: Data): void }\ntype Selected = Parameters<{ (value: Error): void } & Maker & { (value): void }>;`,
    what: 'an untyped signature after an interface it cannot read',
  },
  {
    first: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { new (value: Data): unknown }\ninterface Known { new (value: Error): unknown }\ntype Selected = ConstructorParameters<Maker & Known>;`,
    what: 'a construct signature it reads after an interface it cannot read',
  },
  {
    first: 'Data',
    source: `${OPAQUE}\ninterface Known { (value: Data): void }\ninterface Maker extends Known { (value: Error): void }\ntype Selected = Parameters<Maker>;`,
    what: 'an inherited signature after an own one',
  },
] as const;

describe('the parameters of an interface whose bases are read as nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The first parameter's type `parameterUtilityReading` reads of the source's utility. */
  function firstOf(source: string): string | undefined {
    using parsed = api.createSourceFile('parameters.ts', source);
    const { sourceFile } = parsed;
    let utility: { name: 'ConstructorParameters' | 'Parameters'; argument: TypeNode } | undefined;
    const visit = (node: Node): void => {
      const name = isTypeReferenceNode(node) ? node.typeName.getText(sourceFile) : undefined;
      const argument = isTypeReferenceNode(node) ? node.typeArguments?.[0] : undefined;
      if (argument !== undefined && (name === 'Parameters' || name === 'ConstructorParameters')) {
        utility = { argument, name };
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (utility === undefined) {
      throw new Error('The source holds no parameter utility of an argument.');
    }
    const tuple = parameterUtilityReading(
      initialTypeReading(utility.argument),
      utility.name,
      (reading) => [reading],
    );
    if (tuple === undefined) return undefined;
    const [first] = capturedSequencePositions(tuple.type) ?? [];
    return first?.reading.type.getText(sourceFile);
  }

  it.each(CASES)('of $what', ({ first, source }) => {
    expect(firstOf(source)).toBe(first);
  });
});
