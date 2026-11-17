import { isImportDeclaration } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ImportLine, importDeclarations, readImports } from '../src/compiler/imports.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly id: string;
  readonly source: string;
  readonly renames?: Readonly<Record<string, readonly string[]>>;
  readonly alsoTyped?: readonly string[];
  readonly expected: readonly string[];
}

/**
 * Each type-only default or namespace import stands on its own `import type` declaration so
 * multiple bindings from one module neither drop later namespaces nor mix default and `{ ... }`.
 */
const CASES: readonly Case[] = [
  {
    expected: [
      "import type * as First from 'some-package';",
      "import type * as Second from 'some-package';",
    ],
    id: 'two-type-namespace-bindings',
    source: [
      "import type * as First from 'some-package';",
      "import type * as Second from 'some-package';",
    ].join('\n'),
  },
  {
    expected: ["import type First from 'some-package';", "import type Second from 'some-package';"],
    id: 'two-type-default-bindings',
    source: [
      "import type First from 'some-package';",
      "import type Second from 'some-package';",
    ].join('\n'),
  },
  {
    expected: [
      "import type First1 from 'some-package';",
      "import type First2 from 'some-package';",
    ],
    id: 'renamed-type-default-bindings',
    renames: { First: ['First1', 'First2'] },
    source: "import type First from 'some-package';",
  },
  {
    expected: [
      "import type * as Ns1 from 'some-package';",
      "import type * as Ns2 from 'some-package';",
    ],
    id: 'renamed-type-namespace-bindings',
    renames: { Ns: ['Ns1', 'Ns2'] },
    source: "import type * as Ns from 'some-package';",
  },
  {
    expected: [
      "import RunDefault, { runValue } from 'some-package';",
      "import * as RunNs from 'some-package';",
      "import type First from 'some-package';",
      "import type Second from 'some-package';",
      "import type * as TypeNsA from 'some-package';",
      "import type * as TypeNsB from 'some-package';",
      "import type { Alpha, Beta as LocalBeta } from 'some-package';",
    ],
    id: 'mixed-runtime-and-multiple-type-forms',
    source: [
      "import RunDefault, { runValue } from 'some-package';",
      "import * as RunNs from 'some-package';",
      "import type First from 'some-package';",
      "import type Second from 'some-package';",
      "import type * as TypeNsA from 'some-package';",
      "import type * as TypeNsB from 'some-package';",
      "import type { Alpha, Beta as LocalBeta } from 'some-package';",
    ].join('\n'),
  },
  {
    expected: [
      "import * as Third from 'some-package';",
      "import type * as First from 'some-package';",
      "import type * as Second from 'some-package';",
    ],
    id: 'runtime-namespace-with-two-type-namespaces',
    source: [
      "import * as Third from 'some-package';",
      "import type * as First from 'some-package';",
      "import type * as Second from 'some-package';",
    ].join('\n'),
  },
  {
    expected: ["import type * as Ns from 'some-package';"],
    id: 'duplicate-same-local-type-namespace-pin',
    renames: { Ns: ['Ns', 'Ns'] },
    source: "import type * as Ns from 'some-package';",
  },
  {
    alsoTyped: ['Shared'],
    expected: ["import Shared from 'some-package';", "import type Other from 'some-package';"],
    id: 'runtime-binding-omits-matching-type-binding-pin',
    source: ["import Shared from 'some-package';", "import type Other from 'some-package';"].join(
      '\n',
    ),
  },
  {
    expected: ["import type * as React from 'react';", "import type { ReactNode } from 'react';"],
    id: 'single-type-namespace-before-type-named-pin',
    source: [
      "import type * as React from 'react';",
      "import type { ReactNode } from 'react';",
    ].join('\n'),
  },
  {
    expected: [
      "import First, { default as Second } from 'some-package';",
      "import * as NsA from 'some-package';",
      "import * as NsB from 'some-package';",
    ],
    id: 'two-runtime-defaults-and-two-runtime-namespaces-pin',
    source: [
      "import First from 'some-package';",
      "import Second from 'some-package';",
      "import * as NsA from 'some-package';",
      "import * as NsB from 'some-package';",
    ].join('\n'),
  },
];

describe('type-only import declaration emission', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Emits the import lines read from `entry.source` with optional derived local renames. */
  function declarationsFor(entry: Case): readonly string[] {
    using parsed = parseModule(api, 'type-imports.ts', entry.source);
    const declarations = parsed.sourceFile.statements.filter((each) => isImportDeclaration(each));
    const { modules } = readImports(
      declarations,
      parsed.sourceFile,
      () => ({ file: undefined, id: undefined, kind: 'package' }),
      (reason) => {
        throw new Error(reason);
      },
    );
    const lines: ImportLine[] = [];
    const extraTyped = new Set(entry.alsoTyped);
    for (const module of modules) {
      for (const binding of module.bindings) {
        const locals = entry.renames?.[binding.name.text] ?? [binding.name.text];
        for (const local of locals) {
          lines.push({
            binding,
            from: module.written,
            typeOnly: binding.typeOnly,
            ...(local !== binding.name.text && { local }),
          });
        }
        if (extraTyped.has(binding.name.text)) {
          lines.push({ binding, from: module.written, typeOnly: true });
        }
      }
    }
    return importDeclarations(lines);
  }

  it.each(CASES)('$id', (entry) => {
    expect(declarationsFor(entry)).toStrictEqual(entry.expected);
  });
});
