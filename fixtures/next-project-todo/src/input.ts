// Throwing within db.transaction aborts before commit. The generated operation boundary reports
// this as a definitive rejection, not a network failure whose commit outcome is unknown.
export function requiredText(form: FormData, key: string, maxLength: number): string {
  const raw = form.get(key);
  if (typeof raw !== 'string') throw new TypeError(`${key} must be text`);
  const value = raw.trim();
  if (value.length === 0 || value.length > maxLength) {
    throw new RangeError(`${key} must contain 1..${maxLength} characters`);
  }
  return value;
}
