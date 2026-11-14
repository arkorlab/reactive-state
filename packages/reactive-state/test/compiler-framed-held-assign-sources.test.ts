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
  {
    id: 'changed-source-member-written-before',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; source.x = error; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-spread-member-written-before',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; source.x = error; Object.assign(box, { ...source }); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-written-in-a-later-argument',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, source, { y: (source.x = error) }); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-written-after-the-call',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, source); source.x = error; return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-written-through-an-alias',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const alias = source; alias.x = error; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-written-in-a-function',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const run = () => { source.x = error; }; run(); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-written-in-a-loop',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; for (let turn = 0; turn < 2; turn += 1) { Object.assign(box, source); if (turn > 0) { return box.x; } source.x = error; } return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-handed-to-a-call',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; touch(source); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-method-called',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; source.update(); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-member-deleted',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; delete source.x; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-member-compound-assigned',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; source.x += 'a'; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-pattern-written',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; [source.x] = [error]; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-object-pattern-written',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; ({ a: source.x } = { a: error }); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-loop-head-written',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; for (source.x of [error]) { /* written */ } Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-named-by-a-variable',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; let other = source; other.x = error; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-assign-target',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(source, { x: error }); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-defined-on',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.defineProperty(source, "x", { value: error }); Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-returned',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const again = () => source; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-in-an-array',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const all = [source]; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-in-a-literal',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const wrap = { source }; Object.assign(box, source); return box.x; }`,
    selects: true,
  },
  {
    id: 'changed-source-after-explicit-entry',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, { x: 0 }, source); touch(source); return box.x; }`,
    selects: true,
  },
  {
    id: 'read-source-member',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const seen = source.x; Object.assign(box, source); return box.x; }`,
    selects: false,
  },
  {
    id: 'read-source-copied-twice',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, source); const other = { y: 1 }; Object.assign(other, source); return box.x; }`,
    selects: false,
  },
  {
    id: 'read-source-spread',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, { ...source }); return box.x; }`,
    selects: false,
  },
  {
    id: 'read-source-through-constant-alias',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; const alias = source; Object.assign(box, alias); return box.x; }`,
    selects: false,
  },
  {
    id: 'read-source-after-explicit-entry',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: error }; const source = { x: 0 } as { x: unknown; update(): void }; Object.assign(box, { x: error }, source); return box.x; }`,
    selects: false,
  },
  {
    id: 'changed-source-keeps-its-literal-error',
    source: `function frames(error: Error, touch: (value: { x: unknown }) => void) { const box = { x: 0 }; const source = { x: error } as { x: unknown }; touch(source); Object.assign(box, source); return box.x; }`,
    selects: true,
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
