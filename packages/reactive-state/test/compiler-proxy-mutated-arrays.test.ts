import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Mutating an array or letting it escape into a container invalidates exact slot projections and
 * object-spread index exclusions while keeping every initial and inserted element origin live.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'sibling-index-write-preserves-indexed-proxy',
    source:
      'export function make() { const items = [new Proxy({}, {}), 0]; items[1] = 1; return items[0]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'push-before-indexed-read-preserves-initial-proxy',
    source:
      'export function make() { const items: unknown[] = [new Proxy({}, {})]; items.push(1); return items[0]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'unshift-shifts-initial-proxy-into-later-index',
    source:
      'export function make() { const items: unknown[] = [new Proxy({}, {})]; items.unshift(1); return items[1]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'pushed-proxy-detected-at-mutated-index',
    source:
      'export function make() { const items: unknown[] = [0]; items.push(new Proxy({}, {})); return items[1]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'assigned-element-proxy-detected-on-indexed-read',
    source:
      'export function make() { const items: unknown[] = [0, 1]; items[1] = new Proxy({}, {}); return items[1]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'spliced-proxy-detected-on-indexed-read',
    source:
      'export function make() { const items: unknown[] = [0]; items.splice(0, 1, new Proxy({}, {})); return items[0]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'nested-member-projection-on-mutated-array-element',
    source:
      'export function make() { const items = [{ p: new Proxy({}, {}) }]; items.push({ p: 1 }); return items[0].p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'dynamic-index-read-on-mutated-array-retains-proxy',
    source:
      'export function make(i: number) { const items: unknown[] = [new Proxy({}, {})]; items.push(1); return items[i]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-rest-parameter-indexed-read-retains-proxy',
    source:
      'function pick(...items: unknown[]) { items.push(1); return items[0]; } export const result = pick(new Proxy({}, {}));',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-container-escape-shifts-array-before-object-spread',
    source:
      'export function make() { const items: unknown[] = [new Proxy({}, {})]; const box = { items }; box.items.unshift(1); return { ...items, 0: 1 }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'array-container-escape-shifts-rest-array-before-object-spread',
    source:
      'function pack(...items: unknown[]) { const outer = [items]; outer[0].unshift(1); return { ...items, 0: 1 }; } export const result = pack(new Proxy({}, {}));',
  },
  {
    expected: undefined,
    id: 'unmutated-other-index-read-ignores-sibling-proxy-pin',
    source: 'export function make() { const items = [new Proxy({}, {}), 0]; return items[1]; }',
  },
  {
    expected: undefined,
    id: 'mutated-plain-array-indexed-read-stays-settled-pin',
    source: 'export function make() { const items = [1, 2]; items.push(3); return items[0]; }',
  },
  {
    expected: undefined,
    id: 'mutated-array-safe-sibling-member-stays-settled-pin',
    source:
      'export function make() { const items = [{ p: new Proxy({}, {}), ok: 1 }]; items.push({ p: 2, ok: 2 }); return items[0].ok; }',
  },
  {
    expected: undefined,
    id: 'mutated-array-length-read-stays-settled-pin',
    source:
      'export function make() { const items: unknown[] = [new Proxy({}, {})]; items.push(1); return items.length; }',
  },
  {
    expected: undefined,
    id: 'passive-length-read-keeps-object-spread-index-overwrite-pin',
    source:
      'export function make() { const items = [new Proxy({}, {})]; const count = items.length; return { ...items, 0: count }; }',
  },
] as const;

describe('proxy origin detection across mutated and container-escaped arrays', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module indexing or spreading mutated and escaped arrays. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-mutated-arrays.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
