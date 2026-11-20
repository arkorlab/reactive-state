import { isImportDeclaration } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ImportLine, importDeclarations, readImports } from '../src/compiler/imports.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly expected: readonly string[];
  readonly id: string;
  readonly source: readonly string[];
}

/**
 * A type-only import is erased, so the modules an output imports are evaluated in the order of the
 * runtime imports alone: a module is placed where its first runtime import stands, not where a
 * type-only import of it stood first.
 */
const CASES: readonly Case[] = [
  {
    expected: ["import { y } from 'b';", "import { x } from 'a';", "import type { T } from 'a';"],
    id: 'type-import-before-another-modules-runtime-import',
    source: ["import type { T } from 'a';", "import { y } from 'b';", "import { x } from 'a';"],
  },
  {
    expected: ["import { y } from 'b';", "import { x } from 'a';", "import type { T } from 'a';"],
    id: 'inline-type-specifier-before-another-modules-runtime-import',
    source: ["import { type T } from 'a';", "import { y } from 'b';", "import { x } from 'a';"],
  },
  {
    expected: [
      "import { y } from 'b';",
      "import * as ns from 'a';",
      "import type Default from 'a';",
    ],
    id: 'type-default-before-another-modules-runtime-and-a-namespace',
    source: ["import type Default from 'a';", "import { y } from 'b';", "import * as ns from 'a';"],
  },
  {
    expected: [
      "import { y } from 'b';",
      "import type { B } from 'b';",
      "import { x } from 'a';",
      "import type { A } from 'a';",
    ],
    id: 'two-modules-typed-first-then-run-in-the-other-order',
    source: [
      "import type { A } from 'a';",
      "import type { B } from 'b';",
      "import { y } from 'b';",
      "import { x } from 'a';",
    ],
  },
  {
    expected: ["import type { T } from 'c';", "import { y } from 'b';"],
    id: 'type-only-module-keeps-its-place-pin',
    source: ["import type { T } from 'c';", "import { y } from 'b';"],
  },
  {
    expected: ["import { x } from 'a';", "import type { T } from 'a';", "import { y } from 'b';"],
    id: 'runtime-import-before-type-import-of-the-same-module-pin',
    source: ["import { x } from 'a';", "import { y } from 'b';", "import type { T } from 'a';"],
  },
  {
    expected: ["import { x, z } from 'a';", "import { y } from 'b';"],
    id: 'later-runtime-import-of-a-module-keeps-its-first-place-pin',
    source: ["import { x } from 'a';", "import { y } from 'b';", "import { z } from 'a';"],
  },
];

describe('the order an output imports modules in', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Emits the import declarations read from `entry.source`, one line for each binding. */
  function declarationsFor(entry: Case): readonly string[] {
    using parsed = parseModule(api, 'runtime-import-order.ts', entry.source.join('\n'));
    const declarations = parsed.sourceFile.statements.filter((each) => isImportDeclaration(each));
    const { modules } = readImports(
      declarations,
      parsed.sourceFile,
      () => ({ file: undefined, id: undefined, kind: 'package' }),
      (reason) => {
        throw new Error(reason);
      },
    );
    const lines: ImportLine[] = modules.flatMap((module) => {
      return module.bindings.map((binding) => {
        return {
          binding,
          from: module.written,
          typeOnly: binding.typeOnly,
        };
      });
    });
    return importDeclarations(lines);
  }

  it.each(CASES)('$id', (entry) => {
    expect(declarationsFor(entry)).toStrictEqual(entry.expected);
  });
});
