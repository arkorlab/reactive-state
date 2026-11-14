import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { type Hidden, readUnder } from '../src/compiler/framed-seen-reads.ts';

/**
 * The reads of one object are few, however the paths to it multiply: past a few reads kept apart the
 * object is read under the names all of them hid, then under none, and each covers those before it.
 * A read that carries the own names of the descriptor inheriting the object is covered only by one
 * that does, so the fallback that hides nothing keeps such a marker where a read had it.
 */
const KEPT = 4;

function direct(name: string): Hidden {
  return { data: new Set([name]), getters: new Set([name]) };
}

function inherited(...own: readonly string[]): Hidden {
  return { data: new Set(), getters: new Set(), own: new Set(own) };
}

/** The table of one object after the reads, and what each of them was told to read under. */
function readAll(reads: readonly Hidden[]): {
  readonly told: readonly (Hidden | undefined)[];
  readonly kept: number;
} {
  const table = new Map<Node, readonly Hidden[]>();
  const held = {} as Node;
  const told = reads.map((each) => readUnder(table, held, each));
  return { told, kept: table.get(held)?.length ?? 0 };
}

const NAMES = ['a', 'b', 'c', 'd', 'e'] as const;

describe('the reads kept apart for one object', () => {
  it('make an inherited read once, after reads under distinct names that carry no own names', () => {
    const first = NAMES.slice(0, KEPT + 1).map((name) => direct(name));
    const { told, kept } = readAll([...first, inherited(), inherited(), inherited()]);
    const repeats = told.slice(first.length).filter((each) => each !== undefined);

    expect(repeats).toHaveLength(1);
    expect(kept).toBeLessThanOrEqual(KEPT + 2);
  });

  it('make an inherited read once, after reads that were each of a different inheriting descriptor', () => {
    const first = NAMES.slice(0, KEPT + 1).map((name) => inherited(name));
    const { told } = readAll([...first, inherited('z'), inherited('z'), inherited('y')]);
    const after = told.slice(first.length);

    expect(after.filter((each) => each !== undefined).length).toBeLessThanOrEqual(1);
  });

  it('cover a direct read by the fallback of inherited reads', () => {
    const first = NAMES.slice(0, KEPT + 1).map((name) => direct(name));
    const { told } = readAll([...first, inherited(), direct('z'), direct('y')]);

    expect(told.slice(first.length + 1)).toStrictEqual([undefined, undefined]);
  });

  it('keep a direct fallback for direct reads, as before', () => {
    const first = NAMES.slice(0, KEPT + 1).map((name) => direct(name));
    const { told, kept } = readAll([...first, direct('z'), direct('y'), direct('x')]);

    expect(told.slice(first.length)).toStrictEqual([undefined, undefined, undefined]);
    expect(kept).toBeLessThanOrEqual(KEPT + 1);
  });

  it('read an inherited object under no hidden name once the room is spent, with the marker', () => {
    const first = NAMES.slice(0, KEPT + 1).map((name) => direct(name));
    const { told } = readAll([...first, inherited('p')]);
    const last = told.at(-1);

    expect(last?.data.size).toBe(0);
    expect(last?.own).toStrictEqual(new Set());
  });
});
