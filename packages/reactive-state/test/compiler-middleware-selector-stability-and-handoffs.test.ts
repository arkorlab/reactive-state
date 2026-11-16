import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isExpression,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { initializerOf } from '../src/compiler/framed.ts';
import { middlewareArrayElement } from '../src/compiler/middleware-array-elements.ts';
import { middlewareCallbackHandoff } from '../src/compiler/middleware-callback-handoffs.ts';
import {
  middlewareCopiedCollections,
  middlewareEnumeration,
} from '../src/compiler/middleware-enumerations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface HandoffSummary {
  readonly callback: string | undefined;
  readonly unknown: boolean;
  readonly slots: readonly number[];
  readonly arraySlot: number;
  readonly primitiveItems: boolean;
}

/**
 * Direct and copied array selectors retain opaque element payloads, require receiver and argument
 * stability before normalizing negative slots, and refuse shown receiver-owned replacements.
 */
const SELECTOR_CASES = [
  {
    expected: { origins: ['items:'], single: true },
    id: 'opaque-parameter-at-unknown-index',
    source:
      'function read(payload: { a: number }, index: number) { const items = [payload]; return /*read*/ items.at(index); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'opaque-call-result-at-unknown-index',
    source:
      'function read(make: () => { a: number }, index: number) { const items = [make()]; return /*read*/ items.at(index); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'opaque-parameter-find',
    source:
      'function read(payload: { a: number }) { const items = [payload]; return /*read*/ items.find(() => true); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'opaque-parameter-findlast',
    source:
      'function read(payload: { a: number }) { const items = [payload]; return /*read*/ items.findLast(() => true); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'opaque-nested-field-at-unknown-index',
    source:
      'function read(payload: { a: number }, index: number) { const items = [{ nested: payload }]; return /*read*/ items.at(index)!.nested; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'negative-at-after-push-retains-whole-receiver',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.push(fresh); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'negative-at-ignored-argument-push-retains-whole-receiver',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; return /*read*/ (items.at as (index: number, extra?: number) => { a: number } | undefined)(-1, items.push(fresh)); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'borrowed-at-call-extra-argument-push-retains-whole-receiver',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; return /*read*/ Array.prototype.at.call(items, -1, items.push(fresh)); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'negative-at-out-of-initial-bounds-after-push',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; items.push(fresh); return /*read*/ items.at(-2); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'own-at-method-assignment-rejected',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; items.at = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'own-find-method-define-property-rejected',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; Object.defineProperty(items, "find", { value: () => fresh }); return /*read*/ items.find(() => true); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'own-slice-method-assignment-rejected',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; items.slice = () => [fresh]; return /*read*/ items.slice()[0]; }',
  },
  {
    expected: { origins: [], single: false },
    id: 'scalar-elements-at-unknown-index-pin',
    source:
      'function read(index: number) { const zero = 0; const items = [zero, "ok", true, null, undefined, 1n, -1]; return /*read*/ items.at(index); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'nested-scalar-field-at-unknown-index-pin',
    source:
      'function read(index: number) { const items = [{ nested: 0 }]; return /*read*/ items.at(index)!.nested; }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'stable-negative-at-exact-slot-pin',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; const seen = items[0]!.a; void seen; return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'stable-negative-at-out-of-bounds-pin',
    source: 'function read() { const items = [{ a: 1 }]; return /*read*/ items.at(-2); }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'borrowed-native-at-ignores-own-method-replacement-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.at = () => fresh; return /*read*/ Array.prototype.at.call(items, -1); }',
  },
  {
    expected: { origins: ['items:0'], single: true },
    id: 'post-call-own-at-replacement-keeps-earlier-read-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; const picked = /*read*/ items.at(0); items.at = () => fresh; return picked; }',
  },
] as const;

