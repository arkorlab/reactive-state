import { describe, expect, it } from 'vitest';

import { holdsKey, keptFromBody } from '../src/next/delivery-key.ts';

/**
 * The build's delivery key kept out of what the delivery route hands on (`delivery-key.ts`): an
 * answer whose headers or status text hold it, and a body read for it as it streams — found
 * wherever the chunks it comes in split it, ended there with none of it handed on, and every other
 * byte handed on as it comes.
 */

/** A key whose start comes again within it, which a split may hide a match of in. */
const KEY = 'abab-abab_abab-0123456789';

/** A body that comes in `chunks`, each one of the stream's. */
function chunkedOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** What of a body of `chunks` is handed on past the key, and whether it ended in a fault. */
async function handedOn(
  chunks: readonly string[],
): Promise<{ readonly failed: boolean; readonly text: string }> {
  const reader = keptFromBody(chunkedOf(chunks), KEY).getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        return { failed: false, text };
      }
      text += decoder.decode(read.value, { stream: true });
    }
  } catch {
    return { failed: true, text };
  }
}

describe('the build’s delivery key kept out of an answer', () => {
  it('ends a body at the key wherever two chunks split it, handing on nothing of it', async () => {
    const before = 'x abab-ab ';
    const body = `${before}${KEY} after`;
    const answers = [];
    for (let cut = 0; cut <= body.length; cut += 1) {
      answers.push(await handedOn([body.slice(0, cut), body.slice(cut)]));
    }

    expect(answers.every(({ failed, text }) => failed && before.startsWith(text))).toBe(true);
  });

  it('ends a body at the key that comes a character at a time, handing on nothing of it', async () => {
    const before = 'abab-abab_ab ';
    const body = `${before}${KEY} after`;
    const characters = Array.from({ length: body.length }, (_, at) => body.charAt(at));
    const answer = await handedOn(characters);

    expect(answer.failed).toBe(true);
    expect(before.startsWith(answer.text)).toBe(true);
  });

  it('hands on whole a body that holds the start of the key alone, wherever its chunks split it', async () => {
    const body = `${KEY.slice(0, 10)} ${KEY.slice(0, -1)}`;
    const answers = [];
    for (let cut = 0; cut <= body.length; cut += 1) {
      answers.push(await handedOn([body.slice(0, cut), body.slice(cut)]));
    }

    expect(answers).toStrictEqual(answers.map(() => ({ failed: false, text: body })));
  });

  it('hands on a chunk that ends on no start of the key as it comes, before the next comes', async () => {
    const pending = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<p>first'));
      },
    });
    const reader = keptFromBody(pending, KEY).getReader();
    const first = await reader.read();
    await reader.cancel();

    expect(first).toStrictEqual({ done: false, value: new TextEncoder().encode('<p>first') });
  });

  it('finds the key in a header’s name or value, or in the status text, of an answer', () => {
    expect(
      [
        new Response(null, { headers: { 'x-echo': `a ${KEY} b` } }),
        new Response(null, { headers: { [`x-${KEY}`]: '1' } }),
        new Response(null, { statusText: KEY }),
        new Response(null, { headers: { 'x-echo': KEY.slice(1) } }),
      ].map((response) => holdsKey(response, KEY)),
    ).toStrictEqual([true, true, true, false]);
  });
});

/** A key of both cases, as base64url makes one. */
const MIXED = 'AbC_123-xYz_0123456789';

/**
 * An answer hands on a header's name lowercased, whatever case it was written in, and a value and
 * the status text as they are: the key is found in a name whatever its case, and elsewhere as it
 * was issued alone — the rewrite's condition matches no other spelling of it.
 */
const MIXED_CASES = [
  { held: true, id: 'name-as-issued', init: { headers: { [`X-${MIXED}`]: '1' } } },
  { held: true, id: 'name-lowercased', init: { headers: { [`x-${MIXED.toLowerCase()}`]: '1' } } },
  { held: true, id: 'value-as-issued', init: { headers: { 'x-echo': `a ${MIXED} b` } } },
  { held: true, id: 'status-text-as-issued', init: { statusText: MIXED } },
  { held: false, id: 'value-lowercased', init: { headers: { 'x-echo': MIXED.toLowerCase() } } },
  { held: false, id: 'status-text-uppercased', init: { statusText: MIXED.toUpperCase() } },
  { held: false, id: 'name-of-part-of-it', init: { headers: { [`x-${MIXED.slice(1)}`]: '1' } } },
] as const;

describe('a delivery key of both cases in an answer’s headers', () => {
  it.each(MIXED_CASES)('$id', ({ held, init }) => {
    expect(holdsKey(new Response(null, init), MIXED)).toBe(held);
  });
});
