import { type Expression, type Identifier, isVariableDeclaration, type Node } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst, inDestructuring } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import type { FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { bindingUses } from './framed-local-uses.ts';
import { framedPossibleBranch, loopBody, reachedLoopRead } from './framed-writes.ts';

/** Whether the uses of an array, a tuple of a call's arguments, may run before a read of it. */

/**
 * The uses of a binding, in the order `bindingUses` gives them, taken in runs of those that one body
 * runs (`executionOwner`): a function that writes into a tuple many times holds them all in one
 * run. Each run is found once for the file, as the uses are, and not again at each read that asks of
 * them — a read among n writes is asked of each of them, and each asks of all n.
 */
interface UseRun {
  /** The body that runs each use of the run. */
  readonly owner: Node;
  readonly uses: readonly Identifier[];
  /** Whether no use of the run is written after the one before it. */
  readonly descending: boolean;
}

const RUNS = new WeakMap<readonly Identifier[], readonly UseRun[]>();

/** The runs of a binding's uses in `root`, in the order of the uses. */
function useRuns(root: Node, binding: FrameBinding): readonly UseRun[] {
  const uses = bindingUses(root, binding);
  if (uses.length === 0) return [];
  let runs = RUNS.get(uses);
  if (runs === undefined) {
    runs = runsOf(uses);
    RUNS.set(uses, runs);
  }
  return runs;
}

function runsOf(uses: readonly Identifier[]): readonly UseRun[] {
  const runs: { owner: Node; uses: Identifier[]; descending: boolean }[] = [];
  for (const use of uses) {
    const owner = executionOwner(use);
    const last = runs.at(-1);
    if (last?.owner !== owner) {
      runs.push({ owner, uses: [use], descending: true });
      continue;
    }
    const before = last.uses.at(-1);
    if (before !== undefined && before.pos < use.pos) last.descending = false;
    last.uses.push(use);
  }
  return runs;
}

/**
 * Where the uses of a run that were written before `pos` begin: the first of them, in a run whose
 * uses are written from the last to the first — each use before it lies at or after `pos`. The
 * run's length where none was written before, and 0 for a run not so ordered, where any may be.
 */
function firstWrittenBefore(run: UseRun, pos: number): number {
  if (!run.descending) return 0;
  let low = 0;
  let high = run.uses.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const use = run.uses[middle];
    if (use !== undefined && use.pos >= pos) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Only a whole constant alias chain retains an apply array before its entries can be exposed. A use
 * counts where it runs before the read: written before it, but for one in a destructuring pattern
 * whose source holds the read, or in a loop's condition, update or body on the next pass. Where
 * `reached`, one in what a pattern around the read destructures counts too; where false, for a
 * reader whose proof an exposure drops, only a loop body's uses repeat.
 *
 * The uses are those `bindingUses` finds, each known to read the alias, taken in runs of one body.
 * Where nothing around the read comes back to it, a use in its own body written after it cannot run
 * before it, and the run begins at the uses written before it: a read among n writes does not take
 * the n after it, nor resolve what each of them reads again.
 */
export function argumentArrayExposed(
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
  unchanged?: (name: Identifier) => boolean,
  reached: boolean | 'loops' = 'loops',
): boolean {
  if (aliases.size === 0) return false;
  const root = expression.getSourceFile();
  const reader = executionOwner(expression);
  const ordered = !inDestructuring(expression) && !loopAround(expression, reader);
  for (const alias of aliases) {
    const asked = { alias, aliases, expression, ordered, reached, reader, unchanged };
    for (const run of useRuns(root, alias)) {
      if (runExposes(run, asked)) return true;
    }
  }
  return false;
}

/**
 * An exposure by any use that may run before the read: one written before it, one in what a
 * destructuring pattern around the read destructures, which runs first though written after, and
 * one in a loop's condition or update on the next pass — for a reader that keeps every candidate of
 * an exposed array, so that an exposure widens what it keeps and never drops a proof.
 */
export function argumentArrayReached(
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  return argumentArrayExposed(expression, aliases, undefined, true);
}

/** Whether a loop's pass comes round to a read from within the body that runs it. */
function loopAround(expression: Expression, reader: Node): boolean {
  for (let at = expression.parent; at !== reader; at = at.parent) {
    if (loopBody(at) !== undefined) return true;
  }
  return false;
}

/** The question asked of each use of an alias: whether it may run before the read. */
interface Asked {
  readonly alias: FrameBinding;
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly expression: Expression;
  /** Whether no later pass and no pattern comes round to the read, so that a later use runs after it. */
  readonly ordered: boolean;
  readonly reached: boolean | 'loops';
  /** The body that runs the read. */
  readonly reader: Node;
  readonly unchanged: ((name: Identifier) => boolean) | undefined;
}

/**
 * Whether a use of a run exposes the read, and the caller does not let it pass. A run of another
 * body is settled at once where that is a local function nothing references; one of the body that
 * runs the read, where `ordered`, begins at the uses written before the read.
 */
function runExposes(run: UseRun, asked: Asked): boolean {
  const { expression, reader, unchanged } = asked;
  const own = run.owner === reader;
  if (!own && unreferencedLocalFunction(run.owner, reader)) return false;
  const first = own && asked.ordered ? firstWrittenBefore(run, expression.pos) : 0;
  for (let at = first; at < run.uses.length; at += 1) {
    const name = run.uses[at];
    if (name === undefined) continue;
    if (argumentUseExposed(name, own, asked) && unchanged?.(name) !== true) return true;
  }
  return false;
}

/**
 * Earlier uses or possible closure uses lose the exact index, retaining lexical identity. The use
 * is of the alias, in the body that runs the read where `own`; one in another body counts.
 */
function argumentUseExposed(name: Identifier, own: boolean, asked: Asked): boolean {
  const { alias, aliases, expression, reached, reader } = asked;
  if (name === unwrapped(expression)) return false;
  if (
    own &&
    (name.pos >= expression.pos || destructuredFirst(expression, name)) &&
    !(reached === true && destructuredFirst(name, expression)) &&
    !reachedLoopRead(reached)(name, expression, alias, reader)
  )
    return false;
  if (!framedPossibleBranch(name)) return false;
  const { parent } = useOf(name);
  return (
    !isVariableDeclaration(parent) ||
    parent.initializer === undefined ||
    unwrapped(parent.initializer) !== name ||
    !aliases.has(parent)
  );
}
