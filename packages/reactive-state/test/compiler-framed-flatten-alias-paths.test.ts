import {
  type Expression,
  type Identifier,
  type Node,
  isArrayLiteralExpression,
  isExpressionStatement,
  isIdentifier,
} from 'typescript/ast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flattenedArrayViews } from '../src/compiler/framed-array-flatten.ts';
import { argumentArrayExposed } from '../src/compiler/framed-array-selections.ts';
import { frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

// The module keeps its own answers; its calls are counted by the rows that read the file.
vi.mock(import('../src/compiler/framed-bindings.ts'), { spy: true });

/**
 * `flat()` of an array written through aliases that spread or hold one another reads the same
 * alias at every place it stands, however many paths reach it: each doubling `const a2 = [...a1,
 * ...a1]` doubled the work of the one before, and every alias asked the whole file again whether
 * it is left unchanged. The rows pin what the flattening answers, for each position, and then count
 * what the walk does: one expansion of an alias, whatever the number of paths to it, and one
 * reading of the file for every alias it asks of.
 */

/** A doubling chain: `a0` holds `seed`, and each `aN` spreads (or nests) the one before it twice. */
function doubling(levels: number, seed: string, how: 'nest' | 'spread' = 'spread'): string {
  const lines = [`const a0 = ${seed};`];
  for (let level = 1; level <= levels; level++) {
    const held = `a${level - 1}`;
    lines.push(
      how === 'spread'
        ? `const a${level} = [...${held}, ...${held}];`
        : `const a${level} = [${held}, ${held}];`,
    );
  }
  return lines.join(' ');
}

/** Each row's source declares an array `items`, read last, with an Error `error` in scope. */
function withItems<T>(source: string, use: (items: Expression, root: Node) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'flatten-alias-paths.ts',
    `declare const error: Error;\n${source}\nitems;\n`,
  );
  const last = parsed.sourceFile.statements.at(-1);
  if (last === undefined || !isExpressionStatement(last)) {
    throw new Error(`No read of items ends ${source}.`);
  }
  return use(last.expression, parsed.sourceFile);
}

interface Walk {
  /** The texts of the views the flattening answers, each one once, in the order first met. */
  readonly views: readonly string[];
  /** How many views it answered in all, and how many times it asked whether an array is stable. */
  readonly count: number;
  readonly asked: number;
}

/** The views `flat` of `items` keeps at a position, with the arrays named in `changed` unstable. */
function walk(
  source: string,
  at: { readonly index: number | undefined; readonly depth: number | undefined },
  changed: readonly string[] = [],
): Walk {
  return withItems(source, (items, root) => {
    let asked = 0;
    const stable = (value: Expression): boolean => {
      asked += 1;
      return !changed.includes(value.getText(root.getSourceFile()));
    };
    const views = flattenedArrayViews(items, at.index, at.depth, { capture: items, stable });
    const texts = views.map(
      (view) =>
        `${view.element === true ? 'element ' : ''}${view.value.getText(root.getSourceFile())}`,
    );
    return { asked, count: texts.length, views: [...new Set(texts)] };
  });
}

const A = 'element { a: 1 }';
const B = 'element { b: 2 }';
const PAIR = '[{ a: 1 }, { b: 2 }]';

/** A source of definite scalars, whose every position the flattening knows. */
const SCALARS = `${doubling(2, PAIR)} const items = a2;`;

/** The second copy of an array a spread reaches again keeps its own positions, after the first. */
const POSITIONS = [
  { depth: Infinity, index: 0, views: [A], what: 'the first of the first copy' },
  { depth: Infinity, index: 1, views: [B], what: 'the second of the first copy' },
  { depth: Infinity, index: 2, views: [A], what: 'the first of the second copy' },
  { depth: Infinity, index: 4, views: [A], what: 'the first of the third copy' },
  { depth: Infinity, index: 7, views: [B], what: 'the last of the last copy' },
  { depth: Infinity, index: 8, views: [], what: 'a position past every copy' },
  { depth: Infinity, index: -1, views: [B], what: 'the last, counted from the end' },
  { depth: Infinity, index: -2, views: [A], what: 'the one before the last' },
  { depth: Infinity, index: -8, views: [A], what: 'the first, counted from the end' },
  { depth: Infinity, index: -9, views: [], what: 'a position from the end past every copy' },
  { depth: Infinity, index: undefined, views: [A, B], what: 'no position' },
  { depth: 1, index: 5, views: [B], what: 'a flat of one layer, a position in the last copy' },
  { depth: 0, index: 3, views: [B], what: 'a flat of no layer' },
  { depth: undefined, index: 6, views: [A], what: 'a flat whose depth is not read' },
] as const;

