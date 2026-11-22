import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Intersections combining an imported or external (`opaque`) type with a structural brand (`Label &
 * { readonly __brand: unique symbol }`, `{ ... } & Label`, `(Label | undefined) & {}`) remain
 * conservative string-receiver candidates, while explicit `string & brand` stays `string`,
 * `number & brand` stays `other-primitive`, and pure object intersections stay `non-primitive`.
 */

const CASES = [
  {
    framed: true,
    id: 'branded-imported-type-concat-error',
    source: `import type { Label } from './types'; type Branded = Label & { readonly __brand: unique symbol }; function text(s: Branded, error: Error) { return s.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'reversed-brand-and-imported-type-pad-start',
    source: `import type { Label } from './types'; type Branded = { readonly __brand: 'label' } & Label; function text(s: Branded, error: Error) { return s.padStart(4, error as never); }`,
  },
  {
    framed: true,
    id: 'branded-imported-type-concat-error-array',
    source: `import type { Label } from './types'; type Branded = Label & { readonly __brand: unique symbol }; function text(s: Branded, error: Error) { return s.concat([error] as unknown as string); }`,
  },
  {
    framed: true,
    id: 'branded-imported-namespace-type-replace-callback',
    source: `import type * as Types from './types'; type Branded = Types.Label & { readonly __brand: unique symbol }; function text(s: Branded, error: Error) { return s.replace('a', () => error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'optional-imported-type-intersected-with-empty-object',
    source: `import type { Label } from './types'; type Definite = (Label | undefined) & {}; function text(s: Definite, error: Error) { return s.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'optional-string-intersected-with-empty-object',
    source: `type Definite = (string | undefined) & {}; function text(s: Definite, error: Error) { return s.padEnd(4, error as never); }`,
  },
  {
    framed: true,
    id: 'extract-imported-type-with-brand-intersection',
    source: `import type { Label } from './types'; type Branded = Extract<Label, { readonly __brand: unique symbol }>; function text(s: Branded, error: Error) { return s.includes(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'generic-brand-helper-over-imported-type',
    source: `import type { Label } from './types'; type Brand<T, Tag extends string> = T & { readonly __tag: Tag }; function text(s: Brand<Label, 'id'>, error: Error) { return s.replaceAll('a', error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'branded-string-intersection-pin',
    source: `type Branded = string & { readonly __brand: unique symbol }; function text(s: Branded, error: Error) { return s.concat(error as unknown as string); }`,
  },
  {
    framed: false,
    id: 'branded-number-intersection-remains-non-string',
    source: `type BrandedNumber = number & { readonly __brand: unique symbol }; function check(n: BrandedNumber, error: Error) { return (n as unknown as { concat(v: unknown): number }).concat(error); }`,
  },
  {
    framed: false,
    id: 'imported-or-number-branded-union-remains-unproven',
    source: `import type { Label } from './types'; type Mixed = (Label | number) & { readonly __brand: unique symbol }; function check(value: Mixed, error: Error) { return (value as unknown as { includes(v: unknown): boolean }).includes(error); }`,
  },
  {
    framed: false,
    id: 'local-interface-intersection-remains-non-primitive',
    source: `interface Left { concat(value: unknown): string } interface Right { readonly tag: string } function text(receiver: Left & Right, error: Error) { return receiver.concat(error); }`,
  },
  {
    framed: false,
    id: 'branded-imported-ordinary-string-args-unflagged',
    source: `import type { Label } from './types'; type Branded = Label & { readonly __brand: unique symbol }; function text(s: Branded) { return s.concat('ok').padStart(4, '0'); }`,
  },
] as const;

describe('branded imported and external string receiver intersections', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'branded-imported-receivers.ts', source);

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
