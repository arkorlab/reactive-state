/** The names of a set, and more. */
export function withNames(names: ReadonlySet<string>, more: readonly string[]): Set<string> {
  const merged = new Set(names);
  for (const each of more) merged.add(each);
  return merged;
}
