import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * A native error constructor is the one whichever global object the code reads it of: `globalThis`,
 * `self`, `window`, Node's `global`, one of them of another (`globalThis.self.Error`), as the code's
 * own reading of a global strips them (`globalPathOf`). A constant that holds `new self.Error()`, a
 * `typeof` of the prototype and `InstanceType` of the constructor read as the `Error` they are, as
 * they do for `globalThis.Error`, whichever of the four the code writes: the browser's names
 * `self` and `window` are undefined in Node, whose `global` the browser lacks, and a name the
 * runtime lacks throws a `ReferenceError` where it is read, so what such code holds is an error all
 * the same. A name a declaration in scope gives is that declaration's, not the global object; an
 * assertion keeps the construction opaque, as it does for `globalThis`. The rows marked a pin
 * answer the same before the change as after it.
 */

const OBJECTS = ['globalThis', 'self', 'window', 'global'] as const;

const CASES = [
  ...OBJECTS.map((object) => {
    return {
      id: `constant-of-${object}-error`,
      names: true,
      source: `const e = new ${object}.Error();`,
      type: 'typeof e',
    };
  }),
  ...OBJECTS.map((object) => {
    return {
      id: `constant-of-parenthesized-${object}-error`,
      names: true,
      source: `const e = new (${object}.Error)();`,
      type: 'typeof e',
    };
  }),
  ...OBJECTS.map((object) => {
    return {
      id: `constant-of-${object}-error-called`,
      names: true,
      source: `const e = ${object}.TypeError('x');`,
      type: 'typeof e',
    };
  }),
  ...OBJECTS.map((object) => {
    return {
      id: `constant-of-an-alias-of-${object}-error`,
      names: true,
      source: `const C = ${object}.RangeError; const e = new C();`,
      type: 'typeof e',
    };
  }),
  ...OBJECTS.map((object) => {
    return {
      id: `prototype-of-${object}-error`,
      names: true,
      source: '',
      type: `typeof ${object}.Error.prototype`,
    };
  }),
  ...OBJECTS.map((object) => {
    return {
      id: `instance-of-${object}-error`,
      names: true,
      source: '',
      type: `InstanceType<typeof ${object}.Error>`,
    };
  }),
  {
    id: 'constant-of-a-global-object-of-another',
    names: true,
    source: 'const e = new globalThis.self.Error();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-three-global-objects',
    names: true,
    source: 'const e = new window.globalThis.self.TypeError();',
    type: 'typeof e',
  },
  {
    id: 'prototype-of-a-global-object-of-another',
    names: true,
    source: '',
    type: 'typeof self.window.Error.prototype',
  },
  {
    id: 'instance-of-a-global-object-of-another',
    names: true,
    source: '',
    type: 'InstanceType<typeof window.global.Error>',
  },
  {
    id: 'constant-of-self-error-beside-data',
    names: true,
    source: 'const e = new self.Error();',
    type: 'typeof e | string',
  },
  {
    id: 'constant-of-a-global-error-of-the-global-object-pin',
    names: true,
    source: 'const e = new globalThis.Error();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-a-bare-error-pin',
    names: true,
    source: 'const e = new Error();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-self-data-constructor-pin',
    names: false,
    source: 'const e = new self.Map();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-an-unknown-member-of-self-pin',
    names: false,
    source: 'const e = new self.Foo();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-a-member-of-a-local-object-pin',
    names: false,
    source: 'const other = { Error: class {} }; const e = new other.Error();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-a-self-a-constant-names-pin',
    names: false,
    source: 'const self = { Error: class {} }; const e = new self.Error();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-a-window-a-declaration-gives-pin',
    names: false,
    source:
      'declare const window: { Error: new () => { stack: string } }; const e = new window.Error();',
    type: 'typeof e',
  },
  {
    id: 'prototype-of-a-self-a-declaration-gives-pin',
    names: false,
    source: 'declare const self: { Error: { prototype: { stack: string } } };',
    type: 'typeof self.Error.prototype',
  },
  {
    id: 'instance-of-a-global-a-declaration-gives-pin',
    names: false,
    source: 'declare const global: { Error: new () => { stack: string } };',
    type: 'InstanceType<typeof global.Error>',
  },
  {
    id: 'prototype-of-self-data-constructor-pin',
    names: false,
    source: '',
    type: 'typeof self.Map.prototype',
  },
  {
    id: 'constant-of-an-asserted-self-error-is-opaque-pin',
    names: false,
    source: 'const e = new (self.Error as ErrorConstructor)();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-an-asserted-global-object-error-is-opaque-pin',
    names: false,
    source: 'const e = new (globalThis.Error as ErrorConstructor)();',
    type: 'typeof e',
  },
  {
    id: 'constant-of-a-self-error-by-a-key-is-opaque-pin',
    names: false,
    source: 'const e = new self["Error"]();',
    type: 'typeof e',
  },
] as const;

describe('a native error constructor read of any global object', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `type`, a parameter's type written after `source`, names an error of the rows. */
  function namesError(source: string, type: string): boolean {
    using parsed = api.createSourceFile(
      'global-objects.ts',
      `${source}\nfunction frames(probe: ${type}) { return probe; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberType(written, [], new Set(['Error', 'RangeError', 'TypeError']));
  }

  it.each(CASES)('$id', ({ names, source, type }) => {
    expect(namesError(source, type)).toBe(names);
  });
});
