import type { GateRequest } from '../routing.ts';
import { PASS } from './gate-answers.ts';
import type { Wait } from './shared-entry.ts';
import type { StoredArtifact } from './shared-store.ts';

/**
 * Which deployment of the site an artifact answers: the one that made it, alone. An artifact is a
 * page as one deployment rendered it — its stylesheets, its chunks, the deployment's own id — so a
 * request of another deployment is never answered with it, whatever else the two share: the gate
 * has the page made again for that deployment first, or lets the request through to its own page.
 * The store keeps one deployment's artifact of each profile of a view's generation at a time.
 */

/** The header a page answers with the deployment of the site that rendered it (`deploymentId`). */
const DEPLOYMENT_ID_HEADER = 'x-nextjs-deployment-id';

/**
 * How long an artifact one deployment made holds its place against a question of another. While two
 * deployments are asked of at once — the minutes after one goes live, its edge's isolates and the
 * one's before it — each would have the page made again for the other's every request, the store
 * written each time; a question of another deployment meanwhile is let through to its own page.
 */
export const DEPLOYMENT_HOLD_MS = 60_000;

/**
 * What the gate does with a profile's artifact of a view's generation for a question: answers it
 * with the one kept; has one made, where none is kept (`make`), or made again for the question's
 * deployment in place of another's (`remake`); or lets the request through to its page (`pass`).
 */
export type ArtifactFit = 'answer' | 'make' | 'pass' | 'remake';

/**
 * What the gate does with `artifact`, the one kept of a view's generation and profile, for
 * `request`, at `now`. An artifact answers a question of the deployment that made it, and one of a
 * site of none (`''`) a question that names none. Of another deployment, it is made again for the
 * question's, unless it was made within `DEPLOYMENT_HOLD_MS`; a question that names no deployment —
 * an edge older than this — is let through to its page, as nothing says which deployment it is of.
 */
export function fitOf(
  artifact: StoredArtifact | undefined,
  request: GateRequest,
  now: number,
): ArtifactFit {
  if (artifact === undefined) {
    return 'make';
  }
  const asked = request.deployment ?? '';
  if (artifact.deployment === asked) {
    return 'answer';
  }
  if (asked === '' || now - artifact.created < DEPLOYMENT_HOLD_MS) {
    return 'pass';
  }
  return 'remake';
}

/**
 * To wait for an artifact made again for the request's deployment in place of another's — and to
 * let the request through to its page, not a 503, where that faults or takes too long.
 */
export const REMAKING: Wait = Object.freeze({ failed: PASS, kind: 'wait' });

/** The attribute Next.js writes on a document's `<html>` of the deployment that rendered it. */
const DOCUMENT_DEPLOYMENT = /\sdata-dpl-id="([^"]*)"/u;
/** How far into a document its `<html>` is looked for. */
const DOCUMENT_HEAD = 4096;

/** The deployment a document's `<html>` names (`data-dpl-id`); none where it names none. */
function documentDeployment(body: string): string | undefined {
  const start = body.indexOf('<html');
  if (start === -1 || start > DOCUMENT_HEAD) {
    return undefined;
  }
  const end = body.indexOf('>', start);
  return DOCUMENT_DEPLOYMENT.exec(end === -1 ? body.slice(start) : body.slice(start, end))?.[1];
}

/**
 * The deployment of the site whose page answered `headers` and `body`: the one its answer names —
 * a payload in `x-nextjs-deployment-id`, a document on its `<html>` (`data-dpl-id`), as Next.js
 * writes either of the deployment that rendered it — or none (`''`), a site of none.
 */
export function deploymentOf(headers: Headers, body: string): string {
  return headers.get(DEPLOYMENT_ID_HEADER) ?? documentDeployment(body) ?? '';
}
