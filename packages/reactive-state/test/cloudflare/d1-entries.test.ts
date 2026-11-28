import { describe, expect, it } from 'vitest';

import * as d1 from '../../src/cloudflare/d1-store.ts';
import * as cloudflare from '../../src/cloudflare/index.ts';

/**
 * What the `./cloudflare` entry exports of `./d1`, in workerd, where it loads: the prune of a D1
 * change log alone, the same functions — no store of tables declared by hand, and no change capture
 * of them, which `followDrizzle`'s `captureSql()` makes.
 */

describe("the Cloudflare entry's D1 exports", () => {
  it('re-exports d1Executor and pruneChanges, and nothing else of ./d1', () => {
    expect(Object.keys(d1)).toStrictEqual(['d1Executor', 'pruneChanges']);
    expect(cloudflare.d1Executor).toBe(d1.d1Executor);
    expect(cloudflare.pruneChanges).toBe(d1.pruneChanges);
    expect(Object.keys(cloudflare)).not.toContain('d1Store');
    expect(Object.keys(cloudflare)).not.toContain('changeCaptureSql');
  });
});
