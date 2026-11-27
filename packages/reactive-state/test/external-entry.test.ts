import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type * as authority from '../src/authority/index.ts';
import * as server from '../src/server/index.ts';

/**
 * The package's entries hold no store of the application's own and no table declared by hand of
 * one: no `./external` entry of the store's types, which neither `./authority` exports, and no
 * `json()` field of `./server`, which such a table alone declared. A follow brings its own store
 * (`followDrizzle`, `followedDb`), whose type stays inside the package.
 */

describe("the package's entries", () => {
  it('hold no ./external', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Readonly<Record<string, unknown>> };

    expect(Object.keys(manifest.exports)).not.toContain('./external');
    expect(JSON.stringify(manifest.exports)).not.toContain('external.ts');
  });

  it('hold no json of ./server', () => {
    expect(Object.keys(server)).not.toContain('json');
    expect(Object.keys(server)).toContain('text');
  });

  it('hold no store types of ./authority', () => {
    // @ts-expect-error -- the store's type is no export of `./authority`.
    type Store = authority.ExternalStore;
    // @ts-expect-error -- nor are the pages of its log.
    type Changes = authority.ExternalChanges;

    expectTypeOf<Store>().toBeAny();
    expectTypeOf<Changes>().toBeAny();
  });
});
