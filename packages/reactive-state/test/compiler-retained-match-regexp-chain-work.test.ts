import {
  type CallExpression,
  isCallExpression,
  isFunctionDeclaration,
  isReturnStatement,
  type SourceFile,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { heldBy } from '../src/compiler/retained.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whether a pattern is a native global one is proved by following each name it is written as to
 * what it was assigned. Where both branches of a conditional, or both arguments of a pair of
 * constructions, name the same earlier pattern, the branches converge, and each name must be
 * proved once, however it is reached: a chain of such names grows the work with the source, not
 * with the number of paths through it, which doubles with each name. A cycle of names, a pattern
 * that is not global at the bottom, and a pattern mutated on the way still refuse.
 */

/** Milliseconds a proof may take: a chain of sixteen took seconds when each path was walked. */
const BUDGET = 1500;
const DEPTH = 16;

interface Case {
  readonly id: string;
  readonly body: string;
  readonly nonJson: boolean;
}

/** `const r1 = flag ? <branch of r0> : <branch of r0>; …` of `depth` names, from `bottom`. */
function chain(depth: number, bottom: string, branch: (name: string) => string): string {
  const lines = [`const r0 = ${bottom};`];
  for (let each = 1; each <= depth; each += 1) {
    const earlier = `r${String(each - 1)}`;
    lines.push(`const r${String(each)} = flag ? ${branch(earlier)} : ${branch(earlier)};`);
  }
  return lines.join(' ');
}

/** `new RegExp(name)`: a copy of the pattern `name` holds. */
function construction(name: string): string {
  return ['new RegExp(', name, ')'].join('');
}

const LAST = `r${String(DEPTH)}`;

const CASES: readonly Case[] = [
  {
    body: `${chain(DEPTH, '/a/g', construction)} return 'aba'.match(${LAST});`,
    id: 'converging-chain-of-sixteen-constructions',
    nonJson: false,
  },
  {
    body: `${chain(DEPTH, '/a/', construction)} return 'aba'.match(${LAST});`,
    id: 'pin-converging-chain-ending-in-a-pattern-that-is-not-global',
    nonJson: true,
  },
  {
    body: `${chain(3, '/a/g', (name) => name)} r0.compile('a'); return 'aba'.match(r3);`,
    id: 'pin-converging-chain-of-a-pattern-mutated-on-the-way',
    nonJson: true,
  },
  {
    body: "const r: RegExp = flag ? r : /a/g; return 'aba'.match(r);",
    id: 'pin-name-that-refers-to-itself',
    nonJson: true,
  },
  {
    body: `${chain(3, '/a/g', construction)} return 'aba'.match(r3);`,
    id: 'converging-chain-of-three-constructions',
    nonJson: false,
  },
];

/** The call `probe` returns. */
function returnedCall(file: SourceFile): CallExpression {
  for (const fn of file.statements) {
    if (!isFunctionDeclaration(fn) || fn.name?.text !== 'probe' || fn.body === undefined) {
      continue;
    }
    for (const statement of fn.body.statements) {
      if (isReturnStatement(statement) && statement.expression !== undefined) {
        const expression = unwrapped(statement.expression);
        if (isCallExpression(expression)) {
          return expression;
        }
      }
    }
  }
  throw new Error('expected a returned call in probe');
}

describe('the proof that a pattern is a native global one, through converging names', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)(
    '$id',
    ({ body, nonJson }) => {
      using parsed = parseModule(
        api,
        'retained-match-regexp-chain-work.ts',
        `export function probe(flag: boolean) { ${body} }\n`,
      );
      const call = returnedCall(parsed.sourceFile);
      const start = performance.now();
      const held = heldBy(call);
      const elapsed = performance.now() - start;

      expect(held?.nonJson).toBe(nonJson);
      expect(elapsed).toBeLessThan(BUDGET);
    },
    120_000,
  );

  it('a match of a converging chain of constructions runs as JSON', () => {
    expect(isJson('aba'.match(/a/gu))).toBe(true);
  });
});
