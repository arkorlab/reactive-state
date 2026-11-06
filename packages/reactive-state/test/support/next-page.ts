import { createRequire } from 'node:module';

/**
 * A param as Next.js hands one to a page, for the suites' stand-ins for a route's page: what the
 * page renders its root of, and so the view it asks the authority for.
 */

/** How Next.js's app render reads a param it hands user code (`get-dynamic-param.ts`). */
const { getDynamicParam } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/get-dynamic-param.js',
) as {
  readonly getDynamicParam: (
    params: Readonly<Record<string, string>>,
    key: string,
    type: 'd',
    fallback: null,
  ) => { readonly value: string };
};

/**
 * The param Next.js hands a page for `segment`, a segment of its path: decoded, as its router's
 * matcher decodes one (`getRouteMatcher`), and encoded again by its app render, as the value it
 * passes to user code (`getDynamicParam`) — `a%2Fb` of `a%2Fb`, `caf%C3%A9` of `caf%c3%a9`. A page
 * of `next start` answers so (Next.js 16.4.2).
 */
export function nextPageParam(segment: string): string {
  return getDynamicParam({ param: decodeURIComponent(segment) }, 'param', 'd', null).value;
}
