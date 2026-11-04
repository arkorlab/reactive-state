import type { Expression } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import {
  quietCopy,
  quietElementViews,
  type QuietCopyCall,
  signedInfinity,
} from './framed-copy-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native splice removed arrays preserve quiet source slots at an immediate indexed field read. */

const INFINITY = new Set(['Infinity']);
const NAN = new Set(['NaN']);

/** Exact native deletion bounds select only copied original elements, never later insertion values. */
export function removedArrayViews(
  copy: QuietCopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  const args = framedArgumentPrefix(copy.call, copy.given, Infinity);
  if (args.unknown || args.alternatives !== undefined) return undefined;
  const quiet = quietCopy(copy, args.values, stable);
  if (quiet === undefined) return undefined;
  const range = removedRange(quiet.source.elements.length, args.values);
  if (range === undefined) return undefined;
  if (index !== undefined && (index < 0 || index >= range.count)) return [];
  const values = quiet.source.elements.slice(range.start, range.start + range.count);
  return quietElementViews(
    copy,
    quiet,
    index === undefined ? values : values.slice(index, index + 1),
  );
}

/** Omitted deleteCount removes the suffix; explicit undefined and NaN remove no elements. */
function removedRange(length: number, args: readonly Expression[]) {
  if (args.length === 0) return { start: 0, count: 0 };
  const begin = integer(args[0]);
  const count = args.length === 1 ? Infinity : integer(args[1]);
  if (begin === undefined || count === undefined) return;
  const start = begin < 0 ? Math.max(length + begin, 0) : Math.min(begin, length);
  return { start, count: Math.min(Math.max(count, 0), length - start) };
}

/** Only syntax-proven primitive bounds invoke native integer conversion without application hooks. */
function integer(node: Expression | undefined): number | undefined {
  if (node === undefined) return 0;
  const value = unwrapped(node);
  if (framedNativeConstructor(value, INFINITY)) return Infinity;
  if (framedNativeConstructor(value, NAN)) return 0;
  const signed = signedInfinity(value);
  if (signed !== undefined) return signed;
  const key = framedMapKey(value);
  if (['false', 'null', 'undefined'].includes(key ?? '')) return 0;
  if (key === 'true') return 1;
  if (key?.startsWith('number:') === true)
    return Math.trunc(Number(key.slice('number:'.length))) || 0;
  if (key?.startsWith('text:') === true) return Math.trunc(Number(key.slice('text:'.length))) || 0;
  return undefined;
}
