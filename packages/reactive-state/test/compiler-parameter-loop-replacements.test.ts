import { type Identifier, isFunctionDeclaration, isIdentifier, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parameterValue } from '../src/compiler/parameter-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A replacement before a loop no longer describes a parameter read inside the loop when a later
 * part of the same loop reassigns that binding on an earlier iteration.
 */
const CASES = [
  {
    expected: undefined,
    id: 'for-body-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let i = 0; i < 2; i++) { if (i === 1) return /*read*/ p; p = other; } return 0; }',
  },
  {
    expected: undefined,
    id: 'for-incrementor-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let i = 0; i < 2 && Boolean(/*read*/ p); p = other, i++) {} return 0; }',
  },
  {
    expected: undefined,
    id: 'while-destructuring-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; let i = 0; while (i++ < 2) { if (i === 2) return /*read*/ p; [p] = [other]; } return 0; }',
  },
  {
    expected: undefined,
    id: 'do-while-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; let i = 0; do { if (i === 1) return /*read*/ p; p = other; } while (++i < 2); return 0; }',
  },
  {
    expected: undefined,
    id: 'hoisted-var-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let i = 0; i < 2; i++) { if (i === 1) return /*read*/ p; var p = other; } return 0; }',
  },
  {
    expected: undefined,
    id: 'for-of-var-after-read',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let i = 0; i < 2; i++) { if (i === 1) return /*read*/ p; for (var p of [other]) {} } return 0; }',
  },
  {
    expected: '{ safe: 1 }',
    id: 'write-after-loop-pin',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let i = 0; i < 2; i++) { if (i === 1) return /*read*/ p; } p = other; return 0; }',
  },
  {
    expected: '{ safe: 1 }',
    id: 'for-initializer-once-pin',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (let saved = /*read*/ p, i = 0; i < 2; i++) { p = other; if (i === 1) return saved; } return 0; }',
  },
  {
    expected: '{ safe: 1 }',
    id: 'for-of-expression-once-pin',
    source:
      'function make(p: unknown, other: unknown) { p = { safe: 1 }; for (const saved of [/*read*/ p]) { p = other; return saved; } return 0; }',
  },
  {
    expected: '{ safe: 1 }',
    id: 'member-write-only-in-loop-pin',
    source:
      'function make(p: { safe?: number }) { p = { safe: 1 }; for (let i = 0; i < 2; i++) { if (i === 1) return /*read*/ p; p.safe = 2; } return 0; }',
  },
] as const;

describe('loop-carried parameter replacements', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Resolves the marked `p` read inside `make` against its formal parameter declaration. */
  function resolvedIn(source: string): string | undefined {
    using parsed = parseModule(api, 'parameter-loop.ts', source);
    const fn = parsed.sourceFile.statements.find(isFunctionDeclaration);
    const declared = fn?.parameters[0]?.name;
    if (fn === undefined || declared === undefined || !isIdentifier(declared)) {
      throw new Error('Missing target function parameter.');
    }
    const marker = source.indexOf('/*read*/');
    let target: Identifier | undefined;
    const visit = (node: Node): void => {
      if (target !== undefined) {
        return;
      }
      if (isIdentifier(node) && node.text === 'p' && node.pos <= marker && marker < node.end) {
        target = node;
        return;
      }
      node.forEachChild(visit);
    };
    visit(fn);
    if (target === undefined) {
      throw new Error('Missing marked parameter read.');
    }
    return parameterValue(fn, declared, target)?.value.getText(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(resolvedIn(source)).toBe(expected);
  });
});
