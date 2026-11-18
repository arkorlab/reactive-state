/**
 * The proofs that follow each name or callback a value is written as — `retained-match-paths.ts`,
 * `retained-match-receivers.ts`, `local-writes.ts` — stop at one they are already following, a
 * cycle, where they answer as the conservative reading does. An answer that no such stop shaped is
 * the same however the name is reached, so it is kept: a chain of names that each branch names
 * twice (`const s1 = flag ? s0 : s0.trim()`) then costs a proof of each name, not one of each path
 * through the chain, which doubles with each name.
 */

const STOPS = { count: 0 };

/** Whether `visiting` holds `node` already: the proof stops there, and notes that it did. */
export function isVisiting<T>(visiting: ReadonlySet<T>, node: T): boolean {
  const isHeld = visiting.has(node);
  if (isHeld) {
    STOPS.count += 1;
  }
  return isHeld;
}

/** `compute()`, kept in `cache` by `key` where no stop shaped it, and read from there after. */
export function whereUnstopped<K extends WeakKey, V>(
  cache: WeakMap<K, V>,
  key: K,
  compute: () => V,
): V {
  const known = cache.get(key);
  if (known !== undefined) {
    return known;
  }
  const before = STOPS.count;
  const answer = compute();
  if (STOPS.count === before) {
    cache.set(key, answer);
  }
  return answer;
}
