import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const REQUEST_URL_REFUSAL =
  "makes `Request` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses";

const LIMITS = { maxElapsedMs: 2000 } as const;

const CASES = [
  {
    expected: undefined,
    id: 'linked-list-walk-then-method-call',
    source:
      'export function readLast(first: any) { let current = first; while (current.next) current = current.next; return current.read(); }',
  },
  {
    expected: undefined,
    id: 'linked-list-walk-then-construct',
    source:
      "export function readLast(first: any) { let current = first; while (current.next) current = current.next; return new current.Reader('x'); }",
  },
  {
    expected: undefined,
    id: 'parent-chain-walk-do-while',
    source:
      'export function root(node: any) { let at = node; do { at = at.parent; } while (at.parent); return at.name(); }',
  },
  {
    expected: undefined,
    id: 'tree-descent-two-branches',
    source:
      'export function leaf(tree: any, left: boolean) { let at = tree; while (at.kids) { at = left ? at.left : at.right; } return at.value(); }',
  },
  {
    expected: undefined,
    id: 'tree-descent-logical-branches',
    source:
      'export function leaf(tree: any) { let at = tree; while (at.kids) { at = at.left || at.right || at.up; } return at.value(); }',
  },
  {
    expected: undefined,
    id: 'two-cursors-follow-each-other',
    source:
      'export function meet(a: any, b: any) { let x = a; let y = b; while (x !== y) { x = y.next; y = x.next; } return x.read(); }',
  },
  {
    expected: undefined,
    id: 'cursor-on-element-access-chain',
    source:
      "export function walk(first: any) { let current = first; while (current['next']) current = current['next']; return current.read(); }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'constructor-alias-that-also-loops-is-still-request-pin',
    source:
      "export function make(more: boolean) { let Ctor: any = Request; while (more) { Ctor = Ctor.next; } return new Ctor('/api'); }",
  },
] as const;

describe('global alias queries over a binding assigned from its own member', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on `source`, returning the refusal and the time it took. */
  function refusalIn(source: string): { readonly elapsedMs: number; readonly text?: string } {
    using parsed = parseModule(api, 'global-alias-cycles.ts', source);
    const started = performance.now();
    const text = unsettledIn(parsed.sourceFile);
    const elapsedMs = performance.now() - started;
    return text === undefined ? { elapsedMs } : { elapsedMs, text };
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    const answer = refusalIn(source);

    expect(answer.text).toBe(expected);
    expect(answer.elapsedMs).toBeLessThan(LIMITS.maxElapsedMs);
  });
});
