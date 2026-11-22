import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whole-record replacements of a saved parameter or header record contribute the fields of their
 * spreads and unread computed keys, and a variable that may hold another object no longer overwrites
 * earlier fields when spread into an outer literal.
 */
const CASES = [
  {
    id: 'replacement-literal-spread',
    body: 'let params: Record<string, string> = {}; params = { ...{ x: error as never } }; return new URLSearchParams(params);',
    converts: true,
  },
  {
    id: 'headers-replacement-literal-spread',
    body: 'let headers: Record<string, string> = {}; headers = { ...{ x: error as never } }; return new Headers(headers);',
    converts: true,
  },
  {
    id: 'replacement-saved-record-spread',
    body: "const extra = { y: error as never }; let params: Record<string, string> = { x: 'ok' }; params = { x: 'ok', ...extra }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'replacement-computed-key',
    body: 'let params: Record<string, string> = {}; params = { [key]: error as never }; return new URLSearchParams(params);',
    converts: true,
  },
  {
    id: 'conditional-replacement-spread',
    body: "let params: Record<string, string> = { x: 'ok' }; params = flag ? { ...{ y: error as never } } : { x: 'still-ok' }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'branch-empty-replacement-keeps-outer-spread-field',
    body: "let params: Record<string, string> = { x: 'fixed' }; if (flag) params = {}; return new URLSearchParams({ x: error as never, ...params });",
    converts: true,
  },
  {
    id: 'replacement-spread-overwrites-initial-error',
    body: "let params = { x: error as never }; params = { ...{ x: 'fixed' as never } }; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'replacement-spread-later-field-overwrites-spread-error',
    body: "let params: Record<string, string> = {}; params = { ...{ x: error as never }, x: 'fixed' as never }; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'replacement-plain-data-spread',
    body: "let params: Record<string, string> = {}; params = { ...{ x: 'fixed' } }; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'member-overwrite-still-replaces-outer-spread-field',
    body: "const original: Record<string, string> = { x: error as never }; original.x = 'fixed' as never; return new URLSearchParams({ x: error as never, ...original });",
    converts: false,
  },
] as const;

describe('whole-record replacement spreads and unknown keys', () => {
  it.each(CASES)('$id', ({ body, converts }) => {
    expect(convertsSuppliedError(body)).toBe(converts);
  });
});

function convertsSuppliedError(body: string): boolean {
  using api = openTypeScript();
  const source = `function frames(error: Error, key: string, flag: boolean) { ${body} }`;
  using parsed = parseModule(api, 'record-replacement-spreads.ts', source);
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
