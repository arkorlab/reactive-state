import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { initializerOf } from '../src/compiler/framed.ts';
import { middlewareCallbackHandoff } from '../src/compiler/middleware-callback-handoffs.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Summary {
  readonly arraySlot: number;
  readonly callback: string | undefined;
  readonly primitiveItems: boolean;
  readonly slots: readonly number[];
  readonly unknown: boolean;
}

/**
 * Unresolved or exposed argument spreads on `reduce` and `reduceRight` can still invoke the
 * callback on a single-element receiver when non-empty while passing receiver item zero in
 * accumulator slot `0` when the spread evaluates to empty.
 */
const CASES: readonly {
  readonly expected: Summary | undefined;
  readonly id: string;
  readonly source: string;
}[] = [
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-parameter-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }, extra: readonly { a: number }[]) { const items = [{ a: 1 }, { a: 2 }]; return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-right-parameter-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }, extra: readonly { a: number }[]) { const items = [{ a: 1 }, { a: 2 }]; return /*call*/ items.reduceRight(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-conditional-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }, withInitial: boolean) { const items = [{ a: 1 }, { a: 2 }]; return /*call*/ items.reduce(mutate, ...(withInitial ? [{ a: 0 }] : [])); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-exposed-spread-pop',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }) { const items = [{ a: 1 }, { a: 2 }]; const extra = [{ a: 0 }]; extra.pop(); return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-exposed-whole-tuple-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }) { const items = [{ a: 1 }, { a: 2 }]; const args: [typeof mutate, { a: number }?] = [mutate, { a: 0 }]; args.pop(); return /*call*/ items.reduce(...args); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-single-item-unknown-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }, extra: readonly { a: number }[]) { const items = [{ a: 1 }]; return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-unresolved-receiver-spread',
    source:
      'function run(items: { a: number }[], mutate: (acc: { a: number }, item: { a: number }) => { a: number }, extra: readonly { a: number }[]) { return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: true,
    },
    id: 'reduce-nested-tuple-unknown-spread',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }, extra: readonly { a: number }[]) { const items = [{ a: 1 }, { a: 2 }]; const args = [mutate, ...extra] as const; return /*call*/ items.reduce(...args); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3],
      unknown: false,
    },
    id: 'reduce-explicit-initial-pin',
    source:
      'function run(mutate: (acc: number, item: { a: number }) => number) { const items = [{ a: 1 }, { a: 2 }]; return /*call*/ items.reduce(mutate, 0); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3],
      unknown: false,
    },
    id: 'reduce-constant-nonempty-spread-pin',
    source:
      'function run(mutate: (acc: number, item: { a: number }) => number) { const items = [{ a: 1 }, { a: 2 }]; const extra = [0]; return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3, 0],
      unknown: false,
    },
    id: 'reduce-constant-empty-spread-pin',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }) { const items = [{ a: 1 }, { a: 2 }]; const extra: readonly { a: number }[] = []; return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: undefined,
    id: 'reduce-single-empty-spread-none-pin',
    source:
      'function run(mutate: (acc: { a: number }, item: { a: number }) => { a: number }) { const items = [{ a: 1 }]; const extra: readonly { a: number }[] = []; return /*call*/ items.reduce(mutate, ...extra); }',
  },
  {
    expected: {
      arraySlot: 3,
      callback: 'mutate',
      primitiveItems: false,
      slots: [1, 3],
      unknown: false,
    },
    id: 'reduce-initial-before-spread-pin',
    source:
      'function run(mutate: (acc: number, item: { a: number }) => number, rest: readonly unknown[]) { const items = [{ a: 1 }, { a: 2 }]; return /*call*/ items.reduce(mutate, 0, ...(rest as [])); }',
  },
  {
    expected: {
      arraySlot: 2,
      callback: 'visit',
      primitiveItems: false,
      slots: [0, 2],
      unknown: true,
    },
    id: 'foreach-unknown-this-spread-pin',
    source:
      'function run(visit: (item: { a: number }) => void, extra: readonly object[]) { const items = [{ a: 1 }]; return /*call*/ items.forEach(visit, ...(extra as [object?])); }',
  },
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

/** Finds the call expression immediately following the inline call marker comment. */
function markedCall(source: string, sourceFile: SourceFile): CallExpression {
  const fn = sourceFile.statements.find((statement) => isFunctionDeclaration(statement));
  if (fn === undefined) throw new Error('Missing target function.');
  const marker = source.indexOf('/*call*/');
  let target: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (target !== undefined) return;
    if (isCallExpression(node) && node.pos <= marker && marker < node.getStart(sourceFile)) {
      target = node;
      return;
    }
    node.forEachChild((child) => {
      visit(child);
    });
  };
  visit(fn);
  if (target === undefined) throw new Error('Missing marked call expression.');
  return target;
}

describe('middleware reduce spread callback slots', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Summarizes callback handoff metadata for the marked call expression. */
  function handoffIn(source: string): Summary | undefined {
    using parsed = parseModule(api, 'reduce-spread-slots.ts', source);
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

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(handoffIn(source)).toStrictEqual(expected);
  });
});
