import { describe, expect, it, vi } from 'vitest';

import { MAX_BODY_BYTES, throughChain } from '../src/next/chain.ts';
import type { MiddlewareEnvelope } from '../src/routing.ts';
import { HTTP_OK, HTTP_PAYLOAD_TOO_LARGE } from '../src/status.ts';

const ORIGIN = 'https://example.com/upload';
const CHUNK_BYTES = 65_536;

/** A body that reads nothing until its consumer asks for a chunk. */
function streamed(length: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream(
    {
      pull: (controller) => {
        if (sent === length) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK_BYTES, length - sent);
        controller.enqueue(new Uint8Array(size));
        sent += size;
      },
    },
    { highWaterMark: 0 },
  );
}

/** A streamed upload, optionally declaring how many bytes it holds. */
function posting(declared: boolean): Request {
  const headers = new Headers({ 'x-original': 'kept' });
  if (declared) {
    headers.set('content-length', String(MAX_BODY_BYTES + 1));
  }
  const init = { body: streamed(MAX_BODY_BYTES + 1), duplex: 'half', headers, method: 'POST' };
  return new Request(ORIGIN, init);
}

describe('middleware chains without a request-binding before', () => {
  it.each([false, true])(
    'streams past the clone bound with declared length %s',
    async (declared) => {
      const request = posting(declared);
      const seen: unknown[] = [];
      const envelope: MiddlewareEnvelope = {
        after: (locals, response) => {
          seen.push(locals);
          response.headers.set('x-after', 'kept');
        },
        before: () => {
          seen.push(request.bodyUsed);
          return { requestId: 'request-1' };
        },
        id: '',
      };
      const response = await throughChain(
        { envelopes: { '': envelope }, ids: [''], params: {}, request },
        async (below) => {
          seen.push(below === request, below.bodyUsed, below.headers.get('x-original'));
          return new Response(String((await below.arrayBuffer()).byteLength));
        },
      );

      expect([
        response.status,
        await response.text(),
        response.headers.get('x-after'),
      ]).toStrictEqual([HTTP_OK, String(MAX_BODY_BYTES + 1), 'kept']);
      expect(seen).toStrictEqual([false, true, false, 'kept', { requestId: 'request-1' }]);
    },
  );

  it.each([false, true])(
    'retains the request-binding body limit with declared length %s',
    async (declared) => {
      const before = vi.fn(({ request }: { readonly request: Request }) => {
        const requestId = request.headers.get('x-original');
        return { requestId };
      });
      const downstream = vi.fn(() => Promise.resolve(new Response('downstream')));
      const response = await throughChain(
        {
          envelopes: { '': { before, id: '' } },
          ids: [''],
          params: {},
          request: posting(declared),
        },
        downstream,
      );

      expect([response.status, response.headers.get('cache-control')]).toStrictEqual([
        HTTP_PAYLOAD_TOO_LARGE,
        'private, no-store',
      ]);
      expect(before).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    },
  );

  it('keeps the bound when only one of the befores binds the request', async () => {
    const before = vi.fn(() => ({}));
    const reading = vi.fn(({ request }: { readonly request: Request }) => ({ path: request.url }));
    const downstream = vi.fn(() => Promise.resolve(new Response('downstream')));
    const response = await throughChain(
      {
        envelopes: { '': { before, id: '' }, child: { before: reading, id: 'child' } },
        ids: ['', 'child'],
        params: {},
        request: posting(false),
      },
      downstream,
    );

    expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect([before.mock.calls, reading.mock.calls, downstream.mock.calls]).toStrictEqual([
      [],
      [],
      [],
    ]);
  });

  it('does not read or cancel an upload before an argument-free before throws', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
    const init = {
      body,
      duplex: 'half',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      method: 'POST',
    };
    const downstream = vi.fn(() => Promise.resolve(new Response('downstream')));
    const envelope: MiddlewareEnvelope = {
      before: () => {
        throw new Error('refused');
      },
      id: '',
    };

    await expect(
      throughChain(
        { envelopes: { '': envelope }, ids: [''], params: {}, request: new Request(ORIGIN, init) },
        downstream,
      ),
    ).rejects.toThrow('refused');
    expect([pull.mock.calls, cancel.mock.calls, downstream.mock.calls]).toStrictEqual([[], [], []]);

    await body.cancel();
  });
});
