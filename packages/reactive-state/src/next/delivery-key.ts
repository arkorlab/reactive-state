/**
 * The build's delivery key (`DELIVERY_KEY_ENV`), kept out of every answer the delivery route hands
 * on. The route asks for a page with the key in `DIRECT_HEADER`, which Next.js hands the page with
 * the rest of the request's headers — there is no point between its rewrite's condition and the
 * page where it could be taken off — so a page that reflects its request's headers would hand the
 * key on. The route hands on no answer that holds it: one whose headers or status text hold it is
 * refused before anything of it is sent (`holdsKey`), and a body is read for it as it streams
 * (`keptFromBody`), ended at the first byte of it, which none of it is sent past.
 *
 * The key is base64url (`deliveryKey`, the adapter's): letters, digits, `-` and `_`, which neither a
 * URL, JSON nor HTML escapes — the one spelling of it an application would reflect.
 */

/**
 * Whether `response`'s headers — a name or a value of one — or its status text hold `key`. A
 * header's name is handed on lowercased, whatever case the answer wrote it in, and the key has
 * letters of both cases: a name is read for the key lowercased. A value and the status text keep
 * their case, and are read for the key as it was issued — the one spelling the rewrite's condition
 * matches.
 */
export function holdsKey(response: Response, key: string): boolean {
  if (response.statusText.includes(key)) {
    return true;
  }
  const lowered = key.toLowerCase();
  for (const [name, value] of response.headers) {
    if (name.includes(lowered) || value.includes(key)) {
      return true;
    }
  }
  return false;
}

/** Whether `haystack` holds `needle`: each place its first byte is at tried, as `indexOf` finds it. */
function holdsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const [first = 0] = needle;
  const last = haystack.length - needle.length;
  let at = haystack.indexOf(first);
  while (at !== -1 && at <= last) {
    const from = at;
    if (needle.every((byte, offset) => haystack[from + offset] === byte)) {
      return true;
    }
    at = haystack.indexOf(first, at + 1);
  }
  return false;
}

/**
 * How many of `bytes`' last bytes are the start of `needle` — the longest such end, shorter than
 * the needle — which a byte that comes after them may make the needle of.
 */
function startOfNeedle(bytes: Uint8Array, needle: Uint8Array): number {
  for (let length = Math.min(needle.length - 1, bytes.length); length > 0; length -= 1) {
    const start = bytes.length - length;
    if (needle.subarray(0, length).every((byte, offset) => bytes[start + offset] === byte)) {
      return length;
    }
  }
  return 0;
}

/** `a`, then `b`, as one array; either alone where the other is empty. */
function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return both;
}

/** What a body that held the key is ended with: naming nothing of it. */
const KEY_IN_BODY = 'The page answered what the delivery route hands on no part of.';

/**
 * `body` as it streams, read for `key`: each chunk handed on as it comes but for its last bytes
 * where they are the start of the key (`startOfNeedle`), held until the next shows whether the key
 * goes on — a key split across chunks is found whole — and the stream ended with an error, nothing
 * more of it handed on, where the key is found: no byte of the key is handed on. A body that ends
 * on the start of the key alone is handed on whole.
 */
export function keptFromBody(
  body: ReadableStream<Uint8Array>,
  key: string,
): ReadableStream<Uint8Array> {
  const needle = new TextEncoder().encode(key);
  let held = new Uint8Array(0);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        if (held.length > 0) {
          controller.enqueue(held);
        }
      },
      transform(chunk, controller) {
        const read = joined(held, chunk);
        if (holdsBytes(read, needle)) {
          controller.error(new Error(KEY_IN_BODY));
          return;
        }
        const kept = startOfNeedle(read, needle);
        held = read.slice(read.length - kept);
        if (read.length > kept) {
          controller.enqueue(read.subarray(0, read.length - kept));
        }
      },
    }),
  );
}
