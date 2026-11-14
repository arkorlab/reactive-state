import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { AuthorityEngine } from '../src/authority/engine.ts';
import { AuthorityError } from '../src/authority/errors.ts';
import { handleShared } from '../src/authority/http-shared.ts';
import { GATE_ROUTE_HEADER, type GateAnswer } from '../src/routing.ts';

/**
 * The visitor's URL the edge's route gate tells the Node authority in `x-upwind-gate-url`, which its
 * gate route (`/internal/gate`) reads as its question's URL. One that reads as no URL — a reference
 * the parser takes for an empty host, or an invalid one — is refused as a question of no URL is
 * (400, `INVALID_GATE`) before the engine is asked, never thrown as the parser's `TypeError`, which
 * the authority answers as a fault of its own (500), and logs.
 */

/** The header the edge's gate tells the authority the visitor's URL in. */
const GATE_URL_HEADER = 'x-upwind-gate-url';
/** A route the edge asks of. */
const HELLO = '/hello/[id]';

/**
 * The gate route asked the edge's question of `url`, as a request and a response that stand in for
 * the edge's: how it ended, and each question the engine — which lets every one through — was asked.
 */
async function forwarded(url: string): Promise<{
  readonly ended: unknown;
  readonly asked: readonly unknown[];
}> {
  const asked: unknown[] = [];
  const engine = {
    gate: (question: unknown): Promise<GateAnswer> => {
      asked.push(question);
      return Promise.resolve({ kind: 'pass' });
    },
  };
  const res = {
    end: (): void => {
      // Nothing is written of a pass but its head.
    },
    writeHead: (): unknown => res,
  };
  const req = { headers: { [GATE_ROUTE_HEADER]: HELLO, [GATE_URL_HEADER]: url } };
  try {
    const ended = await handleShared({
      engine: engine as unknown as AuthorityEngine,
      method: 'GET',
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      streams: new Set(),
      url: new URL('http://127.0.0.1/internal/gate'),
    });
    return { asked, ended };
  } catch (error) {
    return { asked, ended: error };
  }
}

describe('the visitor’s URL the edge tells the gate route', () => {
  it.each(['//', '//:80', '//?x', '//[::1', '/\\', 'https://[::1'])(
    'refuses %s, which reads as no URL, as a question of none (400)',
    async (url) => {
      const { asked, ended } = await forwarded(url);

      expect(ended).toBeInstanceOf(AuthorityError);
      expect(ended).toMatchObject({ code: 'INVALID_GATE', status: 400 });
      expect(asked).toStrictEqual([]);
    },
  );

  it('asks the engine of the path and the query of a URL that reads as one', async () => {
    const absolute = await forwarded('https://site.test/hello/a?tab=open#top');
    const path = await forwarded('/hello/b');

    expect(absolute).toStrictEqual({
      asked: [{ headers: {}, method: 'GET', route: HELLO, url: '/hello/a?tab=open' }],
      ended: true,
    });
    expect(path.asked).toStrictEqual([
      { headers: {}, method: 'GET', route: HELLO, url: '/hello/b' },
    ]);
  });
});