describe('the positions of an array a flat reaches through an alias again', () => {
  it.each(POSITIONS)('$what ($index)', ({ depth, index, views }) => {
    expect(walk(SCALARS, { depth, index }).views).toStrictEqual(views);
  });

  it('keeps a fixed prefix, then the views of everything after an unstable alias', () => {
    const source = `${doubling(1, PAIR)} const items = [...a0, ...a1, ...a0];`;
    const at = (index: number) => walk(source, { depth: Infinity, index }, ['a1']).views;

    expect(at(0)).toStrictEqual([A]);
    expect(at(1)).toStrictEqual([B]);
    expect(at(2)).toStrictEqual(['a1', A, B]);
    expect(at(5)).toStrictEqual(['a1', A, B]);
    expect(at(-1)).toStrictEqual([B]);
    expect(at(-2)).toStrictEqual([A]);
    expect(at(-3)).toStrictEqual([A, B, 'a1']);
  });

  it('keeps the views of an alias that is unstable where it stands twice', () => {
    const source = `${doubling(2, PAIR)} const items = a2;`;
    const at = (index: number | undefined) =>
      walk(source, { depth: Infinity, index }, ['a0']).views;

    expect(at(0)).toStrictEqual(['a0', A, B]);
    expect(at(undefined)).toStrictEqual(['a0', A, B]);
  });

  it('keeps nested layers of an alias as many times as the layers read', () => {
    const source = `${doubling(2, '[error]', 'nest')} const items = a2;`;
    const at = (depth: number) => walk(source, { depth, index: 0 }).views;

    expect(at(0)).toStrictEqual(['element a1']);
    expect(at(1)).toStrictEqual(['element a0']);
    expect(at(2)).toStrictEqual(['element error']);
    expect(at(Infinity)).toStrictEqual(['element error']);
  });
});

/** A read of `.stack` of the first element of a doubled chain of `flat`, in a function of an Error. */
function chainRead(levels: number, seed: string, read: string): string {
  return `function frames(error: Error) { ${doubling(levels, seed)} return a${levels}.${read}; }`;
}

function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'flatten-alias-paths.ts', source);
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

describe('what a read of a flat of doubling aliases answers', () => {
  const ROWS = [
    {
      read: true,
      source: chainRead(4, '[error]', 'flat(Infinity)[0]!.stack'),
      what: 'an Error at the first position',
    },
    {
      read: true,
      source: chainRead(4, '[error]', 'flat(Infinity).at(-1)!.stack'),
      what: 'an Error at the last',
    },
    {
      read: true,
      source: chainRead(4, '[error]', 'flat(Infinity)[15]!.stack'),
      what: 'an Error at the last of sixteen',
    },
    {
      read: true,
      source: chainRead(4, '[error]', 'flat(Infinity)[16]!.stack'),
      what: 'an Error past the end of what is known',
    },
    {
      read: true,
      source: chainRead(3, '[{ stack: 1 }, error]', 'flat(Infinity)[1]!.stack'),
      what: 'an Error after a datum',
    },
    {
      read: true,
      source: chainRead(3, '[{ stack: 1 }, error]', 'flat(Infinity)[2]!.stack'),
      what: 'a datum, where an Error follows an unknown one',
    },
    {
      read: true,
      source: chainRead(3, '[error, { stack: 1 }]', 'flat(Infinity).at(-1)!.stack'),
      what: 'a datum last, after an Error',
    },
    {
      read: false,
      source: chainRead(4, DATA, 'flat(Infinity)[0]!.stack'),
      what: 'data at the first position',
    },
    {
      read: false,
      source: chainRead(4, DATA, 'flat(Infinity)[16]!.stack'),
      what: 'data past the end',
    },
    { read: false, source: chainRead(4, '[1]', 'flat(Infinity)[0]!.toFixed()'), what: 'a number' },
    {
      read: false,
      source: chainRead(3, '[{ stack: 1 }, error]', 'flat(Infinity)[0]!.stack'),
      what: 'a datum before an Error',
    },
    {
      read: true,
      source: chainRead(3, '[error]', 'flat(...[1, 2])[0]!.stack'),
      what: 'an Error at a depth that is not read',
    },
    {
      read: false,
      source: chainRead(3, DATA, 'flat(...[1, 2])[0]!.stack'),
      what: 'data at a depth that is not read',
    },
    {
      read: true,
      source: `function frames(error: Error) { const a0 = [error]; const a1 = [a0, a0]; const a2 = [a1, a1]; return a2.flat(Infinity)[0]!.stack; }`,
      what: 'an Error in aliases nested by layers',
    },
    {
      read: false,
      source: `function frames(error: Error) { const a0 = [error]; const a1 = [a0, a0]; const a2 = [a1, a1]; return a2.flat(1)[0]!.stack; }`,
      what: 'an array, in aliases nested one layer past the flat',
    },
    {
      read: false,
      source: `function frames() { const a0 = [{ stack: 1 }]; const a1 = [a0, a0]; const a2 = [a1, a1]; return a2.flat(Infinity)[0]!.stack; }`,
      what: 'data in aliases nested by layers',
    },
  ] as const;

  it.each(ROWS)('$what', ({ read, source }) => {
    expect(readsFrames(source)).toBe(read);
  });
});

