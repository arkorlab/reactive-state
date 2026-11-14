import {
  type Expression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { writtenArrayKey } from '../src/compiler/framed-array-functions.ts';
import { framedHeldMember } from '../src/compiler/framed-held-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.assign(holder, first, second)` writes each source in turn, so a name the sources share
 * holds what the last of them gives it, and a source that names another key may still be that
 * name: the writes of one call are ordered, not all replaced by the first one that is a definite
 * overwrite.
 */
const CASES = [
  {
    id: 'later-source-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { x: error }); return box.x; }`,
    selects: true,
  },
  {
    id: 'later-source-overrides-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'three-sources-last-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { x: 1 }, { x: error }); return box.x; }`,
    selects: true,
  },
  {
    id: 'three-sources-middle-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { x: error }, { x: 1 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'one-literal-repeats-key-error-last',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: 0, x: error }); return box.x; }`,
    selects: true,
  },
  {
    id: 'one-literal-repeats-key-error-first',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: error, x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'later-source-computed-key',
    source: `function frames(error: Error, key: string) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { [key]: error }); return box.x; }`,
    selects: true,
  },
  {
    id: 'later-source-computed-key-after-literal',
    source: `function frames(error: Error, key: string) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { [key]: error }, { y: 1 }); return box.x; }`,
    selects: true,
  },
  {
    id: 'earlier-source-computed-key',
    source: `function frames(error: Error, key: string) { const box = { x: 0 }; Object.assign(box, { [key]: error }, { x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'initial-error-replaced',
    source: `function frames(error: Error) { const box = { x: error }; Object.assign(box, { x: 0 }, { x: 1 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'other-key-keeps-initial',
    source: `function frames(error: Error) { const box = { x: error }; Object.assign(box, { y: 0 }, { y: 1 }); return box.x; }`,
    selects: true,
  },
  {
    id: 'earlier-statement-then-call',
    source: `function frames(error: Error) { const box = { x: 0 }; box.x = error; Object.assign(box, { x: 0 }, { x: 1 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'call-then-later-statement',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: 0 }, { x: error }); box.x = 1; return box.x; }`,
    selects: false,
  },
  {
    id: 'single-source-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: error }); return box.x; }`,
    selects: true,
  },
  {
    id: 'single-source-replaces-error',
    source: `function frames(error: Error) { const box = { x: error }; Object.assign(box, { x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'trailing-spread-reopens-explicit-entry',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0, ...extra }); return box.x; }`,
    selects: true,
  },
  {
    id: 'leading-spread-explicit-entry-wins',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: 0 }; Object.assign(box, { x: error }, { ...extra, x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'unread-source-after-explicit-entry',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0 }, extra); return box.x; }`,
    selects: true,
  },
  {
    id: 'unread-source-before-explicit-entry',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, extra, { x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'unread-source-keeps-initial',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, { x: 0 }, extra); return box.x; }`,
    selects: true,
  },
  {
    id: 'unread-source-other-name',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, { y: 0 }, extra); return box.x; }`,
    selects: true,
  },
  {
    id: 'call-result-source-after-explicit-entry',
    source: `function frames(error: Error, extra: () => { x: unknown }) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0 }, extra()); return box.x; }`,
    selects: true,
  },
  {
    id: 'accessor-entry-after-explicit-entry',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0, set y(value: number) {} }); return box.x; }`,
    selects: true,
  },
  {
    id: 'one-source-spread-after-explicit-entry',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, { x: 0, ...extra }); return box.x; }`,
    selects: true,
  },
  {
    id: 'one-source-spread-before-explicit-entry',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, { ...extra, x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'unread-source-in-a-later-call',
    source: `function frames(error: Error, extra: { x: unknown }) { const box = { x: error }; Object.assign(box, { x: 0 }); Object.assign(box, extra); return box.x; }`,
    selects: false,
  },
  {
    id: 'source-alias-of-literal',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, overrides); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-alias-chain',
    source: `function frames(error: Error) { const box = { x: 0 }; const first = { x: error }; const overrides = first; Object.assign(box, overrides); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-alias-asserted',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error } as { x: unknown }; Object.assign(box, overrides); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-of-literal',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { ...{ x: error } }); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-of-alias',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, { ...overrides }); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-between-entries',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, { y: 1, ...overrides, z: 2 }); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-of-spread',
    source: `function frames(error: Error) { const box = { x: 0 }; const inner = { x: error }; const outer = { ...inner }; Object.assign(box, outer); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-alias-after-explicit-source',
    source: `function frames(error: Error) { const box = { x: 0 }; const second = { x: error }; Object.assign(box, { x: 0 }, second); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-after-explicit-entry',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, { x: 0, ...overrides }); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-before-explicit-entry',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, { ...overrides, x: 0 }); return box.x; }`,
    selects: false,
  },
  {
    id: 'source-spread-twice',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { x: error }; Object.assign(box, { ...overrides, x: 0, ...overrides }); return box.x; }`,
    selects: true,
  },
  {
    id: 'source-spread-of-itself',
    source: `function frames(error: Error) { const box = { x: 0 }; const loop: { x: unknown } = { x: error, ...loop }; Object.assign(box, loop); return box.x; }`,
    selects: true,
  },
  {
    id: 'readable-source-replaces-error',
    source: `function frames(error: Error) { const box = { x: 0 }; const first = { x: error }; const second = { x: 0 }; Object.assign(box, first, second); return box.x; }`,
    selects: false,
  },
  {
    id: 'readable-spread-replaces-error',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0, ...{ y: 1 } }); return box.x; }`,
    selects: false,
  },
  {
    id: 'readable-source-replaces-initial-error',
    source: `function frames(error: Error) { const box = { x: error }; const overrides = { x: 0 }; Object.assign(box, overrides); return box.x; }`,
    selects: false,
  },
  {
    id: 'source-alias-other-name',
    source: `function frames(error: Error) { const box = { x: 0 }; const overrides = { y: error }; Object.assign(box, overrides); return box.x; }`,
    selects: false,
  },
  {
    id: 'source-variable-is-not-read',
    source: `function frames(error: Error) { const box = { x: 0 }; let overrides = { x: error }; Object.assign(box, overrides); return box.x; }`,
    selects: false,
  },
  {
    id: 'argument-spread-after-explicit-sources',
    source: `function frames(error: Error, sources: { x: unknown }[]) { const box = { x: 0 }; Object.assign(box, { x: error }, { x: 0 }, ...sources); return box.x; }`,
    selects: true,
  },
  {
    id: 'argument-spread-after-one-explicit-source',
    source: `function frames(error: Error, sources: { x: unknown }[]) { const box = { x: error }; Object.assign(box, { x: 0 }, ...sources); return box.x; }`,
    selects: true,
  },
  {
    id: 'argument-spread-of-a-written-list',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, ...[{ x: error }, { x: 0 }]); return box.x; }`,
    selects: false,
  },
  {
    id: 'argument-spread-of-a-written-list-error-last',
    source: `function frames(error: Error) { const box = { x: 0 }; Object.assign(box, ...[{ x: 0 }, { x: error }]); return box.x; }`,
    selects: true,
  },
  {
    id: 'argument-spread-in-a-later-call',
    source: `function frames(error: Error, sources: { x: unknown }[]) { const box = { x: error }; Object.assign(box, { x: 0 }); Object.assign(box, ...sources); return box.x; }`,
    selects: false,
  },
] as const;

describe('what the sources of one Object.assign leave in a member', () => {
  it.each(CASES)('$id', ({ source, selects }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'held-assign-sources.ts', source);

    expect(readSelectsError(parsed.sourceFile)).toBe(selects);
  });
});

/** Whether the member the last `return` reads may be the `error` parameter, as the walks follow it. */
function readSelectsError(root: Node): boolean {
  const pending = [root];
  let read: Expression | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined) read = node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (read === undefined) throw new Error('the source has no return');
  return framedHeldMember(read, [], isErrorAt);
}

/** The `error` parameter, selected from a literal by its keys or from a variable that holds it. */
function isErrorAt(value: Expression, keys: readonly string[]): boolean {
  const each = unwrapped(value);
  const [key, ...rest] = keys;
  if (key === undefined) return isIdentifier(each) && each.text === 'error';
  if (isIdentifier(each)) return framedHeldMember(each, keys, isErrorAt);
  if (!isObjectLiteralExpression(each)) return false;
  return each.properties.some((property) => {
    return (
      isPropertyAssignment(property) &&
      writtenArrayKey(property.name) === key &&
      isErrorAt(property.initializer, rest)
    );
  });
}
