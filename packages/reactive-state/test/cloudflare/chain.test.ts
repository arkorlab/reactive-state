import { describe, expect, it } from 'vitest';

import { throughChain } from '../../src/next/chain.ts';

/**
 * A route middleware chain's envelopes as a Function runs them in workerd: each envelope, and what
 * is below them — the page asked for again — handed a request given up as the request is, so that
 * a fetch made of it is given up with it.
 */

const SITE = 'https://site.test/';

describe('a route middleware chain, in workerd', () => {
  it('hands each envelope and what is below them a request given up as the request is', async () => {
    const asked = new AbortController();
    const handed: AbortSignal[] = [];
    await throughChain(
      {
        envelopes: {
          '': {
            before: async ({ request }) => {
              handed.push(request.signal);
              await request.text();
              return {};
            },
            id: '',
          },
        },
        ids: [''],
        params: {},
        request: new Request(SITE, { body: 'form', method: 'POST', signal: asked.signal }),
      },
      async (request) => {
        handed.push(request.signal);
        return new Response(await request.text());
      },
    );
    asked.abort();

    expect(handed.map((signal) => signal.aborted)).toStrictEqual([true, true]);
  });

  it('gives up a fetch made with a signal given up', async () => {
    const asked = new AbortController();
    asked.abort();

    await expect(fetch(`${SITE}page`, { signal: asked.signal })).rejects.toThrow(/abort/iu);
  });
});
