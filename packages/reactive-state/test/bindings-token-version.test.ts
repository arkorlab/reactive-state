import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  sessionTag,
  TOKEN_VERSION,
  verifyBinding,
  verifySubscription,
} from '../src/authority/bindings.ts';
import { verifyView } from '../src/authority/view-tokens.ts';

const SECRET = 'test-token-signing-secret';
const SESSION = 'session-1';

/**
 * A token signed with the authority's secret, as `signed` writes one, of claims as they are given:
 * of another version of them, as an authority before or after this one signs them.
 */
function signedAs(claims: Readonly<Record<string, unknown>>): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', SECRET).update(encoded).digest('base64url')}`;
}

/** What `verify` throws: the refusal it answers its token with. */
function refusalOf(verify: () => unknown): unknown {
  try {
    verify();
  } catch (error) {
    return error;
  }
  throw new Error('The token was taken.');
}

const ROOT = { component: 'components/todo', props: { id: 't1' } };

/** What each kind of token says, as another version of the authority signed it, for its build. */
const BEFORE = { build: 'b_before', v: TOKEN_VERSION + 1 };
const BINDING = {
  ...BEFORE,
  exp: Number.MAX_SAFE_INTEGER,
  field: 'title',
  key: 'title',
  path: [],
  record: 't1',
  root: ROOT,
  session: sessionTag(SECRET, SESSION),
  t: 'binding',
  table: 'todos',
  user: 'alice',
};
const SUBSCRIPTION = {
  ...BEFORE,
  digest: 'ab',
  revision: 1,
  root: ROOT,
  session: sessionTag(SECRET, SESSION),
  t: 'subscription',
  view: {},
};
const VIEW = {
  ...BEFORE,
  epoch: 0,
  generation: 1,
  params: { id: 't1' },
  route: '/todos/[id]',
  t: 'view',
};

/** Each kind of token, as another version signed it, checked by an authority of `build`. */
const VERIFIED: readonly (readonly [string, (build: string) => unknown])[] = [
  [
    'a binding',
    (build) =>
      verifyBinding(SECRET, signedAs(BINDING), { build, now: 0, session: SESSION, user: 'alice' }),
  ],
  [
    'a subscription',
    (build) => verifySubscription(SECRET, signedAs(SUBSCRIPTION), { build, session: SESSION }),
  ],
  ['a view token', (build) => verifyView(SECRET, signedAs(VIEW), build)],
];

describe('a token of another version of the claims', () => {
  it.each(VERIFIED)(
    'is refused as another build’s where %s is of one, for its page to reload',
    (_, verified) => {
      expect(refusalOf(() => verified('b_after'))).toMatchObject({
        code: 'BUILD_MISMATCH',
        status: 409,
      });
    },
  );

  it.each(VERIFIED)(
    'is refused as no token of this authority’s where %s is of this build',
    (_, verified) => {
      expect(refusalOf(() => verified('b_before'))).toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    },
  );
});
