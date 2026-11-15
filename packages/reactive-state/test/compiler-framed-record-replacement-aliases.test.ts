import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whole-record replacements that assign a source-known record alias preserve its named, spread and
 * unread-key fields, whether the alias is unchanged, mutated through the shared reference, or
 * captured before its variable is reassigned.
 */
const CASES = [
  {
    id: 'constant-record-alias-same-key',
    body: "const replacement = { x: error as never }; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'headers-constant-record-alias',
    body: "const replacement = { x: error as never }; let headers = { x: 'ok' as never }; headers = replacement; return new Headers(headers);",
    converts: true,
  },
  {
    id: 'constant-record-alias-new-key',
    body: "const replacement = { y: error as never }; let params: Record<string, string> = { x: 'ok' }; params = replacement; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'chained-constant-record-alias',
    body: "const origin = { x: error as never }; const replacement = origin; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'constant-record-alias-spread-and-computed',
    body: "const replacement: Record<string, string> = { ...{ x: 'ok' }, [key]: error as never }; let params: Record<string, string> = {}; params = replacement; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'mutated-record-alias-before-replacement',
    body: "const replacement = { x: 'ok' as never }; replacement.x = error as never; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'mutated-record-alias-after-replacement',
    body: "const replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = error as never; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'reassigned-record-alias-captured-before-overwrite',
    body: "let replacement = { x: error as never }; let params = { x: 'ok' as never }; params = replacement; replacement = { x: 'ok' as never }; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'cyclic-record-alias-assignments',
    body: 'let other: Record<string, string> = { x: error as never }; let params: Record<string, string> = {}; params = other; other = params; return new URLSearchParams(params);',
    converts: true,
  },
  {
    id: 'constant-record-alias-overwrites-initial-error',
    body: "const replacement = { x: 'fixed' as never }; let params = { x: error as never }; params = replacement; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'mutated-record-alias-overwrites-own-error-before-replacement',
    body: "const replacement = { x: error as never }; replacement.x = 'fixed' as never; let params = { x: 'ok' as never }; params = replacement; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'plain-constant-record-alias',
    body: "const replacement = { x: 'fixed' }; let params: Record<string, string> = {}; params = replacement; return new URLSearchParams(params);",
    converts: false,
  },
] as const;

describe('whole-record replacement aliases', () => {
  it.each(CASES)('$id', ({ body, converts }) => {
    expect(convertsSuppliedError(body)).toBe(converts);
  });
});

function convertsSuppliedError(body: string): boolean {
  using api = openTypeScript();
  const source = `function frames(error: Error, key: string) { ${body} }`;
  using parsed = parseModule(api, 'record-replacement-aliases.ts', source);
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
