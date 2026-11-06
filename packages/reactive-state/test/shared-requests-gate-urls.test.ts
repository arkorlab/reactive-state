import { describe, expect, it } from 'vitest';

import { AuthorityError } from '../src/authority/errors.ts';
import { gateRequestOf } from '../src/authority/shared-requests.ts';

/**
 * The URL a gate's question names (`gateRequestOf`), which the gate reads its route's params of: a
 * path and its query, read against a base of no site's. One that reads as no URL there — a path the
 * parser takes for an empty host, or an invalid one — is refused as a question of no URL is (400),
 * before anything reads it, never thrown as the parser's `TypeError` once the gate does, which each
 * host answers as a fault of its own.
 */

/** A gate's question of a board's page, of `url`. */
function questionOf(url: string): unknown {
  return { headers: {}, method: 'GET', route: '/boards/[projectId]', url };
}

/** What reading a gate's question of `url` threw; nothing where it read one. */
function thrownBy(url: string): unknown {
  try {
    gateRequestOf(questionOf(url));
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the URL a gate’s question names', () => {
  it.each(['//', '//:80', '//[::1', '/\\'])(
    'refuses %s, which reads as no URL, as a question of none (400)',
    (url) => {
      const thrown = thrownBy(url);

      expect(thrown).toBeInstanceOf(AuthorityError);
      expect(thrown).toMatchObject({ code: 'INVALID_GATE', status: 400 });
    },
  );

  it('takes a path and its query, a path that repeats a slash among them', () => {
    expect(gateRequestOf(questionOf('/boards/p1?tab=members'))).toMatchObject({
      url: '/boards/p1?tab=members',
    });
    expect(gateRequestOf(questionOf('/boards//p1'))).toMatchObject({ url: '/boards//p1' });
  });
});
