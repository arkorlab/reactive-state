import { isTypeReferenceNode, type Node, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { instanceUtilityReading } from '../src/compiler/local-type-instance-utilities.ts';

/**
 * `InstanceType` infers from the last construct signature of what it is given, as TypeScript lists
 * them: an interface's own, then each of its bases' in turn, and an intersection's members' in order.
 * A signature the reader reads after a base it reads as nothing, an import's, is still the last: an
 * interface after it in an intersection, or a base after it. Where none follows that base, the written
 * signatures outside interfaces keep the reading they give.
 */

const OPAQUE = 'type Base = import("./external.js").Base;\ntype Data = { stack: string };';

const CASES = [
  {
    instance: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { new (): Error }\ntype Selected = InstanceType<Maker>;`,
    what: 'an own signature before a base it reads as nothing',
  },
  {
    instance: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { new (): Data }\ntype Selected = InstanceType<Maker & { new (): Error }>;`,
    what: 'a written signature after an interface it cannot read',
  },
  {
    instance: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { new (): Data }\ntype Selected = InstanceType<{ new (): Error } & Maker>;`,
    what: 'a written signature before an interface it cannot read',
  },
  {
    instance: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { new (): Data }\ninterface Known { new (): Error }\ntype Selected = InstanceType<Known & Maker>;`,
    what: 'an interface it reads before one it cannot read',
  },
  {
    instance: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { new (): Data }\ninterface Known { new (): Error }\ntype Selected = InstanceType<Maker & Known>;`,
    what: 'an interface it reads after one it cannot read',
  },
  {
    instance: 'Error',
    source: `${OPAQUE}\ninterface Known { new (): Error }\ninterface Maker extends Base, Known {}\ntype Selected = InstanceType<Maker>;`,
    what: 'a base it reads after one it reads as nothing',
  },
  {
    instance: undefined,
    source: `${OPAQUE}\ninterface Known { new (): Error }\ninterface Maker extends Known, Base {}\ntype Selected = InstanceType<Maker>;`,
    what: 'a base it reads before one it reads as nothing',
  },
  {
    instance: 'Data',
    source: `${OPAQUE}\ninterface Known { new (): Data }\ninterface Maker extends Known { new (): Error }\ntype Selected = InstanceType<Maker>;`,
    what: 'an inherited signature after an own one',
  },
] as const;

describe('the instance of an interface whose bases are read as nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The instance type `instanceUtilityReading` reads of the source's `InstanceType`. */
  function instanceOf(source: string): string | undefined {
    using parsed = api.createSourceFile('instances.ts', source);
    const { sourceFile } = parsed;
    let argument: TypeNode | undefined;
    const visit = (node: Node): void => {
      if (isTypeReferenceNode(node) && node.typeName.getText(sourceFile) === 'InstanceType') {
        argument = node.typeArguments?.[0];
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (argument === undefined) {
      throw new Error('The source holds no InstanceType of an argument.');
    }
    const instance = instanceUtilityReading(initialTypeReading(argument), (reading) => [reading]);
    return instance?.type.getText(sourceFile);
  }

  it.each(CASES)('of $what', ({ instance, source }) => {
    expect(instanceOf(source)).toBe(instance);
  });
});
