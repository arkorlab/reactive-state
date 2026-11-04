import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
  fetchArtifact,
  MAX_ARTIFACT_BYTES,
  UnsharedPageError,
  type SiteFetch,
} from '../src/authority/shared-generate.ts';
import type { Profile } from '../src/authority/view-tokens.ts';

/**
 * A generation's artifact, as the authority asks its site for one: the page's answer taken for the
 * profile asked for by its media type, as HTTP reads one — in any case, its parameters aside — and
 * never by a type that only begins as that one does.
 */

/** A site that answers every page `ok`, of the content type `type`. */
function answering(type: string): SiteFetch {
  return () => Promise.resolve(new Response('ok', { headers: { 'content-type': type } }));
}

/** The artifact of `profile` asked of a site that answers with `type`. */
async function artifactOf(profile: Profile, type: string): Promise<unknown> {
  return fetchArtifact(
    answering(type),
    { path: '/boards/p1', profile, token: 'token' },
    new AbortController().signal,
  );
}

/** A site that answers every page with a redirect, to `location` where it says where to. */
function redirecting(location: string | undefined): SiteFetch {
  return () => {
    const headers: Record<string, string> = location === undefined ? {} : { location };
    return Promise.resolve(new Response(null, { headers, status: 307 }));
  };
}

/** A site that answers every page a document of `status`. */
function answeredWith(status: number): SiteFetch {
  return () => {
    return Promise.resolve(
      new Response('no', { headers: { 'content-type': 'text/html' }, status }),
    );
  };
}

/** The document asked of `fetchSite`. */
async function documentOf(fetchSite: SiteFetch): Promise<unknown> {
  return fetchArtifact(
    fetchSite,
    { path: '/boards/p1', profile: 'document', token: 'token' },
    new AbortController().signal,
  );
}

describe('an artifact asked of the site', () => {
  it.each([
    ['document', 'Text/HTML; charset=utf-8'],
    ['document', 'text/html ;charset=UTF-8'],
    ['document', 'TEXT/HTML'],
    ['rsc', 'Text/X-Component'],
    ['rsc', 'text/x-component; charset=utf-8'],
  ] as const)('is taken as the %s it is where the page answers %s', async (profile, type) => {
    await expect(artifactOf(profile, type)).resolves.toMatchObject({ body: 'ok', profile });
  });

  it('weighs a page by its UTF-8 bytes, as the store keeps it and the gate serves it: past them, however few its characters', async () => {
    // Three bytes a character: a third of what an artifact may be in characters, past it in bytes.
    const page = 'あ'.repeat(Math.ceil(MAX_ARTIFACT_BYTES / 3));
    const answer = new Response(page, { headers: { 'content-type': 'text/html' } });
    const site: SiteFetch = () => Promise.resolve(answer);

    await expect(
      fetchArtifact(
        site,
        { path: '/boards/p1', profile: 'document', token: 'token' },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(UnsharedPageError);
  });

  it('lets go of a page that answers with what its code said in the page’s place — `notFound()`, `unauthorized()`, `forbidden()` — as no artifact: a fault is any other status', async () => {
    for (const status of [401, 403, 404]) {
      await expect(documentOf(answeredWith(status))).rejects.toBeInstanceOf(UnsharedPageError);
    }

    await expect(documentOf(answeredWith(500))).rejects.toThrow('answered 500');
    await expect(documentOf(answeredWith(500))).rejects.not.toBeInstanceOf(UnsharedPageError);
  });

  it('lets go of a page that answers with a redirect, as a layout’s `redirect()` answers, as no artifact: a fault is one where it says nowhere to go', async () => {
    await expect(documentOf(redirecting('/boards/p2'))).rejects.toBeInstanceOf(UnsharedPageError);
    await expect(documentOf(redirecting(undefined))).rejects.toThrow('answered 307');
    await expect(documentOf(redirecting(undefined))).rejects.not.toBeInstanceOf(UnsharedPageError);
  });

  it.each([
    ['document', 'text/html-extra'],
    ['document', 'text/htmlx; charset=utf-8'],
    ['document', 'text/x-component'],
    ['rsc', 'text/x-component-other'],
    ['rsc', 'text/html'],
  ] as const)('is refused as a %s where the page answers %s', async (profile, type) => {
    await expect(artifactOf(profile, type)).rejects.toThrow(`answered 200 (${type})`);
  });
});

/** The document a page answers, in a coding: `<p>済</p>`, a page's text beyond ASCII. */
const DOCUMENT = '<p>済</p>';

/**
 * A site on a loopback port of its own whose page answers `body` in `coding` (`Content-Encoding`),
 * asked through Node's own `fetch`, as the authority asks its site (`startAuthority`); and the
 * `Accept-Encoding` each request came with. Closed when the test finishes.
 */
async function codedSite(
  coding: string,
  body: Uint8Array,
): Promise<{ readonly fetchSite: SiteFetch; readonly accepted: (string | undefined)[] }> {
  const accepted: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    accepted.push(request.headers['accept-encoding']);
    response.writeHead(200, { 'content-encoding': coding, 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  const { port } = server.address() as AddressInfo;
  const fetchSite: SiteFetch = async (path, headers, signal) => {
    return fetch(new URL(path, `http://127.0.0.1:${String(port)}`), {
      headers,
      redirect: 'manual',
      ...(signal !== undefined && { signal }),
    });
  };
  return { accepted, fetchSite };
}

describe('the coding of an artifact asked of the site', () => {
  it.each([
    ['gzip', gzipSync(DOCUMENT)],
    ['GZIP', gzipSync(DOCUMENT)],
    ['gzip, gzip', gzipSync(gzipSync(DOCUMENT))],
    ['identity', Buffer.from(DOCUMENT)],
  ])(
    'is none it asks for, and the page’s text is taken where Node’s fetch undid %s',
    async (coding, body) => {
      const { accepted, fetchSite } = await codedSite(coding, body);

      await expect(
        fetchArtifact(
          fetchSite,
          { path: '/boards/p1', profile: 'document', token: 'token' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ body: DOCUMENT });
      expect(accepted).toStrictEqual(['identity']);
    },
  );

  it.each([
    ['compress', Buffer.from('coded')],
    ['gzip, identity', gzipSync(DOCUMENT)],
    ['x-unknown', Buffer.from('coded')],
  ])(
    'refuses a page whose body Node’s fetch read as it came, of %s, as a failed request',
    async (coding, body) => {
      const { fetchSite } = await codedSite(coding, body);

      await expect(
        fetchArtifact(
          fetchSite,
          { path: '/boards/p1', profile: 'document', token: 'token' },
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        `The page /boards/p1 answered a generation's document in a coding the platform's fetch reads as it came (${coding}).`,
      );
    },
  );
});
