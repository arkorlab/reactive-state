import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";

/**
 * A `let` holder that starts without a function and is later assigned an object or array that
 * holds one is read through a `const` alias of it (`const alias = holder`) as it is read directly.
 */
const CASES = [
  {
    id: 'alias-of-reassigned-holder-member',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named }; const alias = holder; return String(alias.pick); }',
  },
  {
    id: 'alias-of-reassigned-holder-bracket-key',
    reason: SOURCE_REASON,
    source:
      "function named() {} export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named }; const alias = holder; return String(alias['pick']); }",
  },
  {
    id: 'alias-of-reassigned-holder-dynamic-key',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out(key: string) { let holder: Record<string, unknown> = { pick: 0 }; holder = { pick: named }; const alias = holder; return String(alias[key]); }',
  },
  {
    id: 'alias-of-reassigned-array-slot',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let list: unknown[] = [0]; list = [named]; const alias = list; return String(alias[0]); }',
  },
  {
    id: 'alias-of-reassigned-array-dynamic-index',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out(index: number) { let list: unknown[] = [0]; list = [named]; const alias = list; return String(alias[index]); }',
  },
  {
    id: 'alias-of-alias-of-reassigned-holder',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named }; const alias = holder; const again = alias; return String(again.pick); }',
  },
  {
    id: 'conditional-alias-of-reassigned-holder',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out(flag: boolean) { let holder: { pick: unknown } = { pick: 0 }; let other: { pick: unknown } = { pick: 1 }; holder = { pick: named }; const alias = flag ? holder : other; return String(alias.pick); }',
  },
  {
    id: 'alias-of-reassigned-holder-name-read',
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named }; const alias = holder; return (alias.pick as () => void).name; }',
  },
  {
    id: 'spread-of-alias-of-reassigned-holder',
    reason: SOURCE_REASON,
    source:
      "function named() {} export function out() { let base: Record<string, unknown> = {}; base = { other: named }; const alias = base; const helpers = { label: 'ok', ...alias }; return String(helpers.label); }",
  },
  {
    id: 'direct-read-of-reassigned-holder-pin',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named }; return String(holder.pick); }',
  },
  {
    id: 'alias-of-const-holder-with-function-pin',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { const holder: { pick: unknown } = { pick: named }; const alias = holder; return String(alias.pick); }',
  },
  {
    id: 'alias-of-holder-reassigned-only-text-stays-accepted-pin',
    reason: undefined,
    source:
      "export function out() { let holder: { pick: unknown } = { pick: 0 }; holder = { pick: 'ready' }; const alias = holder; return String(alias.pick); }",
  },
  {
    id: 'alias-of-holder-never-reassigned-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out() { let holder: { pick: unknown } = { pick: 0 }; const alias = holder; return String(alias.pick); }',
  },
  {
    id: 'alias-of-array-reassigned-only-numbers-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out() { let list: unknown[] = [0]; list = [1, 2]; const alias = list; return String(alias[0]); }',
  },
  {
    id: 'spread-of-alias-of-reassigned-numbers-stays-accepted-pin',
    reason: undefined,
    source:
      "export function out() { let base: Record<string, unknown> = {}; base = { other: 1 }; const alias = base; const helpers = { label: 'ok', ...alias }; return String(helpers.label); }",
  },
] as const;

/** The first `functionRead` diagnostic encountered in `root`. */
function firstFunctionRead(root: Node): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    found = functionRead(node);
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(root);
  return found;
}

/** `a0` aliases a reassigned holder and each `a<n>` chooses between `a<n-1>` twice. */
function aliasLadder(levels: number): string {
  const lines = [
    'function named() {} export function out(flag: boolean) {',
    'let holder: { pick: unknown } = { pick: 0 }; holder = { pick: named };',
    'const a0 = holder;',
  ];
  for (let level = 1; level <= levels; level += 1) {
    lines.push(`const a${level} = flag ? a${level - 1} : a${level - 1};`);
  }
  lines.push(`return String(a${levels}.pick); }`);
  return lines.join('\n');
}

describe('const aliases of reassigned holders', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-holder-aliases.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });

  it('reads a ladder of 24 aliases that each name the one before twice in linear time', () => {
    using parsed = parseModule(api, 'function-holder-alias-ladder.ts', aliasLadder(24));
    const startMs = performance.now();
    const found = firstFunctionRead(parsed.sourceFile);

    expect(found).toBe(SOURCE_REASON);
    expect(performance.now() - startMs).toBeLessThan(500);
  });
});
