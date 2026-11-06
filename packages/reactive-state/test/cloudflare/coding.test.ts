import { brotliCompressSync, gzipSync } from 'node:zlib';

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { isDecoded, readsAsWritten } from '../../src/content-coding.ts';

/**
 * The codings workerd's own `fetch` undoes as it reads a body, as `isDecoded` says it does: the
 * suites' Worker answers a text coded as asked, under the `Content-Encoding` asked, its body as it
 * is (`worker.ts`), read through the Worker's own binding as any subrequest's answer is read. `gzip`
 * and `br` alone, as written: no other case of them, and no list, whatever HTTP says of a coding's
 * case — a page's answer of those is read as it came, coded.
 */

/** The text the Worker is asked to answer, coded. */
const CODED_TEXT = '<p>済</p>';

describe('a body workerd’s fetch reads', () => {
  it.each([
    ['gzip', 'gzip', true],
    ['br', 'br', true],
    [' gzip ', 'gzip', true],
    ['GZip', 'gzip', false],
    ['GZIP', 'gzip', false],
    ['BR', 'br', false],
    ['gzip, identity', 'gzip', false],
    ['identity, gzip', 'gzip', false],
    ['gzip,gzip', 'gzip', false],
    ['x-gzip', 'gzip', false],
    ['deflate', 'gzip', false],
  ] as const)(
    'of `Content-Encoding: %s`, its body %s, is decoded as `isDecoded` says: %s',
    async (coding, as, decodes) => {
      const response = await exports.default.fetch(
        `https://worker.test/coded?coding=${encodeURIComponent(coding)}`,
        {
          body: as === 'br' ? brotliCompressSync(CODED_TEXT) : gzipSync(CODED_TEXT),
          method: 'POST',
        },
      );
      const said = [isDecoded(response), readsAsWritten(response)];
      const read = new TextDecoder().decode(await response.arrayBuffer());

      expect(said).toStrictEqual([decodes, decodes]);
      expect(read === CODED_TEXT).toBe(decodes);
    },
  );
});