const HANDOFF_CASES: readonly {
  readonly id: string;
  readonly source: string;
  readonly expected: HandoffSummary | undefined;
}[] = [
  {
    expected: {
      arraySlot: 2,
      callback: 'visit',
      primitiveItems: false,
      slots: [0, 2],
      unknown: true,
    },
    id: 'foreach-thisarg-push-grows-empty-receiver',
    source:
      'function run(visit: (item: { a: number }) => void) { const items: Array<{ a: number }> = []; return /*call*/ items.forEach(visit, items.push({ a: 1 })); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: 'visit',
      primitiveItems: false,
      slots: [0, 2],
      unknown: true,
    },
    id: 'foreach-prior-push-grows-empty-receiver',
    source:
      'function run(visit: (item: { a: number }) => void) { const items: Array<{ a: number }> = []; items.push({ a: 1 }); return /*call*/ items.forEach(visit); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: '((items[0] = { a: 1 }), visit)',
      primitiveItems: false,
      slots: [0, 2],
      unknown: true,
    },
    id: 'foreach-callback-comma-index-assigns-empty-receiver',
    source:
      'function run(visit: (item: { a: number }) => void) { const items: Array<{ a: number }> = []; return /*call*/ items.forEach(((items[0] = { a: 1 }), visit)); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-single-element-prior-push-invokes-callback',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }) { const items = [{ a: 1 }]; items.push({ a: 2 }); return /*call*/ items.reduce(mutate); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: 'compare',
      primitiveItems: false,
      slots: [0, 1],
      unknown: true,
    },
    id: 'tosorted-single-element-argument-helper-grows-receiver',
    source:
      'function run(compare: (left: { a: number }, right: { a: number }) => number) { const items = [{ a: 1 }]; const grow = () => items.push({ a: 2 }); return /*call*/ (items.toSorted as (fn: typeof compare, extra?: number) => { a: number }[])(compare, grow()); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: 'visit',
      primitiveItems: false,
      slots: [0, 2],
      unknown: true,
    },
    id: 'foreach-scalar-initializer-argument-push-clears-primitive-items',
    source:
      'function run(visit: (item: unknown) => void) { const items: unknown[] = [0]; return /*call*/ items.forEach(visit, items.push({ a: 1 })); }',
  },
  {
    expected: undefined,
    id: 'foreach-stable-empty-receiver-suppressed-pin',
    source:
      'function run(visit: (item: { a: number }) => void) { const items: Array<{ a: number }> = []; return /*call*/ items.forEach(visit); }',
  },
  {
    expected: undefined,
    id: 'foreach-inline-empty-literal-with-call-arg-suppressed-pin',
    source:
      'function run(visit: (item: { a: number }) => void, other: () => Record<string, unknown>) { return /*call*/ ([] as Array<{ a: number }>).forEach(visit, other()); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: 'visit',
      primitiveItems: false,
      slots: [0, 2],
      unknown: false,
    },
    id: 'foreach-prior-element-read-keeps-known-handoff-pin',
    source:
      'function run(visit: (item: { a: number }) => void) { const items = [{ a: 1 }]; const seen = items[0]!.a; void seen; return /*call*/ items.forEach(visit); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: '(item) => { void items.length; void item.a; }',
      primitiveItems: false,
      slots: [0, 2],
      unknown: false,
    },
    id: 'foreach-inline-arrow-reading-receiver-keeps-known-handoff-pin',
    source:
      'function run() { const items = [{ a: 1 }]; return /*call*/ items.forEach((item) => { void items.length; void item.a; }); }',
  },
];

/** Follows lexical initializers to a written receiver literal while leaving parameters unresolved. */
function selectedLiteral(expression: Expression): Expression | undefined {
  let current = unwrapped(expression);
  const seen = new Set<Expression>();
  while (isIdentifier(current)) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const initializer = initializerOf(current);
    if (initializer === undefined) return undefined;
    current = unwrapped(initializer);
  }
  return current;
}

/** Finds the expression immediately following an inline marker comment inside the first function. */
function markedExpression(source: string, markerText: string, root: Node): Expression {
  const sourceFile = root.getSourceFile();
  const fn = sourceFile.statements.find((statement) => isFunctionDeclaration(statement));
  if (fn === undefined) throw new Error('Missing target function.');
  const marker = source.indexOf(markerText);
  let target: Expression | undefined;
  const visit = (node: Node): void => {
    if (target !== undefined) return;
    if (isExpression(node) && node.pos <= marker && marker < node.getStart(sourceFile)) {
      target = node;
      return;
    }
    node.forEachChild((child) => {
      visit(child);
    });
  };
  visit(fn);
  if (target === undefined) throw new Error('Missing marked expression.');
  return target;
}

/** Finds the call expression immediately following the inline call marker comment. */
function markedCall(source: string, root: Node): CallExpression {
  const expression = markedExpression(source, '/*call*/', root);
  if (!isCallExpression(expression)) throw new Error('Expected a marked call expression.');
  return expression;
}

describe('middleware selector stability, opaque payloads, and own replacements', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Summarizes direct or enumerated single origin alongside retained copy origins at the marked read expression. */
  function resolvedIn(source: string): {
    readonly origins: readonly string[];
    readonly single: boolean;
  } {
    using parsed = parseModule(api, 'selector-stability-and-handoffs.ts', source);
    const target = markedExpression(source, '/*read*/', parsed.sourceFile);
    const direct = middlewareEnumeration(target) ?? middlewareArrayElement(target);
    const copied = middlewareCopiedCollections(target);
    const merged = new Map<string, string>();
    if (direct !== undefined) {
      const key = `${direct.of.getText(parsed.sourceFile)}:${direct.keys.join('.')}`;
      merged.set(key, key);
    }
    for (const origin of copied) {
      const key = `${origin.of.getText(parsed.sourceFile)}:${origin.keys.join('.')}`;
      const owners = origin.references.map((reference) => reference.text).join(',');
      merged.set(key, owners.length > 0 ? `${key}@${owners}` : key);
    }
    return { origins: [...merged.values()], single: direct !== undefined };
  }

  /** Summarizes callback handoff metadata for the marked call expression. */
  function handoffIn(source: string): HandoffSummary | undefined {
    using parsed = parseModule(api, 'selector-handoffs.ts', source);
    const call = markedCall(source, parsed.sourceFile);
    const handoff = middlewareCallbackHandoff(call, (value) => selectedLiteral(value));
    if (handoff === undefined) return undefined;
    return {
      arraySlot: handoff.arraySlot,
      callback: handoff.callback?.getText(parsed.sourceFile),
      primitiveItems: handoff.primitiveItems,
      slots: handoff.slots,
      unknown: handoff.unknown,
    };
  }

  it.each(SELECTOR_CASES)('$id', ({ expected, source }) => {
    expect(resolvedIn(source)).toStrictEqual(expected);
  });

  it.each(HANDOFF_CASES)('$id', ({ expected, source }) => {
    expect(handoffIn(source)).toStrictEqual(expected);
  });
});
