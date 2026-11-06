/**
 * What the authority's Durable Object reads from its environment: where the application it delivers
 * its change log to is, and what its requests there present. All of it is optional: an object
 * without it answers everything else, and keeps why it delivers nothing (`delivery.ts`).
 */
export interface AuthorityEnv {
  /** The internal token the application's own routes take (`x-reactive-internal`). */
  readonly REACTIVE_ENGINE_TOKEN?: string;
  /** The application's origin, for the change log and a shared view's artifacts. */
  readonly REACTIVE_SITE_URL?: string;
  /** A bypass of the site's access protection, when it has one, sent in the header named below. */
  readonly REACTIVE_ACCESS_BYPASS?: string;
  /** The header the site's access protection takes a bypass in; without it, none is sent. */
  readonly REACTIVE_ACCESS_BYPASS_HEADER?: string;
}

/** A bypass of the site's access protection: the header it goes in, and its value. */
export interface SiteBypass {
  readonly header: string;
  readonly value: string;
}

/** Where the change log is delivered, and what its requests carry; or why it is not. */
export type SiteTarget =
  | {
      readonly kind: 'site';
      /** The origin, without a trailing slash, that the application's paths are appended to. */
      readonly origin: string;
      readonly token: string;
      readonly bypass: SiteBypass | undefined;
    }
  | { readonly kind: 'disabled'; readonly reason: string };

/** A header's name as HTTP writes one: a token of RFC 9110's characters. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/u;

/** A variable left empty, which reads as one not set. */
function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * The site the change log goes to (`REACTIVE_SITE_URL`), the internal token its route takes, and
 * the bypass its access protection lets through, where the environment names both its header and
 * its value. Without a site or a token, the log stays where it is — the reason is answered
 * instead, for the object to keep.
 */
export function siteOf(env: AuthorityEnv): SiteTarget {
  const site = setting(env.REACTIVE_SITE_URL);
  if (site === undefined) {
    return {
      kind: 'disabled',
      reason: 'REACTIVE_SITE_URL is not set: there is no site to deliver to.',
    };
  }
  if (!URL.canParse(site)) {
    return { kind: 'disabled', reason: `${site} is not a URL to deliver to.` };
  }
  const credential = setting(env.REACTIVE_ENGINE_TOKEN);
  if (credential === undefined) {
    return {
      kind: 'disabled',
      reason: 'REACTIVE_ENGINE_TOKEN is not set: the site takes no change without it.',
    };
  }
  const header = setting(env.REACTIVE_ACCESS_BYPASS_HEADER);
  if (header !== undefined && !HEADER_NAME.test(header)) {
    return {
      kind: 'disabled',
      reason: `REACTIVE_ACCESS_BYPASS_HEADER is no header name: ${header}`,
    };
  }
  const value = setting(env.REACTIVE_ACCESS_BYPASS);
  return {
    bypass: header === undefined || value === undefined ? undefined : { header, value },
    kind: 'site',
    origin: withoutTrailingSlashes(site),
    token: credential,
  };
}
