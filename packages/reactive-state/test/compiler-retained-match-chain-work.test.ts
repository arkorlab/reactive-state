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
 * Whether a text is native is proved by following each name it is written as to what it was
 * assigned, down a chain of conditionals. Where both branches name the same earlier name, the
 * branches converge, and each name must be resolved once, however it is reached: a chain of such
 * names grows the work with the source, not with the number of paths through it, which doubles
 * with each name. A cycle of names still ends, and a native constructor at the bottom of the chain
 * is still found.
 */

/** Milliseconds a proof may take: a chain of sixteen took four seconds when each path was walked. */
const BUDGET = 1500;
const DEPTH = 16;

interface Case {
  readonly id: string;
  readonly body: string;
  readonly nonJson: boolean;
  /** What the code returns, where running it changes nothing it is run beside. */
  readonly run?: () => unknown;
}

/** `const s1 = flag ? s0 : s0.trim(); …` of `depth` names, from `s0`. */
function trimmedChain(depth: number): string {
  const lines = ["const s0 = 'a';"];
  for (let each = 1; each <= depth; each += 1) {
    lines.push(
      `const s${String(each)} = flag ? s${String(each - 1)} : s${String(each - 1)}.trim();`,
    );
  }
  return lines.join(' ');
}

/** `const s1 = flag ? s0 : s0; …` of `depth` names, from the native constructor `String`. */
function nativeChain(depth: number): string {
  const lines = ['const s0 = String;'];
  for (let each = 1; each <= depth; each += 1) {
    lines.push(`const s${String(each)} = flag ? s${String(each - 1)} : s${String(each - 1)};`);
  }
  return lines.join(' ');
}

const CASES: readonly Case[] = [
  {
    body: `${trimmedChain(DEPTH)} return s${String(DEPTH)}.match(/a/g);`,
    id: 'converging-chain-of-sixteen-texts',
    nonJson: false,
    run: () => 'a'.match(/a/gu),
  },
  {
    body: `${nativeChain(DEPTH)} s${String(DEPTH)}.prototype.match = () => NaN; return 'aba'.match(/a/g);`,
    id: 'converging-chain-of-sixteen-reaching-the-native-constructor',
    nonJson: true,
  },
  {
    body: `${nativeChain(3)} s3.prototype.match = () => NaN; return 'aba'.match(/a/g);`,
    id: 'converging-chain-of-three-reaching-the-native-constructor',
    nonJson: true,
  },
  {
    body: "let s: unknown = String; s = flag ? s : s; (s as typeof String).prototype.match = () => NaN; return 'aba'.match(/a/g);",
    id: 'name-assigned-from-itself-reaching-the-native-constructor',
    nonJson: true,
  },
  {
    body: "let s: unknown = String; let t: unknown = Object; s = flag ? t : s; t = flag ? s : t; (s as typeof String).prototype.match = () => NaN; return 'aba'.match(/a/g);",
    id: 'two-names-assigned-from-each-other-reaching-the-native-constructor',
    nonJson: true,
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

describe('the proof that a text is native, through converging names', () => {
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
        'retained-match-chain-work.ts',
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

  it.each(CASES.filter((each) => each.run !== undefined))(
    '$id runs as JSON',
    ({ nonJson, run }) => {
      expect(isJson(run?.())).toBe(!nonJson);
    },
  );
});
