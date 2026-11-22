import { type Expression, isExpression, isFunctionDeclaration, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  middlewareCopiedCollections,
  middlewareEnumeration,
} from '../src/compiler/middleware-enumerations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Shallow array copies whose bounds, order, spreads, or receiver stability are unresolved must
 * retain `{ of: receiver, keys: [] }` alongside inserted arguments and lexical literal owners even
 * when array slots hold parameters, call results, or post-declaration writes rather than literals.
 */
const CASES = [
  {
    expected: { origins: ['items:'], single: true },
    id: 'slice-unstable-parameter-payload',
    source:
      'function read(payload: object) { const items = [payload]; return /*read*/ Array.prototype.slice.call(items, 0, 1, items.reverse())[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'slice-unknown-bounds-call-result-payload',
    source:
      'function read(make: () => { a: number }, start: number) { const items = [make()]; return /*read*/ items.slice(start)[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'slice-unstable-negative-at-overwritten-slot',
    source:
      'function read(payload: { a: number }, extra: { a: number }) { const items = [payload, extra]; const copy = Array.prototype.slice.call(items, 0, 2, items.pop()); copy[0] = { a: 3 }; return /*read*/ copy.at(-1); }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'toreversed-unstable-parameter-payload',
    source:
      'function read(payload: { a: number }) { const items = [payload]; return /*read*/ items.toReversed(items.reverse() as never)[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'tosorted-stable-parameter-payload',
    source:
      'function read(payload: { a: number }) { const items = [payload, payload]; return /*read*/ items.toSorted(() => 0)[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'tosorted-unstable-mutated-empty-initializer',
    source:
      'function read(payload: { a: number }) { const items: { a: number }[] = []; items.push(payload); return /*read*/ items.toSorted()[0]; }',
  },
  {
    expected: { origins: ['items:', 'indices:', 'inserted:'], single: false },
    id: 'with-replacement-after-unknown-spread',
    source:
      'function read(payload: { a: number }, indices: number[], inserted: { a: number }) { const items = [payload]; return /*read*/ items.with(...(indices as [number]), inserted)[0]; }',
  },
  {
    expected: { origins: ['items:', 'args:'], single: false },
    id: 'with-borrowed-apply-unknown-tuple',
    source:
      'function read(payload: { a: number }) { const items = [payload]; const args: [number, { a: number }] = [0, { a: 2 }]; args[0] = 0; return /*read*/ Array.prototype.with.apply(items, args)[0]; }',
  },
  {
    expected: { origins: ['items:', '{ a: 2 }:@extra', 'groups:'], single: false },
    id: 'concat-unresolved-spread-and-literal-owner',
    source:
      'function read(payload: { a: number }, groups: { a: number }[][]) { const items = [payload]; const extra = [{ a: 2 }]; return /*read*/ items.concat(...extra, ...groups)[0]; }',
  },
  {
    expected: { origins: ['items:', 'args:'], single: false },
    id: 'concat-borrowed-apply-unknown-tuple',
    source:
      'function read(payload: { a: number }) { const items = [payload]; const args = [[{ a: 2 }]]; args.push([]); return /*read*/ Array.prototype.concat.apply(items, args)[0]; }',
  },
  {
    expected: { origins: ['items:', 'inserted:', 'inserted:nested'], single: false },
    id: 'concat-unstable-object-argument-member-tail',
    source:
      'function read(payload: { nested: { a: number } }, inserted: { nested: { a: number } }) { const items = [payload]; items.reverse(); return /*read*/ items.concat(inserted)[0]!.nested; }',
  },
  {
    expected: { origins: ['items:', 'inner:@items', 'payload:@inner'], single: false },
    id: 'flat-computed-depth-retains-outer-and-inner-arrays',
    source:
      'function read(payload: { a: number }, depths: number[]) { const inner = [payload]; const items = [inner]; const depth = depths[0]; return /*read*/ items.flat(depth)[0]; }',
  },
  {
    expected: { origins: ['items:'], single: true },
    id: 'slice-unstable-mutated-scalar-initializer',
    source:
      'function read(payload: { a: number }, start: number) { const items: unknown[] = [0]; items[0] = payload; return /*read*/ items.slice(start)[0]; }',
  },
  {
    expected: { origins: [], single: false },
    id: 'slice-stable-scalar-unknown-bounds-pin',
    source:
      'function read(start: number) { const items = [0]; return /*read*/ items.slice(start)[0]; }',
  },
  {
    expected: { origins: [], single: false },
    id: 'slice-stable-empty-unknown-bounds-pin',
    source:
      'function read(start: number) { const items: { a: number }[] = []; return /*read*/ items.slice(start)[0]; }',
  },
  {
    expected: { origins: ['items:0'], single: true },
    id: 'slice-stable-known-bounds-parameter-payload-pin',
    source:
      'function read(payload: { a: number }) { const items = [payload]; return /*read*/ items.slice(0, 1)[0]; }',
  },
  {
    expected: { origins: ['items:', 'inserted:'], single: false },
    id: 'tospliced-unstable-parameter-payload-pin',
    source:
      'function read(payload: { a: number }, inserted: { a: number }) { const items = [payload]; items.reverse(); return /*read*/ items.toSpliced(0, 1, inserted)[0]; }',
  },
  {
    expected: { origins: ['items:'], single: false },
    id: 'filter-unstable-parameter-payload-pin',
    source:
      'function read(payload: { a: number }) { const items = [payload]; return /*read*/ Array.prototype.filter.call(items, () => true, items.reverse())[0]; }',
  },
] as const;

describe('middleware array copy receiver fallbacks', () => {
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
    using parsed = parseModule(api, 'copy-receiver-fallbacks.ts', source);
    const fn = parsed.sourceFile.statements.find((statement) => isFunctionDeclaration(statement));
    if (fn === undefined) throw new Error('Missing target function.');
    const marker = source.indexOf('/*read*/');
    let target: Expression | undefined;
    const visit = (node: Node): void => {
      if (target !== undefined) return;
      if (isExpression(node) && node.pos <= marker && marker < node.getStart(parsed.sourceFile)) {
        target = node;
        return;
      }
      node.forEachChild((child) => {
        visit(child);
      });
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
