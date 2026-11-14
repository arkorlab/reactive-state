import {
  type Expression,
  type Identifier,
  isBlock,
  isIdentifier,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { constantValue, writtenTime } from '../src/compiler/numbers.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A constant that other constants read, several times each, is read once: the work of a reading
 * grows with the constants, not with the ways to reach them (a chain whose every constant reads the
 * one before twice is 2^n ways). What a name cut short (a constant that reads itself) holds is no
 * constant, and is not kept for another way to it; and a reading takes no more than a bounded number
 * of constants, past which it takes the rest for none. A date is read the same way as a value: a
 * constant that holds one, read through a method of it, is read once too.
 */
const CHAIN = 16;

/** The constants `c0 = first`, `c1 = step(c0)`, up to `c<length>`, as source. */
function chain(first: string, step: (before: string) => string, length: number): string {
  const parts = [`const c0 = ${first};`];
  for (let at = 1; at <= length; at++) {
    const before = `c${at - 1}`;
    parts.push(`const c${at} = ${step(before)};`);
  }
  return parts.join(' ');
}

/** The constants `chain` writes, but that `c0` reads the last of: a cycle through all of them. */
function cycle(step: (before: string) => string, length: number): string {
  return `const c0 = c${length}; ${chain('0', step, length).replace('const c0 = 0; ', '')}`;
}

/** The dates `c0 = new Date(first)`, `c1 = step(c0)`, up to `c16`, and `last`, the time of the last. */
function dates(first: string, step: (before: string) => string): string {
  const made = `new Date(${first})`;
  return `${chain(made, step, CHAIN)} const last = c${CHAIN}.getTime();`;
}

const CASES = [
  {
    id: 'sum-of-the-constant-before-twice',
    source: chain('1', (before) => `${before} + ${before}`, CHAIN),
    last: `c${CHAIN}`,
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'product-of-the-constant-before-three-times-in-all',
    source: chain('1', (before) => `${before} * 2 + ${before} - ${before}`, 10),
    last: 'c10',
    value: 2 ** 10,
    reads: 60,
  },
  {
    id: 'maximum-of-the-constant-before-twice',
    source: chain('1', (before) => `Math.max(${before}, ${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: 1,
    reads: 40,
  },
  {
    id: 'text-made-a-number-twice',
    source: chain('1', (before) => `Number(${before}) + Number(${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'squares-reach-infinity-pin',
    source: chain('2', (before) => `${before} * ${before}`, 11),
    last: 'c11',
    value: Infinity,
    reads: 40,
  },
  {
    id: 'constant-read-by-two-ways-pin',
    source: 'const x = 3; const a = x + 1; const b = x + a;',
    last: 'b',
    value: 7,
    reads: 10,
  },
  {
    id: 'constants-that-read-each-other-are-none-pin',
    source: 'const a = b + 1; const b = a + 1;',
    last: 'a',
    value: undefined,
    reads: 10,
  },
  {
    id: 'constant-that-reads-itself-is-none-pin',
    source: 'const a = a + 1;',
    last: 'a',
    value: undefined,
    reads: 10,
  },
  {
    id: 'time-of-the-latest-of-the-date-before-twice',
    source: dates('1', (before) => `new Date(Math.max(${before}.getTime(), ${before}.getTime()))`),
    last: 'last',
    value: 1,
    reads: 40,
  },
  {
    id: 'time-of-the-date-before-and-its-value-of',
    source: dates('1', (before) => `new Date(${before}.getTime() + ${before}.valueOf())`),
    last: 'last',
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'date-by-the-parts-of-the-date-before',
    source: dates(
      '0',
      (before) => `new Date(Date.UTC(${before}.getUTCFullYear(), ${before}.getUTCMonth()))`,
    ),
    last: 'last',
    value: 0,
    reads: 40,
  },
  {
    id: 'date-by-a-setter-of-the-date-before',
    source: dates('0', (before) => `new Date(${before}.setTime(${before}.getTime()))`),
    last: 'last',
    value: 0,
    reads: 40,
  },
  {
    id: 'date-by-what-setters-answer-whatever-the-date',
    source: dates(
      '0',
      (before) => `new Date(${before}.setTime(Infinity) + ${before}.setHours(Infinity))`,
    ),
    last: 'last',
    value: NaN,
    reads: 40,
  },
  {
    id: 'numbers-and-dates-read-each-other',
    source: chain(
      '1',
      (before) => `new Date(${before}).getTime() + new Date(${before}).getTime()`,
      CHAIN,
    ),
    last: `c${CHAIN}`,
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'time-of-a-date-the-dates-before-hold',
    source: chain('new Date(1)', (before) => `new Date(${before}.getTime())`, CHAIN),
    last: `c${CHAIN}`,
    value: 1,
    reads: 40,
    time: true,
  },
  {
    id: 'date-that-reads-its-own-time-is-none-pin',
    source: 'const x = d.getTime(); const d = new Date(x);',
    last: 'x',
    value: undefined,
    reads: 10,
  },
  {
    id: 'value-kept-from-a-cut-in-another-way-is-read-again',
    source:
      'const p = 1; const q = p + 1; { const p = q + 1; const dd = new Date(p); const last = Math.max(dd.setTime(Infinity), q); }',
    last: 'last',
    value: NaN,
    reads: 40,
    scoped: true,
  },
  {
    id: 'time-kept-from-a-cut-in-another-way-is-read-again',
    source:
      'const p = 0; const dq = new Date(p); { const p = dq.getTime(); const dd = new Date(p); const last = Math.max(dd.setTime(Infinity), dq.getTime()); }',
    last: 'last',
    value: NaN,
    reads: 40,
    scoped: true,
  },
  {
    id: 'value-of-the-constant-the-cut-reached-pin',
    source: 'const p = 1; const q = p + 1; { const p = q + 1; const last = q; }',
    last: 'last',
    value: 2,
    reads: 10,
    scoped: true,
  },
  {
    id: 'chain-that-reads-itself-at-its-start-is-none',
    source: cycle((before) => `Math.max(${before}, ${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: undefined,
    reads: 20_000,
  },
] as const;

interface Row {
  readonly source: string;
  readonly last: string;
  readonly value: number | undefined;
  readonly reads: number;
  /** Read the time of the date `last` holds, as `writtenTime`. */
  readonly time?: boolean;
  /** Resolve a name to the nearest constant of the scopes it is written in, as the compile does. */
  readonly scoped?: boolean;
}

describe('constants that other constants read many times', () => {
  it.each(CASES as readonly (Row & { id: string })[])(
    '$id',
    ({ source, last, value, reads, time, scoped }) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'constant-resolution.ts', source);
      const held = constantsOf(parsed.sourceFile);
      let calls = 0;
      const resolve = (name: Identifier): Expression | undefined => {
        calls += 1;
        return scoped === true ? scopedConstant(name) : held.get(name.text);
      };
      const start = startOf(held, last);

      expect(time === true ? writtenTime(start, resolve) : constantValue(start, resolve)).toBe(
        value,
      );
      expect(calls).toBeLessThanOrEqual(reads);
    },
  );
});

/** The initializer of each constant the source declares, by its name. */
function constantsOf(root: Node): ReadonlyMap<string, Expression> {
  const held = new Map<string, Expression>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined)
      held.set(node.name.text, node.initializer);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return held;
}

function startOf(held: ReadonlyMap<string, Expression>, name: string): Expression {
  const start = held.get(name);
  if (start === undefined) throw new Error(`no constant ${name}`);
  return start;
}

/** The initializer of the nearest constant of the name's text that the blocks around the name declare. */
function scopedConstant(name: Identifier): Expression | undefined {
  for (let at: Node = name.parent; ; at = at.parent) {
    const declared =
      isBlock(at) || isSourceFile(at) ? declaredIn(at.statements, name.text) : undefined;
    if (declared !== undefined || isSourceFile(at)) return declared;
  }
}

/** The initializer of the constant a list of statements declares by a name. */
function declaredIn(statements: readonly Node[], text: string): Expression | undefined {
  return statements
    .filter((statement) => isVariableStatement(statement))
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => isIdentifier(declaration.name) && declaration.name.text === text)
    ?.initializer;
}
