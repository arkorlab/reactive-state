import { type Expression, type Node, isVariableStatement } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { flattenedArrayViews } from '../src/compiler/framed-array-flatten.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A flat whose depth the compile cannot read keeps each depth that reads something different, and
 * no more: layers of written arrays nested one in another, however many arrays stand side by side.
 */
const context = (capture: Node, stable: boolean) => ({ stable: () => stable, capture });

/** The initializer of the last declaration of the source, the receiver a flat is asked of. */
function receiverOf(sourceFile: Node, source: string): Expression {
  const statements = (sourceFile as unknown as { statements: readonly Node[] }).statements;
  const last = statements.at(-1);
  if (last === undefined || !isVariableStatement(last)) throw new Error(`no receiver in ${source}`);
  const initializer = last.declarationList.declarations[0]?.initializer;
  if (initializer === undefined) throw new Error(`no initializer in ${source}`);
  return initializer;
}

function views(
  source: string,
  depth: number | undefined,
  index?: number,
  stable = true,
): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'flat-depth.ts', source);
  const receiver = receiverOf(parsed.sourceFile, source);
  return flattenedArrayViews(receiver, index, depth, context(parsed.sourceFile, stable)).map(
    (view) => view.value.getText(parsed.sourceFile),
  );
}

const repeated = (text: string, count: number): string =>
  Array.from({ length: count }, () => text).join(', ');

const siblings = (count: number): string =>
  `declare const e: Error; const receiver = [${repeated('[e]', count)}];`;

const aliasedSiblings = (count: number): string => {
  const names = Array.from({ length: count }, (_, at) => `a${at}`);
  const declarations = names.map((name) => `const ${name} = [e];`).join(' ');
  return `declare const e: Error; ${declarations} const receiver = [${names.join(', ')}];`;
};

const nested = (layers: number): string =>
  `declare const e: Error; const receiver = ${'['.repeat(layers)}e${']'.repeat(layers)};`;

describe('flat depths an unresolved argument may supply, by written nesting', () => {
  it.each([100, 200])('keeps a linear number of views for %i sibling arrays', (count) => {
    expect(views(siblings(count), undefined).length).toBeLessThanOrEqual(4 * count);
    expect(views(aliasedSiblings(count), undefined).length).toBeLessThanOrEqual(4 * count);
  });

  it.each([100, 200])('keeps a linear number of views at a position for %i arrays', (count) => {
    expect(views(siblings(count), undefined, 0).length).toBeLessThanOrEqual(4 * count);
  });

  const SHAPES: Record<string, string> = {
    flat: 'declare const x: number; const receiver = [x];',
    'six-layers': nested(6),
    'rising-layers': 'declare const e: Error; const receiver = [[e], [[e]], [[[e]]], [[[[e]]]]];',
    'siblings-two-layers': 'declare const x: number, y: number; const receiver = [[x], [[y]]];',
    'four-layers': 'declare const x: number; const receiver = [[[[x]]]];',
    'mixed-depths':
      'declare const x: number, y: number, z: number; const receiver = [x, [y, [z]]];',
    'spread-of-layers': 'declare const x: number, y: number; const receiver = [...[[x]], [[y]]];',
    'spread-in-layer': 'declare const x: number, y: number; const receiver = [[...[[x]], y]];',
    'shared-aliases':
      'declare const x: number; const s = [x]; const t = [s, s]; const receiver = [t, [t]];',
    'long-then-short':
      'declare const x: number, y: number; const deep = [[[x]]]; const receiver = [[y], deep, deep];',
    'holes-and-objects': 'const receiver = [[, 1], [{ a: 1 }], []];',
  };

  const POSITIONS = [undefined, 0, 1, 2, -1, -2];

  it.each(Object.entries(SHAPES))(
    'reads at an unresolved depth what each uniform depth reads: %s',
    (_, source) => {
      for (const stable of [true, false])
        for (const index of POSITIONS) {
          const unresolved = new Set(views(source, undefined, index, stable));
          const uniform = new Set<string>();
          for (let depth = 0; depth <= 9; depth++)
            for (const each of views(source, depth, index, stable)) uniform.add(each);

          expect(unresolved).toStrictEqual(uniform);
        }
    },
  );

  const READS = [
    {
      id: 'spread-depth-one-layer',
      source:
        'function f(depths:number[],error:Error){return [[error]].flat(...depths)[0]!.stack;}',
      refused: true,
    },
    {
      id: 'spread-depth-two-layers',
      source:
        'function f(depths:number[],error:Error){return [[[error]]].flat(...depths)[0]!.stack;}',
      refused: true,
    },
    {
      id: 'spread-depth-mixed-layers',
      source:
        'function f(depths:number[],error:Error){return [[1],[[[error]]]].flat(...depths)[1]!.stack;}',
      refused: true,
    },
    {
      id: 'spread-depth-spread-layer',
      source:
        'function f(depths:number[],error:Error){const inner=[[error]];return [[1],...inner].flat(...depths)[1]!.stack;}',
      refused: true,
    },
    {
      id: 'unknown-primitive-depth',
      source: 'function f(depth:number,error:Error){return [[[error]]].flat(depth)[0]!.stack;}',
      refused: true,
    },
    {
      id: 'spread-depth-text-data',
      source:
        'function f(depths:number[],error:Error){return [["fixed"],[["x"]]].flat(...depths)[0]!.length;}',
      refused: false,
    },
  ];

  it.each(READS)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'flat-depth-read.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});
