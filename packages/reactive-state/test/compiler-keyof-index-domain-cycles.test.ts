import { type Node, isIndexSignatureDeclaration, SyntaxKind } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { indexSignatureDomains } from '../src/compiler/local-type-index-domains.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Native-invalid recursive aliases check helper completeness, separately from semantic regressions. */
const CASES = [
  {
    id: 'active-direct-alias-cycle',
    source: 'type Keys=string|Keys;type Bag={[key:Keys]:Error};',
    kinds: [SyntaxKind.StringKeyword, SyntaxKind.TypeReference],
  },
  {
    id: 'active-indirect-alias-cycle',
    source: 'type Left=string|Right;type Right=symbol|Left;type Bag={[key:Left]:Error};',
    kinds: [SyntaxKind.StringKeyword, SyntaxKind.SymbolKeyword, SyntaxKind.TypeReference],
  },
  {
    id: 'completed-repeated-alias-pin',
    source: 'type Strings=string;type Keys=Strings|Strings;type Bag={[key:Keys]:Error};',
    kinds: [SyntaxKind.StringKeyword],
  },
  {
    id: 'completed-diamond-alias-pin',
    source:
      'type Shared=string;type Left=Shared|symbol;type Right=Shared|number;type Keys=Left|Right;type Bag={[key:Keys]:Error};',
    kinds: [SyntaxKind.NumberKeyword, SyntaxKind.StringKeyword, SyntaxKind.SymbolKeyword],
  },
];

describe('index domain active ancestry', () => {
  it.each(CASES)('$id', ({ source, kinds }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'index-domain-ancestry.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    const found: ReadonlySet<SyntaxKind>[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (isIndexSignatureDeclaration(node))
        found.push(indexSignatureDomains(node.parameters[0]?.type));
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toHaveLength(1);
    expect(found[0]).toStrictEqual(new Set(kinds));
  });
});
