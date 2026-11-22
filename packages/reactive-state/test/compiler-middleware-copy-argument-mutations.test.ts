import { type Expression, isExpression, isFunctionDeclaration, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  middlewareCopiedCollections,
  middlewareEnumeration,
} from '../src/compiler/middleware-enumerations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Copy arguments and borrowed `apply` wrapper tails run before native array copies read receiver
 * length and elements, so non-quiet argument work must drop exact slot and length assumptions.
 */
const CASES = [
  {
    expected: { origins: ['items:', 'items.shift()!:'], single: false },
    id: 'with-value-shift-mutates-receiver',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }, { a: 3 }]; return /*read*/ items.with(1, items.shift()!)[0]; }',
  },
  {
    expected: { origins: ['items:', 'grow(items):'], single: false },
    id: 'with-helper-call-grows-receiver',
    source:
      'function read(grow: (list: { a: number }[]) => { a: number }) { const items = [{ a: 1 }]; return /*read*/ items.with(0, grow(items))[1]; }',
  },
  {
    expected: { origins: ['items:', 'items.pop()!:'], single: false },
    id: 'with-pop-argument-negative-at-overwritten-slot',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }, { a: 3 }]; const fresh = { a: 4 }; const copy = items.with(1, items.pop()!); copy[1] = fresh; return /*read*/ copy.at(-2); }',
  },
  {
    expected: { origins: ['items:'], single: false },
    id: 'map-thisarg-pop-negative-at-overwritten-slot',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }, { a: 3 }]; const fresh = { a: 4 }; const copy = items.map((item) => item, items.pop()); copy[1] = fresh; return /*read*/ copy.at(-2); }',
  },
  {
    expected: { origins: ['items:', 'fresh:'], single: false },
    id: 'with-apply-wrapper-tail-mutates-receiver',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }, { a: 3 }]; const fresh = { a: 4 }; return /*read*/ Array.prototype.with.apply(items, [1, fresh], items.shift())[0]; }',
  },
  {
    expected: { origins: ['items:', 'items.shift()!:'], single: false },
    id: 'tospliced-inserted-shift-mutates-receiver',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; return /*read*/ items.toSpliced(1, 1, items.shift()!)[0]; }',
  },
  {
    expected: { origins: ['items:', 'items.pop()!:'], single: false },
    id: 'tospliced-inserted-pop-negative-at-overwritten-slot',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }, { a: 3 }]; const fresh = { a: 4 }; const copy = items.toSpliced(0, 0, items.pop()!); copy[2] = fresh; return /*read*/ copy.at(-2); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'slice-ignored-argument-shift-mutates-receiver',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; return /*read*/ Array.prototype.slice.call(items, 0, 1, items.shift())[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'toreversed-ignored-argument-pop-mutates-receiver',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; return /*read*/ items.toReversed(items.pop() as never)[0]; }',
  },
  {
    expected: { origins: ['fresh:'], single: false },
    id: 'with-quiet-replacement-exact-pin',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; const fresh = { a: 3 }; return /*read*/ items.with(0, fresh)[0]; }',
  },
  {
    expected: { origins: ['items:0'], single: false },
    id: 'with-quiet-other-slot-exact-pin',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; const fresh = { a: 3 }; return /*read*/ items.with(1, fresh)[0]; }',
  },
  {
    expected: { origins: [], single: false },
    id: 'map-arrow-callback-negative-at-overwritten-slot-pin',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; const fresh = { a: 3 }; const copy = items.map((item) => item); copy[1] = fresh; return /*read*/ copy.at(-1); }',
  },
  {
    expected: { origins: ['fresh:'], single: true },
    id: 'tospliced-quiet-replacement-exact-pin',
    source:
      'function read() { const items = [{ a: 1 }]; const fresh = { a: 2 }; return /*read*/ items.toSpliced(0, 1, fresh)[0]; }',
  },
] as const;

describe('middleware array copy argument mutations', () => {
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
    using parsed = parseModule(api, 'copy-argument-mutations.ts', source);
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