/** The most a walk asks of the places of a chain of `levels`: each, two to a level, and the root. */
function bound(levels: number): number {
  return 3 * (levels + 1);
}

/** Linear in the program's size: a count of expansions, not a time. */
describe('the work of flattening an alias reached by many paths', () => {
  it.each([6, 12, 16])('asks of each place once, %i levels of spreads', (levels) => {
    const found = walk(`${doubling(levels, '[error]')} const items = a${levels};`, {
      depth: Infinity,
      index: 0,
    });

    expect(found.asked).toBeLessThanOrEqual(bound(levels));
    expect(found.views).toStrictEqual(['element error']);
  });

  it.each([6, 12, 16])('asks of each place once, %i levels of nested layers', (levels) => {
    const found = walk(`${doubling(levels, '[error]', 'nest')} const items = a${levels};`, {
      depth: Infinity,
      index: 0,
    });

    expect(found.asked).toBeLessThanOrEqual(bound(levels));
    expect(found.views).toStrictEqual(['element error']);
  });

  it('answers each view of an alias once, however many paths reach it', () => {
    const levels = 12;
    const found = walk(`${doubling(levels, PAIR)} const items = a${levels};`, {
      depth: Infinity,
      index: undefined,
    });

    expect(found.count).toBe(2);
    expect(found.views).toStrictEqual([A, B]);
  });

  it('asks of each place once at every depth an unresolved depth may be', () => {
    const levels = 6;
    const found = walk(`${doubling(levels, '[error]')} const items = a${levels};`, {
      depth: undefined,
      index: 0,
    });

    expect(found.asked).toBeLessThanOrEqual(bound(levels) * (levels + 3));
    expect(found.views).toStrictEqual(['element error']);
  });
});

/** The calls to resolve a name that `count` aliases make, asked of one by one in a file of them. */
function resolutions(count: number): number {
  const names = Array.from({ length: count }, (_, at) => `a${at}`);
  const declared = names.map((name) => `const ${name} = [error];`).join(' ');
  const source = `function frames(error: Error) { ${declared} return [${names.join(', ')}].flat(Infinity)[0]!.stack; }`;
  using api = openTypeScript();
  using parsed = parseModule(api, 'flatten-alias-paths.ts', source);
  const elements: Identifier[] = [];
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isArrayLiteralExpression(node) && node.elements.length === count) {
      for (const element of node.elements) if (isIdentifier(element)) elements.push(element);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const bindings = elements.map((element) => frameBindingOf(element)?.binding);
  vi.mocked(frameBindingOf).mockClear();
  for (const [at, element] of elements.entries()) {
    const binding = bindings[at];
    if (binding === undefined) throw new Error(`No binding of ${element.text}.`);
    const exposed = argumentArrayExposed(element, new Set([binding]));

    expect(exposed).toBe(false);
  }
  return vi.mocked(frameBindingOf).mock.calls.length;
}

/** The reading of a file for the uses of an alias is made once, for every alias asked of. */
describe('the work of asking the file of each alias', () => {
  beforeEach(() => {
    vi.mocked(frameBindingOf).mockClear();
  });

  it.each([20, 40, 80])('resolves each name of the file once for %i aliases', (count) => {
    expect(resolutions(count)).toBeLessThanOrEqual(8 * count);
  });
});
