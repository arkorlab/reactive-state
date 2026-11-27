import {
  type CallExpression,
  type Node,
  isCallExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { arrayProjectedViews } from '../src/compiler/framed-array-projections.ts';
import { frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

// The module keeps its own answers; its calls are counted by the rows that read the file.
vi.mock(import('../src/compiler/framed-bindings.ts'), { spy: true });

/**
 * A `flatMap` mapper that returns an array spread through aliases that spread one another gives
 * an element of the returned array for each place a spread reaches it: each doubling `const a2 =
 * [...a1, ...a1]` doubled the elements of the one before, and a walk made them all (and asked of
 * each place whether the array is left unchanged) before it chose the position the read names. The
 * rows pin what a position selects, for each position, and then count what the walk does: one
 * expansion of an alias however many places spread it, and each element answered once.
 */

/** A doubling chain: `a0` holds `seed`, and each `aN` spreads the one before it twice. */
function doubling(levels: number, seed: string): string {
  const lines = [`const a0 = ${seed};`];
  for (let level = 1; level <= levels; level++) {
    lines.push(`const a${level} = [...a${level - 1}, ...a${level - 1}];`);
  }
  return lines.join(' ');
}

/**
 * The aliases are written outside the function, as the mapper's own prefix must evaluate nothing
 * before the call, and an Error made there is the mapper's to read: `read` follows the call.
 */
function mapped(aliases: string, returned: string, read: string, receiver = '[0]'): string {
  return `${aliases}\nfunction frames() { return ${receiver}.flatMap(() => ${returned})${read}; }\n`;
}

/** The views the mapper's return gives at a position, and the names the file is asked of for them. */
function walk(
  source: string,
  index: number | undefined,
  stable = true,
): { readonly asked: number; readonly views: readonly string[] } {
  using api = openTypeScript();
  using parsed = parseModule(api, 'expanded-return-paths.ts', source);
  const calls: CallExpression[] = [];
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'flatMap'
    )
      calls.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const [call] = calls;
  if (call === undefined) throw new Error(`No flatMap call in ${source}.`);
  vi.mocked(frameBindingOf).mockClear();
  const views = arrayProjectedViews(call, index, () => stable);
  if (views === undefined) throw new Error(`No views of ${source}.`);
  return {
    asked: vi.mocked(frameBindingOf).mock.calls.length,
    views: views.map((view) => {
      const text = view.value.getText(parsed.sourceFile);
      return text === '' ? 'a hole' : text;
    }),
  };
}

function viewsOf(source: string, index: number | undefined, stable = true): readonly string[] {
  return walk(source, index, stable).views;
}

const A = "new Error('a')";
const B = '{ b: 2 }';
const PAIR = `[${A}, ${B}]`;

/** Eight elements, in the pairs of a doubled pair: `A, B, A, B, A, B, A, B`. */
const SCALARS = mapped(doubling(2, PAIR), '[...a2]', '[0]!.stack');
const RECEIVER_OF_TWO = mapped(doubling(2, PAIR), '[...a2]', '[0]!.stack', '[0, 1]');

describe('the position a doubled alias spread by a mapper selects', () => {
  const POSITIONS = [
    { index: 0, views: [A], what: 'the first of the first copy' },
    { index: 1, views: [B], what: 'the second of the first copy' },
    { index: 2, views: [A], what: 'the first of the second copy' },
    { index: 5, views: [B], what: 'the second of the third copy' },
    { index: 6, views: [A], what: 'the first of the last copy' },
    { index: 7, views: [B], what: 'the last of the last copy' },
    { index: 8, views: [], what: 'a position past every copy' },
    { index: 40, views: [], what: 'a position far past every copy' },
    { index: -1, views: [A, B], what: 'a position from the end' },
    { index: undefined, views: [A, B], what: 'no position' },
  ] as const;

  it.each(POSITIONS)('$what ($index)', ({ index, views }) => {
    expect(viewsOf(SCALARS, index)).toStrictEqual(views);
  });

  it('counts a position of a second input from the start of the copies again', () => {
    expect(viewsOf(RECEIVER_OF_TWO, 8)).toStrictEqual([A]);
    expect(viewsOf(RECEIVER_OF_TWO, 11)).toStrictEqual([B]);
    expect(viewsOf(RECEIVER_OF_TWO, 15)).toStrictEqual([B]);
    expect(viewsOf(RECEIVER_OF_TWO, 16)).toStrictEqual([]);
  });

  it('gives every element of a receiver that may change, each once', () => {
    expect(viewsOf(SCALARS, 3, false)).toStrictEqual([A, B]);
  });

  it('keeps the holes of a spread array and the order the elements are written in', () => {
    const source = mapped(doubling(1, `[, ${A}, ${B}]`), '[...a1]', '[0]!.stack');

    expect(viewsOf(source, 0)).toStrictEqual(['a hole']);
    expect(viewsOf(source, 1)).toStrictEqual([A]);
    expect(viewsOf(source, 2)).toStrictEqual([B]);
    expect(viewsOf(source, 3)).toStrictEqual(['a hole']);
    expect(viewsOf(source, 5)).toStrictEqual([B]);
    expect(viewsOf(source, undefined)).toStrictEqual(['a hole', A, B]);
  });

  it('leaves out a hole the returned array writes itself, and counts what follows it', () => {
    const source = mapped(doubling(1, PAIR), `[, ${B}, ...a1, , ...a0]`, '[0]!.stack');

    expect(viewsOf(source, 0)).toStrictEqual([B]);
    expect(viewsOf(source, 1)).toStrictEqual([A]);
    expect(viewsOf(source, 4)).toStrictEqual([B]);
    expect(viewsOf(source, 5)).toStrictEqual([A]);
    expect(viewsOf(source, 6)).toStrictEqual([B]);
    expect(viewsOf(source, 7)).toStrictEqual([]);
  });

  it('takes an element a spread array nests as the one element it is', () => {
    const source = mapped(`const a0 = [[${A}], ${B}];`, '[...a0, ...a0]', '[0]!.stack');

    expect(viewsOf(source, 0)).toStrictEqual([`[${A}]`]);
    expect(viewsOf(source, 3)).toStrictEqual([B]);
    expect(viewsOf(source, 4)).toStrictEqual([]);
  });

  it('counts aliases of different lengths by the elements each holds', () => {
    const source = mapped(
      `const a0 = [${A}]; const a1 = [...a0, ${B}, ...a0]; const a2 = [...a1, ...a0, ...a1];`,
      '[...a2]',
      '[0]!.stack',
    );
    const at = (index: number) => viewsOf(source, index);

    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => at(index).join(', '))).toStrictEqual([
      A,
      B,
      A,
      A,
      A,
      B,
      A,
      '',
      '',
    ]);
  });
});

