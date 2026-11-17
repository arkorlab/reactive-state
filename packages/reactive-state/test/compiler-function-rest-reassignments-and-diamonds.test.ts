import {
  isIdentifier,
  isVariableDeclaration,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";
const DIAMOND_LEVELS = 24;
const READ_CUTOFF = 10_000;
const LINEAR_READ_LIMIT = 8;

function buildConditionalChain(
  prefix: string,
  rootExpr: string,
  joiner: (prev: string) => string,
  tail: string,
): string {
  const parts = [`${prefix}export function out(flag: boolean) { const m0 = ${rootExpr};`];
  for (let index = 1; index <= DIAMOND_LEVELS; index += 1) {
    const prevName = `m${index - 1}`;
    const rhs = joiner(prevName);
    parts.push(`const m${index} = ${rhs};`);
  }
  parts.push(`${tail} }`);
  return parts.join(' ');
}

/**
 * Plain-identifier array rest (`[first, ...rest] = items`) and object rest (`({ a, ...rest } = src)`)
 * destructuring assignments record path-aware reassignments (preserving `startIndex` and statically
 * excluded sibling keys without treating shallow object-rest copies as aliases of `src`), while
 * conditional and logical alias diamonds memoize cycle-free subtrees and deduplicate candidates in
 * linear time without caching active cycle cuts.
 */
const CASES = [
  {
    id: 'array-rest-plain-identifier-static-index-read-name',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let first: unknown; let rest: (() => void)[] = []; [first, ...rest] = [named, named]; void first; return rest[0]!.name; }',
  },
  {
    id: 'array-rest-plain-identifier-entry-method-degraded-on-mutable-rest',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} const methods = { pick() {} }; export function out() { let first: unknown; let rest: (() => void)[] = []; [first, ...rest] = [named, methods.pick]; void first; return rest[0]!.name; }',
  },
  {
    id: 'array-rest-plain-identifier-initialized-safe-reassigned-bad-source',
    maxInitReads: READ_CUTOFF,
    reason: SOURCE_REASON,
    source:
      "function named() {} export function out() { const safe = { pick() {} }.pick; let first: unknown; let rest: unknown[] = ['safe']; [first, ...rest] = [safe, named]; void first; return String(rest[0]); }",
  },
  {
    id: 'array-rest-plain-identifier-dynamic-index-read-tostring',
    maxInitReads: READ_CUTOFF,
    reason: TOSTRING_REASON,
    source:
      "function named() {} export function out(index: number) { let first: unknown; let rest: unknown[] = []; [first, ...rest] = ['skip', named]; void first; return (rest[index] as () => void).toString(); }",
  },
  {
    id: 'array-rest-plain-identifier-read-via-const-destructuring',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let first: unknown; let rest: unknown[] = []; [first, ...rest] = ['skip', named]; void first; const [pick] = rest; return (pick as () => void).name; }",
  },
  {
    id: 'array-rest-plain-identifier-read-via-second-destructuring-assignment',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let first: unknown; let rest: unknown[] = []; [first, ...rest] = ['skip', named]; void first; let pick: unknown; [pick] = rest; return (pick as () => void).name; }",
  },
  {
    id: 'array-rest-annotated-function-array-from-opaque-parameter',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'export function out(items: (() => void)[]) { let first: unknown; let rest: (() => void)[]; [first, ...rest] = items; void first; return rest[0]!.name; }',
  },
  {
    id: 'object-rest-plain-identifier-direct-member-read-name',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let a: unknown; let rest: { pick?: string | (() => void) } = { pick: 'safe' }; ({ a, ...rest } = { a: 1, pick: named }); void a; return (rest.pick as () => void).name; }",
  },
  {
    id: 'object-rest-plain-identifier-without-siblings-source',
    maxInitReads: READ_CUTOFF,
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let rest: { pick?: () => void } = {}; ({ ...rest } = { pick: named }); return String(rest.pick); }',
  },
  {
    id: 'object-rest-plain-identifier-read-via-const-destructuring',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let a: unknown; let rest: { pick?: () => void } = {}; ({ a, ...rest } = { a: 1, pick: named }); void a; const { pick } = rest; return pick!.name; }',
  },
  {
    id: 'object-rest-plain-identifier-read-via-second-destructuring-assignment',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let a: unknown; let rest: { pick?: () => void } = {}; ({ a, ...rest } = { a: 1, pick: named }); void a; let pick: unknown; ({ pick } = rest); return (pick as () => void).name; }',
  },
  {
    id: 'object-rest-plain-identifier-dynamic-bracket-read-tostring',
    maxInitReads: READ_CUTOFF,
    reason: TOSTRING_REASON,
    source:
      "function named() {} export function out(key: string) { let a: unknown; let rest: Record<string, unknown> = {}; ({ a, ...rest } = { a: 'skip', pick: named }); void a; return (rest[key] as () => void).toString(); }",
  },
  {
    id: 'object-rest-spread-into-destination-propagates-held-this-writer',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let a: unknown; let rest: { swap?: () => void } = { swap() {} }; ({ a, ...rest } = { a: 1, swap() { (this as { pick?: () => void }).pick = named; } }); void a; const helpers = { ...rest, pick() {} }; helpers.swap?.(); return helpers.pick.name; }',
  },
  {
    id: 'object-rest-spread-into-destination-propagates-renamed-entry',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let a: unknown; let rest: { other?: string | (() => void) } = { other: 'safe' }; ({ a, ...rest } = { a: 1, other: named }); void a; const helpers = { ...rest, pick() {} }; return (helpers.other as () => void).name; }",
  },
  {
    id: 'conditional-alias-diamond-24-safe-spread-object-candidates',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: undefined,
    source: buildConditionalChain(
      '',
      '{ keep() {} }',
      (prev) => `flag ? ${prev} : ${prev}`,
      `const helpers = { ...m${DIAMOND_LEVELS}, pick() {} }; return helpers.pick.name;`,
    ),
  },
  {
    id: 'conditional-alias-diamond-24-this-writer-spread-object-candidates',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: NAME_REASON,
    source: buildConditionalChain(
      'function named() {} ',
      '{ swap() { (this as { pick?: () => void }).pick = named; } }',
      (prev) => `flag ? ${prev} : ${prev}`,
      `const helpers = { ...m${DIAMOND_LEVELS}, pick() {} }; (helpers as { swap?: () => void }).swap?.(); return helpers.pick.name;`,
    ),
  },
  {
    id: 'logical-alias-diamond-24-this-writer-spread-object-candidates',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: NAME_REASON,
    source: buildConditionalChain(
      'function named() {} ',
      '{ swap() { (this as { pick?: () => void }).pick = named; } }',
      (prev) => `${prev} || ${prev}`,
      `const helpers = { ...m${DIAMOND_LEVELS}, pick() {} }; (helpers as { swap?: () => void }).swap?.(); return helpers.pick.name;`,
    ),
  },
  {
    id: 'conditional-callable-alias-diamond-24-expression-callables',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: NAME_REASON,
    source: buildConditionalChain(
      'function named() {} ',
      'function (this: { pick?: () => void }) { this.pick = named; }',
      (prev) => `flag ? ${prev} : ${prev}`,
      `const helpers = { swap: m${DIAMOND_LEVELS}, pick() {} }; helpers.swap(); return helpers.pick.name;`,
    ),
  },
  {
    id: 'conditional-entry-kind-alias-diamond-24-direct-name-read',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: NAME_REASON,
    source: buildConditionalChain(
      'function named() {} ',
      'named',
      (prev) => `flag ? ${prev} : ${prev}`,
      `return m${DIAMOND_LEVELS}.name;`,
    ),
  },
  {
    id: 'conditional-reassigned-holder-diamond-24-member-read',
    maxInitReads: LINEAR_READ_LIMIT,
    reason: NAME_REASON,
    source: buildConditionalChain(
      'function named() {} ',
      '{ pick: named }',
      (prev) => `flag ? ${prev} : ${prev}`,
      `let pick: unknown; ({ pick } = m${DIAMOND_LEVELS}); return (pick as () => void).name;`,
    ),
  },
  {
    id: 'array-rest-skipping-function-prefix-keeps-string-tail-accepted-pin',
    maxInitReads: READ_CUTOFF,
    reason: undefined,
    source:
      "function named() {} export function out() { let first: unknown; let rest: unknown[] = []; [first, ...rest] = [named, 'safe']; void first; return String(rest[0]); }",
  },
  {
    id: 'object-rest-excluding-function-sibling-keeps-remaining-keys-accepted-pin',
    maxInitReads: READ_CUTOFF,
    reason: undefined,
    source:
      "function named() {} export function out() { let a: unknown; let rest: { b?: string } = {}; ({ a, ...rest } = { a: named, b: 'safe' }); void a; return String(rest.b); }",
  },
  {
    id: 'object-rest-excluding-function-sibling-dynamic-read-stays-accepted-pin',
    maxInitReads: READ_CUTOFF,
    reason: undefined,
    source:
      "function named() {} export function out(key: string) { let a: unknown; let rest: Record<string, unknown> = {}; ({ a, ...rest } = { a: named, b: 'safe' }); void a; return String(rest[key]); }",
  },
  {
    id: 'object-rest-mutation-does-not-taint-source-literal-pin',
    maxInitReads: READ_CUTOFF,
    reason: undefined,
    source:
      'function named() {} export function out() { const src = { pick() {} }; let rest: { pick?: () => void } = {}; ({ ...rest } = { ...src }); rest.pick = named; return src.pick.name; }',
  },
  {
    id: 'object-rest-excluding-this-writer-keeps-spread-destination-accepted-pin',
    maxInitReads: READ_CUTOFF,
    reason: undefined,
    source:
      'function named() {} export function out() { let swap: unknown; let rest: { safe?: () => void } = {}; ({ swap, ...rest } = { swap() { (this as { pick?: () => void }).pick = named; }, safe() {} }); void swap; const helpers = { ...rest, pick() {} }; helpers.safe?.(); return helpers.pick.name; }',
  },
  {
    id: 'cyclic-mutable-conditional-spread-avoids-poisoned-cache-pin',
    maxInitReads: READ_CUTOFF,
    reason: NAME_REASON,
    source:
      'function named() {} export function out(flag: boolean) { const m0 = { swap() { (this as { pick?: () => void }).pick = named; } }; let a: Record<string, unknown> = {}; let b: Record<string, unknown> = {}; b = flag ? a : {}; a = flag ? b : m0; const first = { ...a }; void first; const helpers = { ...b, pick() {} }; (helpers as { swap?: () => void }).swap?.(); return helpers.pick.name; }',
  },
] as const;

