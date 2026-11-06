/** The test application's `@/input`, as the fixture's: a form's text, checked on the server. */
export function requiredText(form: FormData, key: string, maxLength: number): string {
  const raw = form.get(key);
  if (typeof raw !== 'string') throw new TypeError(`${key} must be text`);
  const value = raw.trim();
  if (value.length === 0 || value.length > maxLength) {
    throw new RangeError(`${key} must contain 1..${String(maxLength)} characters`);
  }
  return value;
}

/** The fixture's `@/domain/estimate`: the update the browser predicts and the authority runs. */
export function addEstimate(current: number, step: number): number {
  return Math.min(1_000_000, Math.max(0, current + step));
}