/** Whether `framedRead` takes a node of the source for a read of an Error's frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'expanded-return-paths.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

const DATA = '[{ stack: 1 }]';
const ERROR = "[new Error('a')]";

describe('what a read of the array a mapper spreads through doubled aliases answers', () => {
  const ROWS = [
    {
      read: true,
      source: mapped(doubling(4, ERROR), '[...a4]', '[0]!.stack'),
      what: 'an Error at the first position',
    },
    {
      read: true,
      source: mapped(doubling(4, ERROR), '[...a4]', '[15]!.stack'),
      what: 'an Error at the last of sixteen',
    },
    {
      read: false,
      source: mapped(doubling(4, ERROR), '[...a4]', '[16]!.stack'),
      what: 'an Error past the end of what is known',
    },
    {
      read: true,
      source: mapped(doubling(3, `[{ stack: 1 }, ${A}]`), '[...a3]', '[1]!.stack'),
      what: 'an Error after a datum',
    },
    {
      read: true,
      source: mapped(doubling(3, `[{ stack: 1 }, ${A}]`), '[...a3]', '[15]!.stack'),
      what: 'an Error at the last of the copies',
    },
    {
      read: false,
      source: mapped(doubling(3, `[{ stack: 1 }, ${A}]`), '[...a3]', '[0]!.stack'),
      what: 'a datum before an Error',
    },
    {
      read: false,
      source: mapped(doubling(3, `[{ stack: 1 }, ${A}]`), '[...a3]', '[14]!.stack'),
      what: 'a datum in the last copy',
    },
    {
      read: true,
      source: mapped(doubling(3, `[, ${A}]`), '[...a3]', '[3]!.stack'),
      what: 'an Error after a hole of the second copy',
    },
    {
      read: false,
      source: mapped(doubling(3, `[, ${A}]`), '[...a3]', '[2]?.stack'),
      what: 'a hole of the second copy',
    },
    {
      read: false,
      source: mapped(doubling(4, DATA), '[...a4]', '[0]!.stack'),
      what: 'data at the first position',
    },
    {
      read: false,
      source: mapped(doubling(4, DATA), '[...a4]', '[16]!.stack'),
      what: 'data past the end',
    },
    {
      read: false,
      source: mapped(doubling(4, '[1]'), '[...a4]', '[0]!.toFixed()'),
      what: 'a number',
    },
    {
      read: true,
      source: mapped(doubling(3, ERROR), '[...a3, ...a0]', '[8]!.stack'),
      what: 'an Error that follows the copies',
    },
    {
      read: false,
      source: mapped(doubling(3, ERROR), '[...a3, ...a0]', '[9]!.stack'),
      what: 'a position past the Error that follows the copies',
    },
    {
      read: true,
      source: mapped(doubling(3, ERROR), '[...a3]', '[8]!.stack', '[0, 1]'),
      what: 'an Error at the first of a second input',
    },
    {
      read: true,
      source: mapped(doubling(2, ERROR), 'a2', '[3]!.stack'),
      what: 'an Error of a doubled alias returned whole',
    },
    {
      read: true,
      source: mapped(doubling(60, ERROR), '[...a60]', '[0]!.stack'),
      what: 'an Error at a position no count of the copies tells (60 levels)',
    },
    {
      read: true,
      source: mapped(doubling(60, `[{ stack: 1 }, ${A}]`), '[...a60]', '[0]!.stack'),
      what: 'an Error that may be at a position no count tells (60 levels)',
    },
    {
      read: false,
      source: mapped(doubling(60, DATA), '[...a60]', '[0]!.stack'),
      what: 'data at a position no count of the copies tells (60 levels)',
    },
    {
      read: false,
      source: mapped(`let a0 = ${ERROR}; const a1 = [...a0, ...a0];`, '[...a1]', '[0]!.stack'),
      what: 'an alias that may be written again (let), at the seed',
    },
    {
      read: false,
      source: mapped(`const a0 = ${ERROR}; let a1 = [...a0, ...a0];`, '[...a1]', '[0]!.stack'),
      what: 'an alias that may be written again (let), in the middle',
    },
    {
      read: false,
      source: mapped(
        `declare const rest: Error[]; const a0 = ${ERROR}; const a1 = [...a0, ...rest];`,
        '[...a1]',
        '[0]!.stack',
      ),
      what: 'a spread of an array that is not written',
    },
    {
      read: false,
      source: mapped(
        `const a0 = [...a0, ${A}]; const a1 = [...a0, ...a0];`,
        '[...a1]',
        '[0]!.stack',
      ),
      what: 'an array that holds itself',
    },
    {
      read: false,
      source: mapped(
        `const a0 = [...a1, ${A}]; const a1 = [...a0, ...a0];`,
        '[...a1]',
        '[0]!.stack',
      ),
      what: 'arrays that hold one another',
    },
  ] as const;

  it.each(ROWS)('$what', ({ read, source }) => {
    expect(readsFrames(source)).toBe(read);
  });
});

/** A list of `count` distinct aliases, each held once, spread by the one return. */
function distinct(count: number): string {
  const names = Array.from({ length: count }, (_, at) => `a${at}`);
  const declared = names.map((name) => `const ${name} = [${A}];`).join(' ');
  const spread = names.map((name) => `...${name}`).join(', ');
  return mapped(declared, `[${spread}]`, '[0]!.stack');
}

