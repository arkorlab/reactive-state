import {
  type Identifier,
  isIdentifier,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readsOf } from '../src/compiler/local-module-reads.ts';

/**
 * A constant of the module is read where the code names it and no scope around the read declares
 * the name again: a namespace's body is one, as a function's is. What the body declares — a
 * constant, a function, a `var` of one of its blocks, what the bodies it merges with export —
 * hides the module's constant from its reads, and what it keeps from another namespace's does not.
 */

const CASES = [
  {
    lines: ['namespace Inner {', '  const cache = {};', '  cache.changed = true;', '}'],
    reads: [],
    what: 'a namespace that declares a constant of the name',
  },
  {
    lines: ['namespace Inner {', '  function cache() {}', '  cache.changed = true;', '}'],
    reads: [],
    what: 'a namespace that declares a function of the name',
  },
  {
    lines: [
      'namespace Inner {',
      '  {',
      '    var cache = {};',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: [],
    what: 'a namespace that declares a var of the name in a block',
  },
  {
    lines: [
      'namespace Inner {',
      '  export const cache = {};',
      '}',
      'namespace Inner {',
      '  cache.changed = true;',
      '}',
    ],
    reads: [],
    what: 'a namespace of which a merged body exports the name',
  },
  {
    lines: [
      'namespace Outer {',
      '  export namespace Inner {',
      '    export function read() {',
      '      return cache.changed;',
      '    }',
      '  }',
      '  const cache = {};',
      '}',
    ],
    reads: [],
    what: 'a namespace nested in one that declares the name',
  },
  {
    lines: ['namespace Inner {', '  cache.changed = true;', '}'],
    reads: ['3:cache'],
    what: 'a namespace that declares no such name',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache {',
      '    export type T = string;',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: ['6:cache'],
    what: 'a namespace of a type alone, which declares no value',
  },
  {
    lines: ['namespace Inner {', '  namespace cache {}', '  cache.changed = true;', '}'],
    reads: ['4:cache'],
    what: 'an empty namespace',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache {',
      '    export interface I {}',
      '    export namespace Deep {',
      '      export type U = 1;',
      '    }',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: ['9:cache'],
    what: 'a namespace of an interface and of a namespace of types',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache.Deep {',
      '    export type U = 1;',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: ['6:cache'],
    what: 'a namespace of a dotted name that holds types alone',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache {',
      '    export const x = 1;',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: [],
    what: 'a namespace that declares a value of its own',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache {',
      '    export type T = string;',
      '    export enum E {',
      '      a,',
      '    }',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: [],
    what: 'a namespace of a type and an enum',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace cache {',
      '    export namespace Deep {',
      '      export const x = 1;',
      '    }',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: [],
    what: 'a namespace of a namespace that declares a value',
  },
  {
    lines: [
      'namespace Other {',
      '  const cache = {};',
      '  void cache;',
      '}',
      'namespace Inner {',
      '  cache.changed = true;',
      '}',
    ],
    reads: ['7:cache'],
    what: 'a namespace beside another that declares the name',
  },
  {
    lines: [
      'namespace Other {',
      '  const cache = {};',
      '  void cache;',
      '}',
      'cache.changed = true;',
    ],
    reads: ['6:cache'],
    what: 'the module, beside a namespace that declares the name',
  },
  {
    lines: [
      'namespace Inner {',
      '  export function run(cache: object) {',
      '    return cache;',
      '  }',
      '  cache.changed = true;',
      '}',
    ],
    reads: ['6:cache'],
    what: 'a namespace beside a function of it with a parameter of the name',
  },
] as const;

/** The constant `cache` the module `sourceFile` declares first, and each read of the name. */
function cacheOf(sourceFile: SourceFile): { declared: Identifier; named: readonly Identifier[] } {
  let declared: Identifier | undefined;
  const named: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && node.text === 'cache') {
      if (declared === undefined && isVariableDeclaration(node.parent)) {
        declared = node;
      } else {
        named.push(node);
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (declared === undefined) {
    throw new Error('No constant `cache` is declared.');
  }
  return { declared, named };
}

describe('a constant of the module read in a namespace that declares the name again', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The lines, `line:cache`, of the reads of the module's constant `cache` that `readsOf` takes. */
  function readsOfCache(lines: readonly string[]): readonly string[] {
    const source = ['const cache = {};', ...lines, ''].join('\n');
    using parsed = api.createSourceFile('reads.ts', source);
    const { sourceFile } = parsed;
    const { declared, named } = cacheOf(sourceFile);
    const isRead = readsOf(declared, sourceFile);

    return named
      .filter((each) => isRead(each))
      .map((each) => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(each.getStart(sourceFile));
        return `${String(line + 1)}:${each.text}`;
      });
  }

  it.each(CASES)('takes the reads of the constant in $what', ({ lines, reads }) => {
    expect(readsOfCache(lines)).toStrictEqual(reads);
  });
});
