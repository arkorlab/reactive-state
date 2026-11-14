import type { Node } from 'typescript/ast';

/** What the reads of the objects a constant holds have covered, so that each is read once. */

/**
 * The names the fields after one have set: a setter after a getter completes its accessor, and a
 * setter hides a value written before it; every other field hides both.
 */
export interface Hidden {
  readonly data: ReadonlySet<string>;
  readonly getters: ReadonlySet<string>;
  /**
   * The names the descriptor that inherits the one read sets itself: they hide its getters, not what
   * they write. Present only for the read of a prototype, whose getters run on another descriptor.
   */
  readonly own?: ReadonlySet<string> | undefined;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** No name hidden: the state a read of a source starts from. */
export const NOTHING_HIDDEN: Hidden = { data: new Set(), getters: new Set() };

/** How many reads of one object are kept apart: past it, one read under their common names covers all. */
const READS = { kept: 4 } as const;

/** What reads of the objects a constant holds have covered, apart for each slot read: none is all of them. */
export type SlotReads = Map<number | undefined, Map<Node, readonly Hidden[]>>;

/**
 * The names to read an object under for a slot, none where it has already been read for the slot, or
 * for every slot, under names hidden no more than now: a read of one slot reads no entry another
 * asks for, and a read of every slot reads what any slot does.
 */
export function readUnderSlot(
  reads: SlotReads,
  index: number | undefined,
  held: Node,
  hidden: Hidden,
): Hidden | undefined {
  const every = reads.get(undefined);
  if (index !== undefined && every !== undefined && coveredBy(every.get(held) ?? [], hidden))
    return undefined;
  const table = reads.get(index) ?? new Map<Node, readonly Hidden[]>();
  reads.set(index, table);
  return readUnder(table, held, hidden);
}

/** Whether one of the reads hid no more names than now. */
function coveredBy(earlier: readonly Hidden[], hidden: Hidden): boolean {
  return earlier.some((each) => {
    return (
      isSubset(each.data, hidden.data) &&
      isSubset(each.getters, hidden.getters) &&
      coversOwn(each.own, hidden.own)
    );
  });
}

/**
 * Whether a read under the own names `earlier` reads all a read under `now` does: its getters are
 * hidden no more, and a prototype's getters, which count whatever they write, are not read less.
 */
function coversOwn(
  earlier: ReadonlySet<string> | undefined,
  now: ReadonlySet<string> | undefined,
): boolean {
  if (earlier === undefined) return now === undefined;
  return isSubset(earlier, now ?? NO_NAMES);
}

/**
 * The names to read an object under, none where it has already been read under names hidden no
 * more than now: a read under fewer hidden names reads everything a read under more would. Past a
 * few reads kept apart the object is read under the names every read hid, then under none: each
 * covers those before it, so the reads of one object are few however the paths to it multiply.
 */
export function readUnder(
  table: Map<Node, readonly Hidden[]>,
  held: Node,
  hidden: Hidden,
): Hidden | undefined {
  const earlier = table.get(held) ?? [];
  if (coveredBy(earlier, hidden)) return undefined;
  const used = hiddenFor(earlier, hidden);
  const own = used.own === undefined ? undefined : new Set(used.own);
  table.set(held, [...earlier, { data: new Set(used.data), getters: new Set(used.getters), own }]);
  return used;
}

/**
 * The names to read under once `earlier` reads are kept: the names hidden now while there is room;
 * past the room, those every read hid, which covers each of them; then, for good, none (an inherited
 * read, where one was made).
 */
function hiddenFor(earlier: readonly Hidden[], hidden: Hidden): Hidden {
  if (earlier.length < READS.kept) return hidden;
  const reads = [...earlier, hidden];
  return earlier.length === READS.kept ? hiddenInEvery(reads) : hiddenInNone(reads);
}

/**
 * Nothing hidden, for good, and as an inherited read where any of the reads was one: a read that
 * carries the own names of the descriptor that inherits the object is covered only by a read that
 * does, so a fallback without them would leave every such read uncovered, and each would be made again.
 */
function hiddenInNone(reads: readonly Hidden[]): Hidden {
  return reads.some((each) => each.own !== undefined)
    ? { data: NOTHING_HIDDEN.data, getters: NOTHING_HIDDEN.getters, own: NO_NAMES }
    : NOTHING_HIDDEN;
}

/** The names every one of the reads hid, for values and for getters apart. */
function hiddenInEvery(reads: readonly Hidden[]): Hidden {
  const [first, ...rest] = reads;
  if (first === undefined) return NOTHING_HIDDEN;
  const common = (pick: (each: Hidden) => ReadonlySet<string>): Set<string> => {
    const kept = new Set<string>();
    for (const name of pick(first)) if (rest.every((each) => pick(each).has(name))) kept.add(name);
    return kept;
  };
  const inherited = reads.some((each) => each.own !== undefined);
  const own = inherited ? common((each) => each.own ?? NO_NAMES) : undefined;
  return { data: common((each) => each.data), getters: common((each) => each.getters), own };
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  for (const each of small) if (!large.has(each)) return false;
  return true;
}