/** The return of a chain of `levels` doublings of a pair, spread whole. */
function doubled(levels: number): string {
  return mapped(doubling(levels, PAIR), `[...a${levels}]`, '[0]!.stack');
}

/** Linear in the program's size: counts of what the walk asks and answers, not times. */
describe('the work of reading the array a mapper spreads through aliases', () => {
  beforeEach(() => {
    vi.mocked(frameBindingOf).mockClear();
  });

  it.each([6, 10, 14])('asks of each place once, %i levels of doubling', (levels) => {
    expect(walk(doubled(levels), 0).asked).toBeLessThanOrEqual(8 * (levels + 1));
  });

  it.each([6, 10, 14])('answers each element once, %i levels of doubling', (levels) => {
    expect(walk(doubled(levels), undefined).views).toStrictEqual([A, B]);
  });

  it('asks of each place once at a position the copies hold, 48 levels of doubling', () => {
    expect(walk(doubled(48), 0).asked).toBeLessThanOrEqual(8 * 49);
    expect(walk(doubled(48), 2 ** 48 + 1).views).toStrictEqual([B]);
    expect(walk(doubled(48), 2 ** 49 - 2).views).toStrictEqual([A]);
    expect(walk(doubled(48), 2 ** 49 - 1).views).toStrictEqual([B]);
    expect(walk(doubled(48), 2 ** 49).views).toStrictEqual([]);
  });

  it('keeps every element where the copies are more than a count tells, 60 levels of doubling', () => {
    expect(walk(doubled(60), 5).views).toStrictEqual([A, B]);
    expect(walk(doubled(60), undefined).views).toStrictEqual([A, B]);
  });

  it.each([20, 40, 80])('asks of each alias a bounded number of times, %i aliases', (count) => {
    expect(walk(distinct(count), 0).asked).toBeLessThanOrEqual(4 * count);
    expect(walk(distinct(count), undefined).views).toStrictEqual(
      Array.from({ length: count }, () => A),
    );
  });
});
