import { isFunctionDeclaration, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whether a declared type may be an Error follows the type's bases: an interface or a class that
 * derives one does. A base that several types share is reached along each path to it, so the walk
 * must settle what a type answers once, whichever way it is reached: the work grows with the
 * declarations, not with the number of paths through them, which doubles with each level of a
 * diamond (twenty-one levels took 28,656 visits) and grows by the width at each level of a lattice.
 */

/** Milliseconds a read may take: a diamond of twenty-four levels took twenty seconds on every path. */
const BUDGET = 4000;

/** The interfaces of a diamond, `I0` to `I24`, and of a lattice, `L0x0` to `L9x2`. */
const LEVELS = 24;
const LAYERS = 10;
const WIDTH = 3;

/** A diamond of `LEVELS` interfaces, each of the two before it, from `I0` (`root`) and `I1`. */
function diamond(root = 'interface I0 { a0: string }'): string {
  const lines = [root, 'interface I1 { a1: string }'];
  for (let each = 2; each <= LEVELS; each += 1)
    lines.push(`interface I${each} extends I${each - 1}, I${each - 2} { a${each}: string }`);
  return lines.join('\n');
}

/** The names of the interfaces of one layer of the lattice. */
function names(layer: number): readonly string[] {
  return Array.from({ length: WIDTH }, (_, at) => `L${layer}x${at}`);
}

/** `LAYERS` layers of `WIDTH` interfaces, each of every interface of the layer before it. */
function lattice(): string {
  const lines = names(0).map((each, at) => `interface ${each} { a${at}: string }`);
  for (let layer = 1; layer < LAYERS; layer += 1)
    for (const each of names(layer)) {
      lines.push(`interface ${each} extends ${names(layer - 1).join(', ')} { b${layer}: string }`);
    }
  return lines.join('\n');
}

/** A function that reads a member of an object made from entries no reader reads, of a declared type. */
function frames(name: string, type: string): string {
  return `function ${name}(entries:[string,${type}][]){const o=Object.fromEntries<${type}>(entries);return \`\${o.k}\`;}`;
}

const CASES = [
  {
    id: 'diamond-of-plain-interfaces-data',
    source: [diamond(), frames('f', 'I24')],
    reading: [],
  },
  {
    id: 'diamond-whose-first-base-is-an-error',
    source: [diamond('interface I0 extends Error { a0: string }'), frames('f', 'I24')],
    reading: ['f'],
  },
  {
    id: 'diamond-whose-second-base-is-an-error',
    source: [
      'interface I0 { a0: string }',
      'interface I1 extends Error { a1: string }',
      ...diamond().split('\n').slice(2),
      frames('f', 'I24'),
    ],
    reading: ['f'],
  },
  {
    id: 'lattice-of-plain-interfaces-data',
    source: [lattice(), frames('f', 'L9x0')],
    reading: [],
  },
  {
    id: 'lattice-with-an-error-beside-its-top',
    source: [
      lattice(),
      'interface Tainted extends L9x0, L9x1, Error { c: string }',
      frames('f', 'Tainted'),
    ],
    reading: ['f'],
  },
  {
    id: 'plain-and-tainted-tops-of-one-diamond-plain-first',
    source: [
      diamond(),
      'interface Plain extends I24 { p: string }',
      'interface Tainted extends I24, Error { t: string }',
      frames('plain', 'Plain'),
      frames('tainted', 'Tainted'),
    ],
    reading: ['tainted'],
  },
  {
    id: 'plain-and-tainted-tops-of-one-diamond-tainted-first',
    source: [
      diamond(),
      'interface Plain extends I24 { p: string }',
      'interface Tainted extends I24, Error { t: string }',
      frames('tainted', 'Tainted'),
      frames('plain', 'Plain'),
    ],
    reading: ['tainted'],
  },
  {
    id: 'same-diamond-asked-twice-data',
    source: [diamond(), frames('first', 'I24'), frames('second', 'I23')],
    reading: [],
  },
] as const;

/** The names of the module's functions that hold a read the frame reader finds. */
function readingFunctions(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-admission-heritage.ts', source);
  const found: string[] = [];
  const pending: { readonly node: Node; readonly owner: string | undefined }[] = [
    { node: parsed.sourceFile, owner: undefined },
  ];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const { node } = each;
    const owner =
      isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : each.owner;
    if (owner !== undefined && framedRead(node) !== undefined && !found.includes(owner))
      found.push(owner);
    node.forEachChild((child) => {
      pending.push({ node: child, owner });
    });
  }
  return found;
}

describe('declared types that derive an Error through shared bases', () => {
  it.each(CASES)('$id', ({ source, reading }) => {
    const start = performance.now();
    const found = readingFunctions(source.join('\n'));
    const elapsed = performance.now() - start;

    expect(found).toStrictEqual(reading);
    expect(elapsed).toBeLessThan(BUDGET);
  });
});
