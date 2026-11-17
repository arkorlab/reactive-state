import { type Expression, isExpression, isFunctionDeclaration, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { middlewareArrayElement } from '../src/compiler/middleware-array-elements.ts';
import {
  middlewareCopiedCollections,
  middlewareEnumeration,
} from '../src/compiler/middleware-enumerations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Receiver-owned pure-read overrides invalidate exact negative selector normalization while
 * borrowed native `Array.prototype` calls and uncalled own selector assignments stay intact.
 */
const PURE_READ_OVERRIDE_CASES = [
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-slice-mutating-override-invalidates-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.slice(); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-concat-mutating-override-invalidates-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.concat = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.concat(0 as never); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-toreversed-mutating-override-invalidates-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.toReversed = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.toReversed(); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-with-mutating-override-invalidates-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.with = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.with(0, 1 as never); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-slice-aliased-to-push-grows-receiver-before-negative-at',
    source:
      'function read() { const items: Array<{ a: number } | number> = [{ a: 1 }, { a: 2 }]; items.slice = items.push as unknown as typeof items.slice; items.slice(0); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-slice-mutating-override-in-selector-argument-invalidates-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; return /*read*/ (items.at as (index: number, extra?: unknown) => { a: number } | undefined)(-1, items.slice()); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-slice-mutating-override-invalidates-borrowed-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.slice(); return /*read*/ Array.prototype.at.call(items, -1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-flat-mutating-override-retains-scalar-receiver-under-find',
    source:
      'function read(fresh: { a: number }) { const items: unknown[] = [0]; items.flat = function (this: unknown[]) { this.push(fresh); return []; }; items.flat(); return /*read*/ items.find(() => true); }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'borrowed-native-slice-call-ignores-own-slice-override-before-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; const copy = Array.prototype.slice.call(items, 0); void copy; return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'reflected-native-slice-apply-ignores-own-slice-override-before-negative-at',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; const copy = Reflect.apply(Array.prototype.slice, items, [0]); void copy; return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'own-slice-dot-call-still-runs-own-override-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; items.slice.call(items); return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'uncalled-own-slice-override-keeps-negative-at-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; return /*read*/ items.at(-1); }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'post-call-own-slice-override-keeps-earlier-negative-at-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; const copy = items.slice(); void copy; const picked = /*read*/ items.at(-1); items.slice = function (this: Array<{ a: number }>) { this.push(fresh); return []; }; return picked; }',
  },
  {
    expected: { origins: ['items:1'], single: true },
    id: 'unoverridden-pure-slice-call-keeps-negative-at-pin',
    source:
      'function read() { const items = [{ a: 1 }, { a: 2 }]; const copy = items.slice(0, 1); void copy; return /*read*/ items.at(-1); }',
  },
] as const;

const COMPUTED_OVERRIDE_CASES = [
  {
    expected: { origins: [], single: false },
    id: 'computed-literal-type-key-at-override-rejected',
    source:
      'function read(key: "at", fresh: { a: number }) { const items = [{ a: 1 }]; items[key] = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'computed-union-key-find-override-rejected',
    source:
      'function read(key: "find" | "other", fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<string, unknown>)[key] = () => fresh; return /*read*/ items.find(() => true); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'computed-arbitrary-string-key-at-override-rejected',
    source:
      'function read(key: string, fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<string, unknown>)[key] = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'computed-call-key-slice-override-rejected',
    source:
      'function read(pickKey: () => string, fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<string, unknown>)[pickKey()] = () => [fresh]; return /*read*/ items.slice()[0]; }',
  },
  {
    expected: { origins: [], single: false },
    id: 'computed-type-asserted-number-key-at-override-rejected',
    source:
      'function read(key: string, fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<number, unknown>)[key as unknown as number] = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'let-alias-own-at-override-rejected',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; let alias = items; alias.at = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'destructured-alias-computed-key-at-override-rejected',
    source:
      'function read(key: "at", fresh: { a: number }) { const items = [{ a: 1 }]; const [alias] = [items]; alias[key] = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'borrowed-define-property-call-at-override-rejected',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; Object.defineProperty.call(Object, items, "at", { value: () => fresh }); return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'const-aliased-reflect-set-dynamic-key-at-override-rejected',
    source:
      'function read(key: string, fresh: { a: number }) { const items = [{ a: 1 }]; const assignKey = Reflect.set; assignKey(items, key, () => fresh); return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: [], single: false },
    id: 'spread-object-assign-unknown-source-at-override-rejected',
    source:
      'function read(patch: Record<string, unknown>) { const items = [{ a: 1 }]; const args = [items, patch] as const; Object.assign(...args); return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'computed-unrelated-literal-type-key-retains-whole-receiver-pin',
    source:
      'function read(key: "other", fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<string, unknown>)[key] = () => fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'computed-numeric-parameter-index-write-retains-whole-receiver-pin',
    source:
      'function read(index: number, fresh: { a: number }) { const items = [{ a: 1 }, { a: 2 }]; items[index] = fresh; return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'define-property-unrelated-key-retains-whole-receiver-pin',
    source:
      'function read(fresh: { a: number }) { const items = [{ a: 1 }]; Object.defineProperty(items, "other", { value: fresh }); return /*read*/ items.at(0); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'borrowed-native-at-under-arbitrary-computed-key-retains-whole-receiver-pin',
    source:
      'function read(key: string, fresh: { a: number }) { const items = [{ a: 1 }]; (items as Record<string, unknown>)[key] = () => fresh; return /*read*/ Array.prototype.at.call(items, 0); }',
  },
] as const;

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

describe('middleware receiver overrides, computed selector keys, and destructuring targets', () => {
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
    using parsed = parseModule(api, 'receiver-overrides-and-destructuring.ts', source);
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

  it.each(PURE_READ_OVERRIDE_CASES)('$id', ({ expected, source }) => {
    expect(resolvedIn(source)).toStrictEqual(expected);
  });

  it.each(COMPUTED_OVERRIDE_CASES)('$id', ({ expected, source }) => {
    expect(resolvedIn(source)).toStrictEqual(expected);
  });
});
