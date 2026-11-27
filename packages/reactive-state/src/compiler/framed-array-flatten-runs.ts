import type { ArrayElementView } from './framed-array-rest.ts';

/**
 * The segments a flattening makes, in order, as runs that stand side by side and may be one run
 * reached by several paths: an alias spread twice is one run read twice, not a copy of its segments
 * for each path, so that a run's size is the written array's and not the number of positions a flat
 * of it holds. A segment holds the views of one position; it is `fixed` where the position is known.
 */
export interface Run {
  /** The views of a run of one segment; a run of several holds none of its own. */
  readonly views: readonly ArrayElementView[];
  readonly parts: readonly Run[];
  /** How many segments the run holds, and how many of them are fixed in a row from its start and from its end. */
  readonly length: number;
  readonly leading: number;
  readonly trailing: number;
}

/** A run of one segment. */
export function segmentRun(views: readonly ArrayElementView[], fixed: boolean): Run {
  const known = fixed ? 1 : 0;
  return { views, parts: [], length: 1, leading: known, trailing: known };
}

/** Runs one after another: a fixed position starts a run's count of them only while they all are. */
export function joinedRuns(parts: readonly Run[]): Run {
  let length = 0;
  for (const part of parts) length += part.length;
  return { views: [], parts, length, leading: fixedAtStart(parts), trailing: fixedAtEnd(parts) };
}

/** The segments that are fixed from the start, up to the first run that holds one that is not. */
function fixedAtStart(parts: readonly Run[]): number {
  let count = 0;
  for (const part of parts) {
    count += part.leading;
    if (part.leading < part.length) break;
  }
  return count;
}

/** The segments that are fixed from the end, back to the first run that holds one that is not. */
function fixedAtEnd(parts: readonly Run[]): number {
  let count = 0;
  for (const part of parts.toReversed()) {
    count += part.trailing;
    if (part.trailing < part.length) break;
  }
  return count;
}

/**
 * Definite prefixes and suffixes exclude unrelated positions without inventing unresolved lengths:
 * of the segments in order, a position inside the fixed ones at the start (or, counted from the end,
 * at the end) is that segment's views alone, and any other the views of all the segments from the
 * first that is not fixed on (or all of them, from the end). Each run is read once however many
 * paths reach it: it adds to the views no more than the first time did.
 */
export function selectedRunViews(run: Run, index: number | undefined): readonly ArrayElementView[] {
  if (index === undefined) return viewsFrom(run, 0);
  if (index < 0) return endSelectedViews(run, -1 - index);
  if (Number.isSafeInteger(index) && index < run.leading) return segmentViews(run, index, false);
  return run.leading < run.length ? viewsFrom(run, run.leading) : [];
}

/** A fixed selected suffix remains exact despite unresolved segments before it. */
function endSelectedViews(run: Run, offset: number): readonly ArrayElementView[] {
  if (Number.isSafeInteger(offset) && offset < run.trailing) return segmentViews(run, offset, true);
  return run.trailing < run.length ? viewsFrom(run, 0) : [];
}

/**
 * The views of the segment `position` places from the start, or from the end. Where the count of
 * segments is no exact number (past 2**53), no position is told: every view is kept.
 */
function segmentViews(run: Run, position: number, fromEnd: boolean): readonly ArrayElementView[] {
  if (!Number.isSafeInteger(run.length)) return viewsFrom(run, 0);
  let current = run;
  let rest = fromEnd ? run.length - 1 - position : position;
  while (current.parts.length > 0) {
    const holding = firstHolding(current.parts, rest);
    const part = holding === undefined ? undefined : current.parts[holding.index];
    if (holding === undefined || part === undefined) return [];
    rest -= holding.before;
    current = part;
  }
  return current.views;
}

/** The views of every segment from the one `skip` places in, each run read once. */
function viewsFrom(run: Run, skip: number): readonly ArrayElementView[] {
  const views: ArrayElementView[] = [];
  const read = new Set<Run>();
  for (const whole of runsFrom(run, skip)) {
    const pending = [whole];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (read.has(next)) continue;
      read.add(next);
      if (next.parts.length === 0) views.push(...next.views);
      for (const part of next.parts.toReversed()) pending.push(part);
    }
  }
  return views;
}

/**
 * The runs, in order, that hold the segments from the one `skip` places in: the run that segment
 * starts, and then the runs that come after it at each level it is nested in. Where the count of
 * segments is no exact number, the whole run.
 */
function runsFrom(run: Run, skip: number): readonly Run[] {
  if (skip <= 0 || !Number.isSafeInteger(run.length)) return [run];
  const after: (readonly Run[])[] = [];
  let current = run;
  let rest = skip;
  for (;;) {
    const holding = firstHolding(current.parts, rest);
    const part = holding === undefined ? undefined : current.parts[holding.index];
    if (holding === undefined || part === undefined) return [run];
    after.push(current.parts.slice(holding.index + 1));
    if (holding.before === rest) return [part, ...after.toReversed().flat()];
    rest -= holding.before;
    current = part;
  }
}

/** The part a position falls in, and how many segments come before that part. */
function firstHolding(
  parts: readonly Run[],
  position: number,
): { readonly index: number; readonly before: number } | undefined {
  let before = 0;
  for (const [index, part] of parts.entries()) {
    if (position < before + part.length) return { index, before };
    before += part.length;
  }
  return undefined;
}
