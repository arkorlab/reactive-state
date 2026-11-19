import { type Expression, isExpression, isFunctionDeclaration, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  middlewareCopiedCollections,
  middlewareEnumeration,
} from '../src/compiler/middleware-enumerations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Unknown-bound and spread `toSpliced` copies retain both the original array and every possible
 * inserted argument or spread source instead of keeping only the receiver.
 */
const CASES = [
  {
    expected: { origins: ['items:', 'inserted:'], single: false },
    id: 'unknown-start-inserted-item',
    source:
      'function read(start: number) { const items = [{ a: 1 }]; const inserted = { a: 2 }; return /*read*/ items.toSpliced(start, 0, inserted)[0]; }',
  },
  {
    expected: { origins: ['items:', 'inserted:nested'], single: false },
    id: 'unknown-delete-count-inserted-nested-tail',
    source:
      'function read(count: number) { const items = [{ nested: { a: 1 } }]; const inserted = { nested: { a: 2 } }; return /*read*/ items.toSpliced(0, count, inserted)[0]!.nested; }',
  },
  {
    expected: { origins: ['items:', 'inserted:'], single: false },
    id: 'unknown-start-negative-at-inserted-item',
    source:
      'function read(start: number) { const items = [{ a: 1 }]; const inserted = { a: 2 }; const copy = items.toSpliced(start, 0, inserted); copy[0] = { a: 3 }; return /*read*/ copy.at(-1); }',
  },
  {
    expected: { origins: ['items:', 'extra:'], single: false },
    id: 'unknown-spread-inserted-items',
    source:
      'function read() { const items = [{ a: 1 }]; const extra = [{ a: 2 }]; extra.push({ a: 3 }); return /*read*/ items.toSpliced(0, 0, ...extra)[0]; }',
  },
  {
    expected: { origins: ['items:', 'bounds:', 'inserted:'], single: false },
    id: 'inserted-item-after-unknown-spread',
    source:
      'function read(bounds: number[]) { const items = [{ a: 1 }]; const inserted = { a: 2 }; return /*read*/ items.toSpliced(...(bounds as [number, number]), inserted)[0]; }',
  },
  {
    expected: { origins: ['items:', 'args:'], single: false },
    id: 'borrowed-apply-unknown-tuple',
    source:
      'function read() { const items = [{ a: 1 }]; const args: [number, number, { a: number }] = [0, 0, { a: 2 }]; args[0] = 1; return /*read*/ Array.prototype.toSpliced.apply(items, args)[0]; }',
  },
  {
    expected: { origins: ['{ a: 2 }:@extra'], single: true },
    id: 'constant-spread-inserted-literal-owner',
    source:
      'function read() { const items = [{ a: 1 }]; const extra = [{ a: 2 }]; return /*read*/ items.toSpliced(0, 0, ...extra)[0]; }',
  },
  {
    expected: { origins: ['inserted:'], single: true },
    id: 'known-bounds-inserted-slot-pin',
    source:
      'function read() { const items = [{ a: 1 }]; const inserted = { a: 2 }; return /*read*/ items.toSpliced(0, 0, inserted)[0]; }',
  },
  {
    expected: { origins: ['items:0'], single: true },
    id: 'known-bounds-shifted-original-slot-pin',
    source:
      'function read() { const items = [{ a: 1 }]; const inserted = { a: 2 }; return /*read*/ items.toSpliced(0, 0, inserted)[1]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'unknown-start-without-insertions-pin',
    source:
      'function read(start: number) { const items = [{ a: 1 }]; return /*read*/ items.toSpliced(start, 0)[0]; }',
  },
  {
    expected: { origins: ['items:0', 'inserted:'], single: false },
    id: 'with-unknown-index-replacement-pin',
    source:
      'function read(index: number) { const items = [{ a: 1 }]; const inserted = { a: 2 }; return /*read*/ items.with(index, inserted)[0]; }',
  },
] as const;

describe('spliced middleware copy inserted origins', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Summarizes single-origin enumeration and retained copy origins at the marked read expression. */
  function resolvedIn(source: string): {
    readonly origins: readonly string[];
    readonly single: boolean;
  } {
    using parsed = parseModule(api, 'splice-inserted-origins.ts', source);
    const fn = parsed.sourceFile.statements.find(isFunctionDeclaration);
    if (fn === undefined) throw new Error('Missing target function.');
    const marker = source.indexOf('/*read*/');
    let target: Expression | undefined;
    const visit = (node: Node): void => {
      if (target !== undefined) return;
      if (isExpression(node) && node.pos <= marker && marker < node.getStart(parsed.sourceFile)) {
        target = node;
        return;
      }
      node.forEachChild(visit);
    };
    visit(fn);
    if (target === undefined) throw new Error('Missing marked read expression.');
    const enumerated = middlewareEnumeration(target);
    const copied = middlewareCopiedCollections(target);
    const merged = new Map<string, string>();
    if (enumerated !== undefined) {
      const key = `${enumerated.of.getText(parsed.sourceFile)}:${enumerated.keys.join('.')}`;
      merged.set(key, key);
    }
    for (const origin of copied) {
      const key = `${origin.of.getText(parsed.sourceFile)}:${origin.keys.join('.')}`;
      const owners = origin.references.map((reference) => reference.text).join(',');
      merged.set(key, owners.length > 0 ? `${key}@${owners}` : key);
    }
    return { origins: [...merged.values()], single: enumerated !== undefined };
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(resolvedIn(source)).toStrictEqual(expected);
  });
});
