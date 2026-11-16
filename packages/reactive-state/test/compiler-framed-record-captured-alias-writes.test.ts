import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whole-record replacements that capture a record alias retain member writes made through that
 * shared object reference before the consumer read, even when the source variable is later
 * reassigned to another object.
 */
const CASES = [
  {
    id: 'captured-alias-field-write-before-source-reassignment',
    body: "let replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = error as never; replacement = { x: 'fixed' as never }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'headers-captured-alias-field-write-before-source-reassignment',
    body: "let replacement = { x: 'ok' as never }; let headers = { x: 'ok' as never }; headers = replacement; replacement.x = error as never; replacement = { x: 'fixed' as never }; return new Headers(headers);",
    converts: true,
  },
  {
    id: 'captured-alias-new-field-write-before-source-reassignment',
    body: "let replacement: Record<string, string> = { x: 'ok' }; let params: Record<string, string> = { x: 'ok' }; params = replacement; replacement.y = error as never; replacement = { x: 'fixed' }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'captured-alias-object-assign-before-source-reassignment',
    body: "let replacement: Record<string, string> = { x: 'ok' }; let params: Record<string, string> = { x: 'ok' }; params = replacement; Object.assign(replacement, { x: error as never }); replacement = { x: 'fixed' }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'captured-alias-define-property-before-source-reassignment',
    body: "let replacement: Record<string, string> = { x: 'ok' }; let params: Record<string, string> = { x: 'ok' }; params = replacement; Object.defineProperty(replacement, 'x', { value: error as never }); replacement = { x: 'fixed' }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'captured-alias-chained-field-write-before-source-reassignment',
    body: "let origin = { x: 'ok' as never }; let middle = { x: 'ok' as never }; let params = { x: 'ok' as never }; middle = origin; params = middle; origin.x = error as never; origin = { x: 'fixed' as never }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'captured-alias-spread-consumer-before-source-reassignment',
    body: "let replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = error as never; replacement = { x: 'fixed' as never }; return new URLSearchParams({ ...params });",
    converts: true,
  },
  {
    id: 'captured-alias-loop-consumer-before-source-reassignment',
    body: "let replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; for (const pass of [1, 2]) { if (pass === 2) return new URLSearchParams(params); replacement.x = error as never; replacement = { x: 'fixed' as never }; } return null;",
    converts: true,
  },
  {
    id: 'pre-capture-reassignment-overwrites-earlier-write-pin',
    body: "let replacement = { x: 'ok' as never }; replacement.x = error as never; replacement = { x: 'fixed' as never }; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'pre-capture-member-overwrite-replaces-earlier-write-pin',
    body: "const replacement = { x: 'ok' as never }; replacement.x = error as never; replacement.x = 'fixed' as never; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'post-consumer-alias-write-ignored-pin',
    body: "let replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; const text = new URLSearchParams(params).toString(); replacement.x = error as never; replacement = { x: 'fixed' as never }; return text;",
    converts: false,
  },
  {
    id: 'captured-alias-plain-write-before-reassignment-pin',
    body: "let replacement = { x: 'ok' }; let params = { x: 'ok' }; params = replacement; replacement.x = 'still-ok'; replacement = { x: 'fixed' }; return new URLSearchParams(params);",
    converts: false,
  },
] as const;

describe('captured record alias writes across reassignment', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, converts }) => {
    expect(convertsSuppliedError(api, body)).toBe(converts);
  });
});

function convertsSuppliedError(api: API, body: string): boolean {
  const source = `function frames(error: Error, key: string) { ${body} }`;
  using parsed = parseModule(api, 'record-captured-alias-writes.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isNewExpression(node) &&
      framedSearchParamsText(node, {
        error: (value) => {
          const unwrappedValue = unwrapped(value);
          return isIdentifier(unwrappedValue) && unwrappedValue.text === 'error';
        },
        typed: () => false,
      })
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
