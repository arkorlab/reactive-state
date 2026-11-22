import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const BUDGET = { functions: 1500, maxElapsedMs: 2500, timeoutMs: 60_000 } as const;

/** Source of `count` small exported functions, each written from `body` with `$i` its number. */
function functions(count: number, body: string): string {
  return Array.from({ length: count }, (_, at) => body.replaceAll('$i', () => String(at))).join(
    '\n',
  );
}

const CASES = [
  {
    expected: undefined,
    id: 'var-member-write-of-another-function-is-not-this-ones',
    source:
      'export function own() { var box: Record<string, unknown> = {}; box.n = 1; return box; } function other() { var box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; } void other;',
  },
  {
    expected: undefined,
    id: 'var-assignment-of-another-function-is-not-this-ones',
    source:
      'export function own() { var p: object = {}; return p; } function other() { var p: object = {}; p = new Proxy({}, {}); return p; } void other;',
  },
  {
    expected: undefined,
    id: 'var-push-of-another-function-is-not-this-ones',
    source:
      'export function own() { var items: unknown[] = []; items.push(1); return items; } function other() { var items: unknown[] = []; items.push(new Proxy({}, {})); return items; } void other;',
  },
  {
    expected: undefined,
    id: 'let-member-write-of-another-function-pin',
    source:
      'export function own() { let box: Record<string, unknown> = {}; box.n = 1; return box; } function other() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; } void other;',
  },
  {
    expected: undefined,
    id: 'module-let-write-is-not-a-local-lets',
    source:
      'let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); export function own() { let box: Record<string, unknown> = {}; box.n = 1; return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'var-write-of-its-own-function-pin',
    source:
      'export function own() { var box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'var-write-in-a-closure-of-its-own-function-pin',
    source:
      'export function own() { var box: Record<string, unknown> = {}; (function () { box.p = new Proxy({}, {}); })(); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-write-of-its-own-function-pin',
    source:
      'export function own() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'module-let-written-in-another-function-pin',
    source:
      'let box: Record<string, unknown> = {}; function fill() { box.p = new Proxy({}, {}); } export function read() { fill(); return box; }',
  },
  {
    expected: undefined,
    id: 'many-functions-each-returning-a-local-let',
    source: functions(BUDGET.functions, 'export function f$i() { let x = { a: $i }; return x; }'),
  },
  {
    expected: undefined,
    id: 'many-functions-each-writing-a-member-of-a-local-var',
    source: functions(
      BUDGET.functions,
      'export function f$i() { var box: Record<string, unknown> = {}; box.p = $i; return box; }',
    ),
  },
] as const;

describe('writes into a mutable binding are indexed once for the file, by what declares it', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module, with the time it took. */
  function refusalIn(source: string): { readonly elapsedMs: number; readonly text?: string } {
    using parsed = parseModule(api, 'proxy-mutable-write-index.ts', source);
    const started = performance.now();
    const text = unsettledIn(parsed.sourceFile);
    const elapsedMs = performance.now() - started;

    return text === undefined ? { elapsedMs } : { elapsedMs, text };
  }

  it.each(CASES)('$id', { timeout: BUDGET.timeoutMs }, ({ expected, source }) => {
    const answer = refusalIn(source);

    expect(answer.text).toBe(expected);
    expect(answer.elapsedMs).toBeLessThan(BUDGET.maxElapsedMs);
  });
});
