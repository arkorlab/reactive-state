import { describe, expect, it } from 'vitest';

import { artifactAnswer } from '../src/authority/gate-answers.ts';
import type { StoredArtifact } from '../src/authority/shared-store.ts';

/**
 * An artifact as the gate answers a request that holds a validator: a 304 where its `If-None-Match`
 * names the artifact's ETag — `*` alone, or an entity-tag of its list, compared weakly — read as
 * RFC 9110 lists entity-tags (§8.8.3, §13.1.2): a comma inside an opaque tag is the tag's own, and a
 * field that is no such list names nothing.
 */

const ETAG = '"rs-0123456789abcdef"';

const ARTIFACT: StoredArtifact = {
  body: '<p>board</p>',
  created: 0,
  deployment: '',
  etag: ETAG,
  generation: 1,
  headers: [['content-type', 'text/html; charset=utf-8']],
  profile: 'document',
  view: 'view',
};

/** The status the gate answers a `GET` of the artifact with, under `ifNoneMatch`. */
function statusFor(ifNoneMatch: string): number | undefined {
  const answer = artifactAnswer(ARTIFACT, {
    headers: { 'if-none-match': ifNoneMatch },
    method: 'GET',
    route: '/boards/[projectId]',
    url: '/boards/p1',
  });
  return answer.kind === 'respond' ? answer.status : undefined;
}

describe('an artifact asked for with If-None-Match', () => {
  it.each([
    ['the tag itself', ETAG],
    ['the tag, weak', `W/${ETAG}`],
    ['the tag among others, after one whose opaque tag holds commas', `"a,b", W/"c" ,${ETAG}`],
    ['the tag after empty elements', ` , ,${ETAG}, `],
    ['`*`, the whole field', ' * '],
  ])('is answered 304 where the field is %s', (_, field) => {
    expect(statusFor(field)).toBe(304);
  });

  it.each([
    ['another tag', '"another"'],
    ['one tag whose commas hold a `*` and the tag’s own text', `"x,*,${ETAG.slice(1, -1)}"`],
    ['`*` among tags', `"another", *`],
    ['a quote left open', ETAG.slice(0, -1)],
    ['two tags with no comma between them', `"another" ${ETAG}`],
    ['the tag after text that is no entity-tag', `junk, ${ETAG}`],
    ['the tag unquoted', ETAG.slice(1, -1)],
    ['the tag weak in lower case', `w/${ETAG}`],
  ])('is answered the artifact where the field is %s', (_, field) => {
    expect(statusFor(field)).toBe(200);
  });
});
