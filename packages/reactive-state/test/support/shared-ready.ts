import { describe, expect, it } from 'vitest';

import { Dependencies } from '../../src/authority/dependencies.ts';
import { type Entry, missedOf } from '../../src/authority/shared-entry.ts';
import type { ViewClaims } from '../../src/authority/view-tokens.ts';
import type { RouteRegistration } from '../../src/routing.ts';

const ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'ready/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: 'components/ready',
  route: '/ready/[id]',
  shared: true,
};
const CLAIMS: ViewClaims = {
  build: 'ready-build',
  epoch: 1,
  generation: 1,
  params: { id: 'main' },
  route: ROUTE.route,
};

/** A protocol entry whose status is the authority's existing publication decision. */
function entry(status: Entry['status'], epoch = 1, generation = 1): Entry {
  return {
    dependencies: new Dependencies(),
    digest: '',
    epoch,
    generation,
    key: 'ready-view',
    observed: 0,
    params: CLAIMS.params,
    revision: 0,
    route: ROUTE,
    status,
  };
}

/** Current READY is a positive signal; unknown or unfinished view state cannot fabricate one. */
export function sharedReadyCases(): void {
  describe('the authenticated shared following initial state', () => {
    it('announces a ready view even when its token already names the current moment', () => {
      expect(missedOf(entry('ready'), CLAIMS)).toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
      ]);
    });

    it('retains the newest generation notice', () => {
      expect(missedOf(entry('ready', 1, 2), CLAIMS)).toStrictEqual([
        { epoch: 1, generation: 2, kind: 'ready' },
      ]);
    });

    it('keeps a denial before the ready generation of its newer epoch', () => {
      expect(missedOf(entry('ready', 2, 2), CLAIMS)).toStrictEqual([
        { epoch: 2, kind: 'denied' },
        { epoch: 2, generation: 2, kind: 'ready' },
      ]);
    });

    it.each(['new', 'dirty', 'pending', 'private'] as const)(
      'does not announce unpublished %s state or missing artifacts as ready',
      (status) => {
        expect(missedOf(entry(status), CLAIMS)).toStrictEqual([]);
      },
    );

    it.each(['denied', 'responded'] as const)('announces %s state only as denied', (status) => {
      expect(missedOf(entry(status), CLAIMS)).toStrictEqual([{ epoch: 1, kind: 'denied' }]);
    });
  });
}

/** A malformed or signed-but-refused view retains the real stream admission boundary. */
export async function refusedSharedView(
  kind: string,
  token: (fields?: {
    readonly build?: string;
    readonly route?: string;
  }) => string | Promise<string>,
): Promise<string> {
  if (kind === 'malformed') return 'not-a-view';
  if (kind === 'wrong build') return token({ build: 'other' });
  if (kind === 'unknown route') return token({ route: '/unknown/[id]' });
  const view = await token();
  return `${view.split('.', 1)[0] ?? ''}.forged`;
}
