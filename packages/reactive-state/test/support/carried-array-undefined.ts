import { describe, expect, it } from 'vitest';

import { isCarriedJson, isJson } from '../../src/authority/canonical.ts';
import { fitsJson, fitsJsonCharacters, MAX_CARRIED_BYTES } from '../../src/authority/json-size.ts';
import {
  fieldOperationOf,
  operationCallOf,
  rootOf,
  viewRequestOf,
} from '../../src/authority/requests.ts';
import { type Json, VIEW_LIMITS } from '../../src/program.ts';

const LIMITS = { captures: 4096, arguments: 262_144, depth: 64 } as const;

function root<T>(props: T) {
  return { build: 'test', component: 'test/root', props };
}

function field(captures: unknown) {
  return { binding: 'binding', operationId: 'op:1', updaterId: 'update', captures };
}

function call(value: unknown) {
  return {
    args: [{ json: value }],
    build: 'test',
    module: 'domain/actions',
    name: 'save',
    operationId: 'op:1',
  };
}

/** The HTTP transport writes JSON rather than preserving structured-clone entries. */
function transportText(value: unknown): string {
  return JSON.stringify(value);
}

function http(value: unknown): unknown {
  return JSON.parse(transportText(value));
}

function nested(depth: number): unknown {
  let result: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    result = [result];
  }
  return result;
}

function malformed(kind: string) {
  let reads = 0;
  const list: unknown[] = [null];
  if (kind === 'accessor') {
    Object.defineProperty(list, '0', {
      enumerable: true,
      get() {
        reads += 1;
        return null;
      },
    });
  } else if (kind === 'nonenumerable') {
    Object.defineProperty(list, '0', { enumerable: false, value: undefined });
  } else {
    const key = kind === 'symbol' ? Symbol('metadata') : 'metadata';
    Object.defineProperty(list, key, { enumerable: true, value: undefined });
  }
  return { list, reads: () => reads };
}

