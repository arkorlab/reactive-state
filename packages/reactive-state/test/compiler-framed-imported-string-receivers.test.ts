import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Imported and unresolved type references on string-method receivers conservatively run native
 * `String.prototype` argument conversion checks, while non-string built-ins (`Array`, `RegExp`,
 * `Map`, `Set`) and local non-string classes and interfaces remain unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'imported-type-alias-replace-callback',
    source: `import type { Label } from './types'; function text(s: Label, error: Error) { return s.replace('a', () => error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'imported-type-alias-pad-start-error',
    source: `import type { Label } from './types'; function text(s: Label, error: Error) { return s.padStart(2, error as never); }`,
  },
  {
    framed: true,
    id: 'imported-type-alias-concat-error-array',
    source: `import type { Label } from './types'; function text(s: Label, error: Error) { return s.concat([error] as unknown as string); }`,
  },
  {
    framed: true,
    id: 'imported-namespace-type-concat-error',
    source: `import type * as Types from './types'; function text(s: Types.Label, error: Error) { return s.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'import-type-node-includes-error',
    source: `function text(s: import('./types').Label, error: Error) { return s.includes(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'optional-imported-type-alias-pad-end',
    source: `import type { Label } from './types'; function text(s: Label | undefined, error: Error) { return s?.padEnd(4, error as never) ?? ''; }`,
  },
  {
    framed: true,
    id: 'imported-holder-member-receiver',
    source: `import type { Box } from './types'; function text(box: Box, error: Error) { return box.label.replace('a', () => error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'imported-indexed-access-receiver',
    source: `import type { Box } from './types'; function text(s: Box['label'], error: Error) { return s.concat(error as never); }`,
  },
  {
    framed: true,
    id: 'generic-constrained-to-imported-type',
    source: `import type { Label } from './types'; function text<T extends Label>(s: T, error: Error) { return s.replaceAll('a', error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'branded-string-intersection-receiver',
    source: `type BrandedLabel = string & { readonly __brand: unique symbol }; function text(s: BrandedLabel, error: Error) { return s.concat(error as unknown as string); }`,
  },
  {
    framed: false,
    id: 'imported-type-alias-ordinary-text-replace',
    source: `import type { Label } from './types'; function text(s: Label) { return s.replace('a', 'b').padStart(4, '0'); }`,
  },
  {
    framed: false,
    id: 'builtin-array-generic-concat-retains-value',
    source: `import type { Label } from './types'; function count(items: Array<Label>, error: Error) { return items.concat(error as unknown as Label).length; }`,
  },
  {
    framed: false,
    id: 'builtin-readonly-array-includes-non-coercing',
    source: `import type { Label } from './types'; function check(items: ReadonlyArray<Label>, error: Error) { return items.includes(error as unknown as Label); }`,
  },
  {
    framed: false,
    id: 'builtin-regexp-and-collections-unflagged',
    source: `function check(pattern: RegExp, map: Map<string, unknown>, set: Set<unknown>, error: Error) { return Boolean(pattern) && map.has('a') && set.has(error); }`,
  },
  {
    framed: false,
    id: 'local-class-and-interface-concat-unflagged',
    source: `interface Named { concat(value: unknown): string } class Builder { concat(_value: unknown) { return 'safe'; } } function text(named: Named, builder: Builder, error: Error) { return named.concat(error) + builder.concat(error); }`,
  },
] as const;

describe('imported and opaque string receiver text conversions', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'imported-string-receivers.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
