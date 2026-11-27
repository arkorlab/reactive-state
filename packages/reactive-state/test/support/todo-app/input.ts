/**
 * The test application's `@/input`, as the fixture's: a form's text, checked on the server — its
 * length in code points, the database's unit, as the CHECK of the column it is written to counts
 * (`schema.ts`), where the old application's counted UTF-16 units, as its fields did.
 */
/** The code points of `text`: its UTF-16 units, each pair of surrogates one. */
function codePointsOf(text: string): number {
  return text.length - (text.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length;
}

export function requiredText(form: FormData, key: string, maxLength: number): string {
  const raw = form.get(key);
  if (typeof raw !== 'string') throw new TypeError(`${key} must be text`);
  const value = raw.trim();
  const length = codePointsOf(value);
  if (length === 0 || length > maxLength) {
    throw new RangeError(`${key} must contain 1..${String(maxLength)} characters`);
  }
  return value;
}

/** The fixture's `@/domain/estimate`: the update the browser predicts and the authority runs. */
export function addEstimate(current: number, step: number): number {
  return Math.min(1_000_000, Math.max(0, current + step));
}