/** Finds `const m0 = ...` inside `root` when measuring diamond scaling. */
function findRootDeclaration(root: Node): VariableDeclaration | undefined {
  let found: VariableDeclaration | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'm0') {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** Runs `functionRead` over `root` while counting `m0.initializer` reads (capped at `READ_CUTOFF`). */
function evaluateModule(root: Node): {
  readonly found: string | undefined;
  readonly initReads: number;
} {
  const m0 = findRootDeclaration(root);
  let initReads = 0;
  if (m0 !== undefined) {
    const original = m0.initializer;
    Object.defineProperty(m0, 'initializer', {
      configurable: true,
      get(): VariableDeclaration['initializer'] {
        initReads += 1;
        if (initReads > READ_CUTOFF) {
          throw new Error(`m0.initializer read count exceeded ${READ_CUTOFF}`);
        }
        return original;
      },
    });
  }
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
  return { found, initReads };
}

describe('array and object rest reassignments and memoized conditional alias diamonds', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ maxInitReads, reason, source }) => {
    using parsed = parseModule(api, 'function-rest-and-diamonds.ts', source);
    const { found, initReads } = evaluateModule(parsed.sourceFile);

    expect(found).toBe(reason);
    expect(initReads).toBeLessThanOrEqual(maxInitReads);
  });
});
