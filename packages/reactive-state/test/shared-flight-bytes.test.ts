import { describe, expect, it } from 'vitest';

import { artifactAnswer } from '../src/authority/gate-answers.ts';
import {
  fetchArtifact,
  UnsharedPageError,
  type SiteFetch,
  type GeneratedArtifact,
} from '../src/authority/shared-generate.ts';
import type { Profile } from '../src/authority/view-tokens.ts';
import { BOARD, BUILD, open, pageOf } from './support/shared-fixture.ts';

/** Raw Flight bytes are either represented losslessly or left to ordinary private delivery. */
const PREFIX = new TextEncoder().encode('1:o1,');
const RAW = Uint8Array.of(...PREFIX, 255);

/** A native Response carries the written byte chunks without a text conversion in the fixture. */
function siteOf(chunks: readonly Uint8Array[], profile: Profile): SiteFetch {
  return () => {
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { 'content-type': profile === 'rsc' ? 'text/x-component' : 'text/html' } },
      ),
    );
  };
}

/** The original generation request reads native Response bytes through the real artifact producer. */
function generated(
  chunks: readonly Uint8Array[],
  profile: Profile = 'rsc',
): Promise<GeneratedArtifact> {
  return fetchArtifact(
    siteOf(chunks, profile),
    { path: '/boards/p1', profile, token: 'token' },
    new AbortController().signal,
  );
}

/** The unchanged gate base64 transport is decoded back into its actual response bytes. */
function answered(artifact: GeneratedArtifact): Uint8Array {
  const answer = artifactAnswer(
    { ...artifact, view: 'view', generation: 1, etag: '"test"', created: 0 },
    { headers: {}, method: 'GET', route: '/boards/[projectId]', url: '/boards/p1' },
  );
  if (answer.kind !== 'respond' || answer.body === null)
    throw new Error('Expected an artifact body');
  return Buffer.from(answer.body, 'base64');
}

describe('flight artifact byte representation', () => {
  it.each([
    { what: 'reported raw binary row', chunks: [RAW] },
    { what: 'chunked invalid byte', chunks: [PREFIX, Uint8Array.of(255)] },
    { what: 'unfinished UTF8 flush', chunks: [PREFIX, Uint8Array.of(195)] },
  ])('keeps $what out of text artifacts', async ({ chunks }) => {
    await expect(generated(chunks)).rejects.toBeInstanceOf(UnsharedPageError);
  });

  it.each([
    { what: 'ASCII Flight text', chunks: [new TextEncoder().encode('0:{"ok":true}\n')] },
    {
      what: 'valid binary UTF8 bytes',
      chunks: [new TextEncoder().encode('1:o2,'), Uint8Array.of(194, 169)],
    },
    { what: 'split Unicode', chunks: [PREFIX, Uint8Array.of(240, 159), Uint8Array.of(152, 128)] },
    { what: 'initial BOM bytes', chunks: [Uint8Array.of(239, 187, 191), PREFIX] },
  ])('roundtrips $what through the existing gate transport', async ({ chunks }) => {
    const artifact = await generated(chunks);

    expect([...answered(artifact)]).toStrictEqual(chunks.flatMap((chunk) => [...chunk]));
  });

  it('retains the document decoder replacement behavior', async () => {
    const artifact = await generated([RAW], 'document');

    expect(artifact.body).toBe('1:o1,\u{FFFD}');
  });

  it('cancels unread invalid Flight once without asking for another page', async () => {
    let calls = 0;
    let cancelled = 0;
    const site: SiteFetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(RAW);
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { headers: { 'content-type': 'text/x-component' } },
        ),
      );
    };

    await expect(
      fetchArtifact(
        site,
        { path: '/boards/p1', profile: 'rsc', token: 'token' },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(UnsharedPageError);
    expect({ calls, cancelled }).toStrictEqual({ calls: 1, cancelled: 1 });
  });

  it('preserves stream failures as retryable generation failures', async () => {
    const failure = new Error('transient body read');
    const site: SiteFetch = () => {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(failure);
            },
          }),
          { headers: { 'content-type': 'text/x-component' } },
        ),
      );
    };

    await expect(
      fetchArtifact(
        site,
        { path: '/boards/p1', profile: 'rsc', token: 'token' },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  });

  it('uses private delivery for the complete generation without a second artifact attempt', async () => {
    const { ask, engine, asked } = await open({
      site: (opened) => {
        const page = pageOf(opened);
        return async (path, headers, signal) => {
          const answer = await page(path, headers, signal);
          return headers['rsc'] === '1'
            ? new Response(RAW, { headers: answer.headers, status: answer.status })
            : answer;
        };
      },
    });

    await expect(ask('/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(ask('/boards/p1', { rsc: '1' })).resolves.toStrictEqual({ kind: 'pass' });
    await expect(
      engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route: BOARD }),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(asked.map((entry) => entry.rsc)).toStrictEqual([false, true]);
  });
});
