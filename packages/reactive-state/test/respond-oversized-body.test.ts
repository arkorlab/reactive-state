import { Agent, createServer, type IncomingMessage, request, type ServerResponse } from 'node:http';

import { describe, expect, it, onTestFinished } from 'vitest';

import { AuthorityError } from '../src/authority/errors.ts';
import { json, readJson } from '../src/authority/respond.ts';
import { HTTP_INTERNAL_ERROR, HTTP_OK, HTTP_PAYLOAD_TOO_LARGE } from '../src/status.ts';

/**
 * A body past the largest the authority reads (`readJson`), as its Node server answers it: refused
 * (413), over a connection a client keeps — and sends its next request on, as Node's agent and
 * `fetch` do.
 */

const SIZES = {
  /** Twice the largest body the authority reads (`MAX_BODY_BYTES`, 1 MiB). */
  pastLimit: 2_097_152,
  /** Past the server's keep-alive timeout and its grace (5 s and 1 s), which end an idle connection. */
  waitMs: 15_000,
} as const;

/** What a request was answered: its status, and the JSON of its body. */
interface Answer {
  readonly status: number | undefined;
  readonly body: unknown;
}

/** A request answered the body it carried, read as the authority's routes read theirs. */
async function echoed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, HTTP_OK, await readJson(req));
}

/** What could not be read, answered as the authority's server answers it: by status and code. */
function refused(res: ServerResponse, error: unknown): void {
  const refusal = error instanceof AuthorityError ? error : undefined;
  json(res, refusal?.status ?? HTTP_INTERNAL_ERROR, { code: refusal?.code ?? 'INTERNAL_ERROR' });
}

/** A server that answers each request so: its address, and an agent of one connection to it. */
async function served(): Promise<{ readonly agent: Agent; readonly url: string }> {
  const server = createServer((req, res) => {
    void echoed(req, res).catch((error: unknown) => {
      refused(res, error);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  onTestFinished(() => {
    agent.destroy();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { agent, url: `http://127.0.0.1:${String(port)}/` };
}

/** `body`, posted through `agent`: what it was answered, once the answer has ended. */
async function post(agent: Agent, url: string, body: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { agent, method: 'POST' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({ body: JSON.parse(text) as unknown, status: res.statusCode });
      });
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

describe('a body past the largest the authority reads', () => {
  it(
    'is refused, and the next request its connection carries is answered',
    async () => {
      const { agent, url } = await served();

      const large = await post(agent, url, JSON.stringify({ user: 'x'.repeat(SIZES.pastLimit) }));
      const next = await post(agent, url, JSON.stringify({ user: 'alice' }));

      expect(large).toStrictEqual({ body: { code: 'TOO_LARGE' }, status: HTTP_PAYLOAD_TOO_LARGE });
      expect(next).toStrictEqual({ body: { user: 'alice' }, status: HTTP_OK });
    },
    SIZES.waitMs,
  );
});
