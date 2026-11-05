import type { Json } from '../program.ts';

/** The size of a JSON value, bounded before writing its text or expanding array holes. */

/** The largest JSON request either authority transport reads, as the Node body reader limits it. */
export const MAX_CARRIED_BYTES = 1_048_576;

const WIDTH = {
  ascii: 127,
  control: 31,
  escaped: 6,
  four: 4,
  highSurrogate: 0xd8_00,
  lowSurrogate: 0xdf_ff,
  three: 3,
  twoBytes: 2047,
};
const SHORT_ESCAPES: ReadonlySet<string> = new Set(['\t', '\n', '\f', '\r', '\b', '"', '\\']);

interface Budget {
  remaining: number;
  readonly utf8: boolean;
}

function spend(bytes: number, budget: Budget): boolean {
  budget.remaining -= bytes;
  return budget.remaining >= 0;
}

/** The bytes or UTF-16 units of a JSON character, including lone-surrogate escaping. */
function characterSize(character: string, utf8: boolean): number {
  if (SHORT_ESCAPES.has(character)) {
    return 2;
  }
  const point = character.codePointAt(0) ?? 0;
  if (point <= WIDTH.control || (point >= WIDTH.highSurrogate && point <= WIDTH.lowSurrogate)) {
    return WIDTH.escaped;
  }
  if (!utf8) {
    return character.length;
  }
  if (character.length === 2) {
    return WIDTH.four;
  }
  if (point <= WIDTH.ascii) {
    return 1;
  }
  return point <= WIDTH.twoBytes ? 2 : WIDTH.three;
}

function stringFits(value: string, budget: Budget): boolean {
  if (!spend(2, budget)) {
    return false;
  }
  for (const character of value) {
    if (!spend(characterSize(character, budget.utf8), budget)) {
      return false;
    }
  }
  return true;
}

function arrayFits(value: readonly Json[], budget: Budget): boolean {
  const entries = Object.values<Json | undefined>(value);
  const holes = value.length - entries.length;
  const punctuation = 2 + Math.max(0, value.length - 1);
  return (
    spend(punctuation + holes * WIDTH.four, budget) &&
    entries.every((item) => valueFits(item === undefined ? null : item, budget))
  );
}

function objectFits(value: Readonly<Record<string, Json | undefined>>, budget: Budget): boolean {
  if (!spend(2, budget)) {
    return false;
  }
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    if (!spend(first ? 1 : 2, budget) || !stringFits(key, budget) || !valueFits(item, budget)) {
      return false;
    }
    first = false;
  }
  return true;
}

function valueFits(value: Json, budget: Budget): boolean {
  if (typeof value === 'string') {
    return stringFits(value, budget);
  }
  if (value === null || typeof value !== 'object') {
    return spend(String(value).length, budget);
  }
  return Array.isArray(value)
    ? arrayFits(value as readonly Json[], budget)
    : objectFits(value as Readonly<Record<string, Json | undefined>>, budget);
}

/** Whether known carried JSON fits the byte budget, without serializing it. */
export function fitsJson(value: Json, bytes: number): boolean {
  return valueFits(value, { remaining: bytes, utf8: true });
}

/** Whether known carried JSON fits the serialized UTF-16 character budget without writing it. */
export function fitsJsonCharacters(value: Json, characters: number): boolean {
  return valueFits(value, { remaining: characters, utf8: false });
}
