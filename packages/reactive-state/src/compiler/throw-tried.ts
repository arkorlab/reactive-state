/** Whether a known native operation throws of the statically written arguments it is given. */
export function throwsTried<T>(tried: (given: T) => unknown, values: T): boolean {
  try {
    tried(values);
    return false;
  } catch {
    return true;
  }
}
