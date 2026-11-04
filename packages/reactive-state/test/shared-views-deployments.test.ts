import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { DEPLOYMENT_HOLD_MS, deploymentOf } from '../src/authority/artifact-deployments.ts';
import type { Engine } from '../src/authority/index.ts';
import type { SiteFetch } from '../src/authority/shared-generate.ts';
import type { GateAnswer } from '../src/routing.ts';
import { BOARD, headerOf, open, type Opened, pageOf } from './support/shared-fixture.ts';

/**
 * A shared view's artifacts and the deployments of the site: an artifact is a page as one
 * deployment rendered it, and is answered to a request of that deployment alone — never of
 * another, whatever the two share, nor after a restart, nor where the question names none. Another
 * deployment's question has the page made again for it once the one kept has held its place for
 * `DEPLOYMENT_HOLD_MS`, and is let through to its own page meanwhile. Against the engine-only
 * application of `support/shared-fixture.ts`, its site serving one deployment and then another.
 */

const FIRST = 'dpl_first';
const SECOND = 'dpl_second';
/** When the tests start, by the engine's clock. */
const STARTED = Date.UTC(2026, 9, 17);

/** The site of the fixture, its every answer naming the deployment `serving.now` says it serves. */
function deployedSite(serving: { now: string }): (engine: Engine) => SiteFetch {
  return (engine) => {
    const render = pageOf(engine);
    return async (asked, headers, signal) => {
      const answer = await render(asked, headers, signal);
      const named = new Headers(answer.headers);
      named.set('x-nextjs-deployment-id', serving.now);
      return new Response(answer.body, { headers: named, status: answer.status });
    };
  };
}

/** The gate's answer to a request of p1's board, of `deployment` where one is named. */
async function boardOf(
  engine: Engine,
  deployment: string | undefined,
  headers: Readonly<Record<string, string>> = {},
): Promise<GateAnswer> {
  return engine.gate({
    headers,
    method: 'GET',
    route: BOARD,
    url: '/boards/p1',
    ...(deployment !== undefined && { deployment }),
  });
}

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-deployments-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

/** The fixture over `filename`, its site serving `serving.now`, its clock `clock.now`. */
async function opened(
  serving: { now: string },
  clock: { now: number },
  filename?: string,
): Promise<Opened> {
  return open({
    clock: () => clock.now,
    site: deployedSite(serving),
    ...(filename !== undefined && { filename }),
  });
}

describe('a shared view’s artifacts and the deployments of the site', () => {
  it('answers an artifact only to a question of the deployment that made it, and has another’s made again once the one kept held its place', async () => {
    const serving = { now: FIRST };
    const clock = { now: STARTED };
    const { asked, engine } = await opened(serving, clock);
    const first = await boardOf(engine, FIRST);
    // The site goes on to serve another deployment of the same build.
    serving.now = SECOND;

    expect(first).toMatchObject({ kind: 'respond', status: 200 });
    // Within the hold: let through to its own page, never answered with the first's.
    await expect(boardOf(engine, SECOND)).resolves.toStrictEqual({ kind: 'pass' });
    expect(asked).toHaveLength(2);

    clock.now += DEPLOYMENT_HOLD_MS + 1;
    const second = await boardOf(engine, SECOND, {
      'if-none-match': headerOf(first, 'etag') ?? '',
    });

    // Made again of the site as it serves now, the browser's copy of the first no 304 of it.
    expect(second).toMatchObject({ kind: 'respond', status: 200 });
    expect(headerOf(second, 'etag')).not.toBe(headerOf(first, 'etag'));
    expect(asked).toHaveLength(3);
    // Neither the first deployment's late request, nor one that names none, is answered with it.
    await expect(boardOf(engine, FIRST)).resolves.toStrictEqual({ kind: 'pass' });
    await expect(boardOf(engine, undefined)).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('answers after a restart none of the artifacts it kept to a question of another deployment than made them', async () => {
    const serving = { now: FIRST };
    const clock = { now: STARTED };
    const filename = await databaseFile();
    const before = await opened(serving, clock, filename);
    const kept = await boardOf(before.engine, FIRST);
    await before.close();
    // Deployed anew — a stylesheet, a chunk, Next.js itself — with the same build of the views.
    serving.now = SECOND;
    const after = await opened(serving, clock, filename);

    // The view kept as it was: its artifact, of the first, let through within the hold.
    await expect(boardOf(after.engine, SECOND)).resolves.toStrictEqual({ kind: 'pass' });
    expect(after.asked).toStrictEqual([]);

    clock.now += DEPLOYMENT_HOLD_MS + 1;
    const answer = await boardOf(after.engine, SECOND);

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
    expect(headerOf(answer, 'etag')).not.toBe(headerOf(kept, 'etag'));
    expect(after.asked).toStrictEqual([{ path: '/boards/p1', rsc: false }]);
  });

  it('reads the deployment that made an artifact off its answer: a payload’s header, a document’s `<html>`', () => {
    const named = new Headers({ 'x-nextjs-deployment-id': SECOND });
    const document = `<!DOCTYPE html><html data-dpl-id="${FIRST}" lang="ja"><head></head></html>`;

    expect(deploymentOf(named, '0:{}')).toBe(SECOND);
    expect(deploymentOf(new Headers(), document)).toBe(FIRST);
    expect(deploymentOf(new Headers(), '<!DOCTYPE html><html lang="ja"></html>')).toBe('');
    expect(deploymentOf(new Headers(), `<html lang="ja"><body data-dpl-id="${FIRST}">`)).toBe('');
  });
});
