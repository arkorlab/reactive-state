import { describe, expect, it, vi } from 'vitest';

import { carried, isCarriedJson } from '../src/authority/canonical.ts';
import { fitsJson } from '../src/authority/json-size.ts';
import { rootOf, viewRequestOf } from '../src/authority/requests.ts';
import { type Json, VIEW_LIMITS } from '../src/program.ts';

const BODY_BYTES = 1_048_576;
const FORMER_SPARSE_LENGTH = 524_288;
const NULL_ITEM_BYTES = 5;

function request(items: readonly Json[]) {
  return { build: 'test', component: 'test/root', props: { items } };
}

describe('the serialized size of carried root props', () => {
  it('r113 refuses holes whose null expansion alone exceeds the body limit', () => {
    const items: Json[] = [];
    items.length = FORMER_SPARSE_LENGTH;

    expect(isCarriedJson(items)).toBe(false);
  });

  it('r113 counts the root envelope before allocating a normalized sparse array', () => {
    const items: Json[] = [];
    const envelope = JSON.stringify(request(items)).length;
    items.length = Math.floor((BODY_BYTES - envelope + 1) / NULL_ITEM_BYTES) + 1;
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      expect(() => rootOf(request(items))).toThrow('The request is too large.');
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('r113 counts multiple sparse arrays against one request limit', () => {
    const first: Json[] = [];
    first.length = 120_000;
    const second: Json[] = [];
    second.length = 120_000;

    expect(() =>
      rootOf({ build: 'test', component: 'test/root', props: { first, second } }),
    ).toThrow('The request is too large.');
  });

  it('r113 counts escaped and UTF-8 text alongside a sparse array', () => {
    const items: Json[] = [];
    items.length = 1;
    const text = '\0界'.repeat(120_000);

    expect(() => rootOf({ build: 'test', component: 'test/root', props: { items, text } })).toThrow(
      'The request is too large.',
    );
  });

  it('accepts the last sparse root below the complete serialized request limit', () => {
    const items: Json[] = [];
    const envelope = JSON.stringify(request(items)).length;
    items.length = Math.floor((BODY_BYTES - envelope + 1) / NULL_ITEM_BYTES);

    const rpc = rootOf(request(items));
    const text = JSON.stringify(request(items));
    const parsed: unknown = JSON.parse(text);
    const http = rootOf(parsed);

    expect(rpc).toStrictEqual(http);
    expect(rpc.props['items']).toHaveLength(items.length);
    expect(Object.hasOwn(items, 0)).toBe(false);
  });

  it('normalizes accepted holes as null without changing the caller array', () => {
    const items: Json[] = [];
    items.length = 2;
    items[1] = { zero: -0 };

    expect(isCarriedJson(items)).toBe(true);
    expect(carried(items)).toStrictEqual([null, { zero: 0 }]);
    expect(Object.hasOwn(items, 0)).toBe(false);
  });

  it.each(
    [
      null,
      false,
      -0,
      1e21,
      '"\\\b\t\n\f\r\0',
      'é界😀\u{D800}x\u{DFFF}',
      { 'é\0': [true, 1, { text: '😀' }] },
    ].map((value) => ({ value })),
  )('matches actual JSON UTF-8 size at the exact byte boundary: $value', ({ value }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(fitsJson(value, bytes)).toBe(true);
    expect(fitsJson(value, bytes - 1)).toBe(false);
  });
});

describe('bounded view input validation', () => {
  it.each(['repeated sparse values', 'small sparse siblings', 'escaped UTF-8 text'])(
    'preflights a view before serializing rejected %s',
    (kind) => {
      const items: Json[] = [];
      items.length = kind === 'small sparse siblings' ? 250 : 200_000;
      const inputs =
        kind === 'escaped UTF-8 text'
          ? { text: '\0界'.repeat(400) }
          : { first: items, second: items, third: items };
      const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
        throw new Error('Rejected view serialization must not run.');
      });
      try {
        expect(() =>
          viewRequestOf({ subscription: 'signed', view: { part: { site: inputs } } }),
        ).toThrow("Name the frame's subscription");
        expect(stringify).not.toHaveBeenCalled();
      } finally {
        stringify.mockRestore();
      }
    },
  );
});

describe('normalized bounded views', () => {
  it('accepts the exact view byte boundary and normalizes holes without changing inputs', () => {
    const items: Json[] = [];
    items.length = 2;
    items[1] = -0;
    const view = { part: { site: { items, text: '' } } };
    const overhead = new TextEncoder().encode(JSON.stringify(view)).byteLength;
    view.part.site.text = 'x'.repeat(VIEW_LIMITS.bytes - overhead);

    expect(viewRequestOf({ subscription: 'signed', view }).view).toStrictEqual({
      part: { site: { items: [null, 0], text: view.part.site.text } },
    });
    expect(Object.hasOwn(items, 0)).toBe(false);

    view.part.site.text += 'x';

    expect(() => viewRequestOf({ subscription: 'signed', view })).toThrow(
      "Name the frame's subscription",
    );
  });
});
