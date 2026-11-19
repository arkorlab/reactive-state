import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Type assertions, mutated local objects, destructured formal parameters, prefix arguments before
 * unknown spreads, parameter-initializer writes, helper-parameter array writes, and spread
 * container offsets must retain `Proxy` origins without false positives on ordinary values.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'angle-bracket-type-assertion-direct-export',
    source: 'export const result = <object>new Proxy({}, {});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'angle-bracket-nested-assertion-in-helper',
    source:
      'function make() { const raw = <Record<string, unknown>>new Proxy({}, {}); return <object>raw; } export const result = make();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'angle-bracket-revocable-proxy-member',
    source: 'export const result = (<{ proxy: object }>Proxy.revocable({}, {})).proxy;',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-sibling-write-preserves-initial-proxy',
    source:
      'export function make() { const result = { p: new Proxy({}, {}), extra: 0 }; result.extra = 1; return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-empty-object-property-assigned-proxy',
    source:
      'export function make() { const result: Record<string, unknown> = {}; result.p = new Proxy({}, {}); return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-selected-member-reads-assigned-proxy',
    source:
      'export function make() { const result: Record<string, unknown> = {}; result.p = new Proxy({}, {}); return result.p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-nested-property-assigned-proxy',
    source:
      'export function make() { const result = { nested: { p: 0 as unknown } }; result.nested.p = new Proxy({}, {}); return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-object-assign-copies-proxy',
    source:
      'export function make() { const result: Record<string, unknown> = {}; Object.assign(result, { p: new Proxy({}, {}) }); return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-reflect-set-writes-proxy',
    source:
      "export function make() { const result: Record<string, unknown> = {}; Reflect.set(result, 'p', new Proxy({}, {})); return result.p; }",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-object-helper-parameter-writes-proxy',
    source:
      'function attach(target: Record<string, unknown>) { target.p = new Proxy({}, {}); } export function make() { const result: Record<string, unknown> = {}; attach(result); return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-object-parameter-forwards-argument-proxy',
    source:
      'function unwrap({ value }: { value: unknown }) { return value; } export const result = unwrap({ value: new Proxy({}, {}) });',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-object-parameter-default-proxy-on-exported-fn',
    source:
      'export function make({ value = new Proxy({}, {}) }: { value?: unknown } = {}) { return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-object-parameter-outer-default-proxy',
    source:
      'function unwrap({ value }: { value: unknown } = { value: new Proxy({}, {}) }) { return value; } export const result = unwrap();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-array-parameter-forwards-argument-proxy',
    source:
      'function head([first]: [unknown]) { return first; } export const result = head([new Proxy({}, {})]);',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-nested-pattern-default-proxy',
    source:
      'function take({ nested: [item = new Proxy({}, {})] = [] }: { nested?: unknown[] }) { return item; } export const result = take({});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-object-rest-retains-unexcluded-proxy',
    source:
      'function restOf({ safe, ...rest }: { safe: number; p: unknown }) { void safe; return rest; } export const result = restOf({ safe: 1, p: new Proxy({}, {}) });',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'known-prefix-argument-before-unknown-spread',
    source:
      'function first(value: unknown, ...extra: unknown[]) { void extra; return value; } export function run(args: unknown[]) { return first(new Proxy({}, {}), ...args); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'known-second-argument-after-tuple-before-unknown-spread',
    source:
      "function second(_a: unknown, value: unknown, ...extra: unknown[]) { void extra; return value; } export function run(args: unknown[]) { return second(...['a'], new Proxy({}, {}), ...args); }",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'rest-parameter-retains-known-prefix-before-unknown-spread',
    source:
      "function tail(_a: unknown, ...extra: unknown[]) { return extra[0]; } export function run(args: unknown[]) { return tail('a', new Proxy({}, {}), ...args); }",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'later-parameter-default-reassigns-earlier-parameter',
    source:
      'function take(value: unknown, ignored: unknown = (value = new Proxy({}, {}))) { void ignored; return value; } export const result = take({});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-parameter-default-reassigns-earlier-parameter',
    source:
      'function take(value: unknown, { a = (value = new Proxy({}, {})) }: { a?: unknown } = {}) { void a; return value; } export const result = take({});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'later-parameter-default-clears-definedness-for-forwarded-default',
    source:
      'function wrap(v: unknown = new Proxy({}, {})) { return v; } function relay(v: unknown, _reset: unknown = (v = undefined)) { void _reset; return wrap(v); } export const result = relay({ ok: 1 });',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'helper-parameter-push-into-local-array',
    source:
      'function append(target: unknown[]) { target.push(new Proxy({}, {})); } const items: unknown[] = []; append(items); export const result = items[0];',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'helper-parameter-forwards-argument-into-array',
    source:
      'function insert(target: unknown[], item: unknown) { target.push(item); } const items: unknown[] = []; insert(items, new Proxy({}, {})); export const result = items[0];',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'nested-helper-chain-mutates-escaped-array',
    source:
      'function step2(list: unknown[]) { list[0] = new Proxy({}, {}); } function step1(list: unknown[]) { step2(list); } export function make() { const items: unknown[] = []; step1(items); return items[0]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'empty-spread-offset-in-array-container-push',
    source:
      'const items: unknown[] = []; const box = [...[], items]; box[0].push(new Proxy({}, {})); export const result = items[0];',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'const-tuple-spread-offset-in-array-container-push',
    source:
      'const items: unknown[] = []; const prefix = [1, 2] as const; const box = [...prefix, items] as const; box[2].push(new Proxy({}, {})); export const result = items[0];',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'unknown-spread-in-array-container-conservatively-retains-push',
    source:
      'export function make(prefix: unknown[][]) { const items: unknown[] = []; const box = [...prefix, items]; box[0].push(new Proxy({}, {})); return items[0]; }',
  },
  {
    expected: undefined,
    id: 'angle-bracket-plain-object-pin',
    source: 'export const result = <{ ok: number }>{ ok: 1 };',
  },
  {
    expected: undefined,
    id: 'mutated-object-unconditional-destructuring-overwrite-pin',
    source:
      'export function make() { const holder = { value: new Proxy({}, {}) as unknown }; [holder.value] = [{ ok: 1 }]; return holder.value; }',
  },
  {
    expected: undefined,
    id: 'mutated-plain-object-stays-settled-pin',
    source:
      'export function make() { const result: Record<string, number> = { a: 1 }; result.b = 2; return result; }',
  },
  {
    expected: undefined,
    id: 'destructured-object-parameter-plain-argument-bypasses-default-pin',
    source:
      'function unwrap({ value = new Proxy({}, {}) }: { value?: unknown }) { return value; } export const result = unwrap({ value: { ok: 1 } });',
  },
  {
    expected: undefined,
    id: 'destructured-object-rest-excludes-named-proxy-sibling-pin',
    source:
      'function restOf({ dropped, ...rest }: { dropped: unknown; ok: number }) { void dropped; return rest; } export const result = restOf({ dropped: new Proxy({}, {}), ok: 1 });',
  },
  {
    expected: undefined,
    id: 'known-defined-prefix-before-unknown-spread-bypasses-default',
    source:
      'function first(value: unknown = new Proxy({}, {}), ...extra: unknown[]) { void extra; return value; } export function run(args: unknown[]) { return first({ ok: 1 }, ...args); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'position-covered-by-unknown-spread-keeps-default-pin',
    source:
      "function second(_a: unknown, value: unknown = new Proxy({}, {})) { return value; } export function run(args: unknown[]) { return second('a', ...args); }",
  },
  {
    expected: undefined,
    id: 'supplied-defined-argument-skips-later-initializer-write-pin',
    source:
      "function take(value: unknown, ignored: unknown = (value = new Proxy({}, {}))) { void ignored; return value; } export const result = take({ ok: 1 }, 'supplied');",
  },
  {
    expected: undefined,
    id: 'spread-container-write-to-other-slot-leaves-sibling-settled-pin',
    source:
      'const left: unknown[] = []; const right: unknown[] = []; const box = [...[], left, right] as const; box[0].push(new Proxy({}, {})); export const result = right[0];',
  },
] as const;

describe('proxy origins across type assertions, mutated objects, destructured parameters, and spreads', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module exercising proxy object, parameter, and spread cases. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-objects-and-parameters.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
