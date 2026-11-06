/** What workerd says it is (`navigator.userAgent`): the runtime whose `fetch` is workerd's. */
const WORKERD_AGENT = 'Cloudflare-Workers';
/**
 * The codings the platform's `fetch` undoes as a body is read, `Content-Encoding` and
 * `Content-Length` left as the page sent them. workerd's: `gzip` or `br` alone, as written — the
 * value `Headers` keeps, its blanks around it trimmed; `GZip`, `BR`, `x-gzip` or `gzip, identity` are
 * read as they came. Node's (undici's): these in any case, one over another, every one of the list
 * among them. A body of any other coding — `deflate`, `zstd` or two codings in workerd, one neither
 * knows — is read as it came. `test/cloudflare/coding.test.ts` holds the rule to workerd's own
 * `fetch`, and `test/shared-generate.test.ts` to Node's.
 */
const WORKERD_DECODES: ReadonlySet<string> = new Set(['br', 'gzip']);
const UNDICI_DECODES: ReadonlySet<string> = new Set(['br', 'deflate', 'gzip', 'x-gzip', 'zstd']);
/** The coding that is none (RFC 9110 §8.4.1), and an empty member of the list, which names none. */
const NO_CODINGS: ReadonlySet<string> = new Set(['', 'identity']);

/** The codings `Content-Encoding` names, as HTTP reads the list: in any case, its blanks aside. */
function codingsOf(contentEncoding: string): readonly string[] {
  return contentEncoding
    .toLowerCase()
    .split(',')
    .map((each) => each.trim());
}

/**
 * Whether the platform's `fetch` undid the coding of `response`'s body, which it reads decoded:
 * `Content-Encoding` and `Content-Length` say what the page sent, which is not what is read.
 */
export function isDecoded(response: Response): boolean {
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding === null || response.body === null) {
    return false;
  }
  if (navigator.userAgent === WORKERD_AGENT) {
    return WORKERD_DECODES.has(contentEncoding);
  }
  return codingsOf(contentEncoding).every((each) => UNDICI_DECODES.has(each));
}

/**
 * Whether the body of `response`, read through the platform's `fetch`, is what the page wrote: of
 * no coding — none named, or `identity` alone — or of one that `fetch` undid as it read it
 * (`isDecoded`). One of any other is read as it came, coded, and no text.
 */
export function readsAsWritten(response: Response): boolean {
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding === null || response.body === null) {
    return true;
  }
  return codingsOf(contentEncoding).every((each) => NO_CODINGS.has(each)) || isDecoded(response);
}
