import { type Node, isIndexSignatureDeclaration, SyntaxKind } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { indexSignatureDomains } from '../src/compiler/local-type-index-domains.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Supported native domain sets remain distinct from unresolved generic alias syntax. */
const CASES = [
  {
    id: 'plain-string-domain',
    source: 'type Bag={[key:string]:Error};',
    kinds: [SyntaxKind.StringKeyword],
  },
  {
    id: 'union-native-domains',
    source: 'type Bag={[key:string|symbol]:Error};',
    kinds: [SyntaxKind.StringKeyword, SyntaxKind.SymbolKeyword],
  },
  {
    id: 'repeated-domain-alias',
    source: 'type Keys=string|symbol;type Bag={[key:Keys|Keys]:Error};',
    kinds: [SyntaxKind.StringKeyword, SyntaxKind.SymbolKeyword],
  },
  {
    id: 'generic-alias-stays-unresolved',
    source: 'type Keys<T>=T;type Bag={[key:Keys<string>]:Error};',
    kinds: [SyntaxKind.TypeReference],
  },
  {
    id: 'partial-generic-union-stays-incomplete',
    source: 'type Keys<T>=T;type Bag={[key:string|Keys<symbol>]:Error};',
    kinds: [SyntaxKind.StringKeyword, SyntaxKind.TypeReference],
  },
  {
    id: 'generic-default-stays-unresolved',
    source: 'type Keys<T=string>=T;type Bag={[key:Keys]:Error};',
    kinds: [SyntaxKind.TypeReference],
  },
];

describe('written index domain completeness', () => {
  it.each(CASES)('$id', ({ source, kinds }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'index-domain-boundary.ts', source);
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
