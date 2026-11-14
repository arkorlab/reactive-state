import { isTypeReferenceNode, type Node, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { receiverUtilityReading } from '../src/compiler/local-type-receivers.ts';

/**
 * `ThisParameterType` infers from the last call signature of what it is given, as TypeScript lists
 * them: an interface's own, then each of its bases' in turn, and an intersection's members' in
 * order. Where the last of them is one the reader cannot read — of a base it reads as nothing, an
 * import's — the receiver is not read: TypeScript's answer is that base's. One the reader reads that
 * follows such a base is still the last; where none follows, a signature written outside interfaces
 * keeps the reading it gives, as `Parameters` and `InstanceType` read it.
 */

const OPAQUE = 'type Base = import("./external.js").Base;\ntype Data = { stack: string };';

const CASES = [
  {
    receiver: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { (this: Error): void }\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'an own signature before a base it reads as nothing',
  },
  {
    receiver: undefined,
    source: `import type { Base } from "./external.js";\ninterface Maker extends Base { (this: Error): void }\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'an own signature before an imported base',
  },
  {
    receiver: undefined,
    source: `${OPAQUE}\ninterface Known { (this: Error): void }\ninterface Maker extends Known, Base {}\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'a base it reads before one it reads as nothing',
  },
  {
    receiver: undefined,
    source: `${OPAQUE}\ninterface Fields { stack: string }\ninterface Maker extends Base, Fields { (this: Error): void }\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'a base of no signature after one it reads as nothing',
  },
  {
    receiver: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (this: Data): void }\ntype Receiver = ThisParameterType<{ (this: Error): void } & Maker>;`,
    what: 'a written signature before an interface it cannot read',
  },
  {
    receiver: undefined,
    source: `${OPAQUE}\ninterface Maker extends Base { (this: Data): void }\ninterface Known { (this: Error): void }\ntype Receiver = ThisParameterType<Known & Maker>;`,
    what: 'an interface it reads before one it cannot read',
  },
  {
    receiver: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (this: Data): void }\ntype Receiver = ThisParameterType<Maker & { (this: Error): void }>;`,
    what: 'a written signature after an interface it cannot read',
  },
  {
    receiver: 'Error',
    source: `${OPAQUE}\ninterface Maker extends Base { (this: Data): void }\ninterface Known { (this: Error): void }\ntype Receiver = ThisParameterType<Maker & Known>;`,
    what: 'an interface it reads after one it cannot read',
  },
  {
    receiver: 'Error',
    source: `${OPAQUE}\ninterface Known { (this: Error): void }\ninterface Maker extends Base, Known {}\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'a base it reads after one it reads as nothing',
  },
  {
    receiver: 'Data',
    source: `${OPAQUE}\ninterface Known { (this: Data): void }\ninterface Maker extends Known { (this: Error): void }\ntype Receiver = ThisParameterType<Maker>;`,
    what: 'an inherited signature after an own one',
  },
] as const;

describe('the receiver of an interface whose bases are read as nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The receiver type `receiverUtilityReading` reads of the source's `ThisParameterType`. */
  function receiverOf(source: string): string | undefined {
    using parsed = api.createSourceFile('receivers.ts', source);
    const { sourceFile } = parsed;
    let argument: TypeNode | undefined;
    const visit = (node: Node): void => {
      if (isTypeReferenceNode(node) && node.typeName.getText(sourceFile) === 'ThisParameterType') {
        argument = node.typeArguments?.[0];
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (argument === undefined) {
      throw new Error('The source holds no ThisParameterType of an argument.');
    }
    const receiver = receiverUtilityReading(initialTypeReading(argument), (reading) => [reading]);
    return receiver?.type.getText(sourceFile);
  }

  it.each(CASES)('of $what', ({ receiver, source }) => {
    expect(receiverOf(source)).toBe(receiver);
  });
});