/** Identical transport checks registered in each native test runtime. */
export function carriedArrayUndefinedChecks(): void {
  describe('own undefined array entries carried by authority transports', () => {
    it('accepts own undefined only in carried arrays while retaining strict state checks', () => {
      const list = [undefined];

      expect(Object.hasOwn(structuredClone(list), 0)).toBe(true);
      expect(structuredClone(list)[0]).toBeUndefined();
      expect(http(list)).toStrictEqual([null]);
      expect(isCarriedJson(list)).toBe(true);
      expect(isJson(list)).toBe(false);
      expect(isJson([null])).toBe(true);
    });

    it('normalizes root RPC entries exactly as HTTP without changing source slots or holes', () => {
      const list: unknown[] = [undefined];
      list.length = 2;
      list.push({ nested: [undefined], omitted: undefined, zero: -0 });
      const request = root({ list });
      const result = rootOf(structuredClone(request));

      expect(result).toStrictEqual(rootOf(http(request)));
      expect(result.props).toStrictEqual({ list: [null, null, { nested: [null], zero: 0 }] });
      expect(Object.hasOwn(list, 0)).toBe(true);
      expect(list[0]).toBeUndefined();
      expect(Object.hasOwn(list, 1)).toBe(false);
      expect(Object.getPrototypeOf(result.props['list'])).toBe(Array.prototype);
    });

    it('normalizes view inputs from RPC and HTTP alike', () => {
      const request = { subscription: 'frame', view: { part: { rows: { list: [undefined] } } } };

      expect(viewRequestOf(structuredClone(request))).toStrictEqual(viewRequestOf(http(request)));
      expect(viewRequestOf(request).view).toStrictEqual({ part: { rows: { list: [null] } } });
    });

    it('normalizes captured values from RPC and HTTP alike', () => {
      const request = field({ list: [undefined] });

      expect(fieldOperationOf(structuredClone(request))).toStrictEqual(
        fieldOperationOf(http(request)),
      );
      expect(fieldOperationOf(request).captures).toStrictEqual({ list: [null] });
    });

    it('normalizes operation JSON arguments from RPC and HTTP alike', () => {
      const request = call({ list: [undefined] });

      expect(operationCallOf(structuredClone(request))).toStrictEqual(
        operationCallOf(http(request)),
      );
      expect(operationCallOf(request).args).toStrictEqual([{ json: { list: [null] } }]);
    });

    it('measures null expansion at the exact UTF-8 and character boundaries', () => {
      const value = [undefined, '界', [undefined]] as unknown as Json;
      const text = transportText(value);
      const bytes = new TextEncoder().encode(text).byteLength;

      expect(fitsJson(value, bytes)).toBe(true);
      expect(fitsJson(value, bytes - 1)).toBe(false);
      expect(fitsJsonCharacters(value, text.length)).toBe(true);
      expect(fitsJsonCharacters(value, text.length - 1)).toBe(false);
    });

    it('keeps the complete root byte budget before normalization', () => {
      const request = root({ list: [undefined], text: '' });
      request.props.text = 'x'.repeat(MAX_CARRIED_BYTES - transportText(request).length);

      expect(rootOf(request)).toStrictEqual(rootOf(http(request)));

      request.props.text += 'x';

      expect(() => rootOf(request)).toThrow('The request is too large.');
      expect(() => rootOf(http(request))).toThrow('The request is too large.');
    });

    it('keeps the exact view byte budget after null expansion', () => {
      const request = {
        subscription: 'frame',
        view: { part: { rows: { list: [undefined], text: '' } } },
      };
      request.view.part.rows.text = 'x'.repeat(
        VIEW_LIMITS.bytes - transportText(request.view).length,
      );

      expect(viewRequestOf(request)).toStrictEqual(viewRequestOf(http(request)));

      request.view.part.rows.text += 'x';

      expect(() => viewRequestOf(request)).toThrow("Name the frame's subscription");
      expect(() => viewRequestOf(http(request))).toThrow("Name the frame's subscription");
    });

    it('keeps captured character limits after null expansion', () => {
      const captures = { list: [undefined], text: '' };
      captures.text = 'x'.repeat(LIMITS.captures - transportText(captures).length);

      const request = field(captures);

      expect(fieldOperationOf(request)).toStrictEqual(fieldOperationOf(http(request)));

      captures.text += 'x';

      expect(() => fieldOperationOf(field(captures))).toThrow('The update captured too much.');
      expect(() => fieldOperationOf(http(field(captures)))).toThrow(
        'The update captured too much.',
      );
    });

    it('keeps operation argument character limits after null expansion', () => {
      const value = { list: [undefined], text: '' };
      value.text = 'x'.repeat(LIMITS.arguments - transportText(call(value).args).length);

      const request = call(value);

      expect(operationCallOf(request)).toStrictEqual(operationCallOf(http(request)));

      value.text += 'x';

      expect(() => operationCallOf(call(value))).toThrow('characters of arguments at most');
      expect(() => operationCallOf(http(call(value)))).toThrow('characters of arguments at most');
    });

    it('keeps top-level undefined invalid and object undefined entries omitted', () => {
      expect(isCarriedJson(undefined)).toBe(false);
      expect(isJson(undefined)).toBe(false);
      expect(rootOf(root({ omitted: undefined, list: [null] })).props).toStrictEqual({
        list: [null],
      });
    });

    it.each(['accessor', 'nonenumerable', 'symbol', 'named'])(
      'rejects array %s metadata without reading a value',
      (kind) => {
        const { list, reads } = malformed(kind);

        expect(isCarriedJson(list)).toBe(false);
        expect(() => rootOf(root({ list }))).toThrow('props as a JSON object');
        expect(reads()).toBe(0);
      },
    );

    it('keeps the nesting limit for carried arrays and the strict hole refusal', () => {
      expect(isCarriedJson(nested(LIMITS.depth))).toBe(true);
      expect(isCarriedJson(nested(LIMITS.depth + 1))).toBe(false);

      const holes: unknown[] = [];
      holes.length = 1;

      expect(isCarriedJson(holes)).toBe(true);
      expect(isJson(holes)).toBe(false);
    });

    it('keeps cycles invalid and repeated ordinary references valid', () => {
      const cycle: unknown[] = [];
      cycle.push(cycle);
      const ordinary = { value: null };

      expect(isCarriedJson(cycle)).toBe(false);
      expect(isCarriedJson([ordinary, ordinary])).toBe(true);
    });
  });
}
