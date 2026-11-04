import { createRequire } from 'node:module';
import path from 'node:path';

import { caseShadowsOf } from '../compiler/route-shadows.ts';
import { DELIVER_PATH, routeKeyOf } from '../routing.ts';

/** Case-distinct native routes remain distinct when the default delivery rewrites are added. */

interface Rewrite {
  readonly source: string;
  readonly destination: string;
}

/**
 * Refuses a default rewrite that takes a free route's case-distinct path, using the application's
 * own Next.js matcher so internal namespace exclusions and literal pattern characters hold.
 */
export function refuseCaseShadows(
  routes: readonly string[],
  rewrites: { readonly beforeFiles: readonly Rewrite[]; readonly afterFiles: readonly Rewrite[] },
  layout: { readonly projectDir: string; readonly appDir: string; readonly outDir: string },
): void {
  const candidates = caseShadowsOf(routes, layout);
  if (candidates.length === 0) return;
  const fromProject = createRequire(path.join(layout.projectDir, 'package.json'));
  const { getPathMatch } = fromProject('next/dist/shared/lib/router/utils/path-match.js') as {
    readonly getPathMatch: (
      source: string,
      options: { readonly sensitive: boolean; readonly strict: boolean },
    ) => (pathname: string) => false | Readonly<Record<string, unknown>>;
  };
  const all = [...rewrites.beforeFiles, ...rewrites.afterFiles];
  for (const candidate of candidates) {
    const destination = `/api/reactive-state/${DELIVER_PATH}/${routeKeyOf(candidate.route)}`;
    const rewrite = all.find(
      (each) => each.destination === destination || each.destination.startsWith(`${destination}/`),
    );
    if (
      rewrite !== undefined &&
      getPathMatch(rewrite.source, { sensitive: false, strict: true })(candidate.pathname) !== false
    ) {
      throw new Error(candidate.reason);
    }
  }
}
