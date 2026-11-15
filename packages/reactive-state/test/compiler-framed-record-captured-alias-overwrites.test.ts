import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { type API, openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Definite post-capture field writes on an unreassigned captured record alias replace earlier
 * values of that field for that captured alias without clearing unrelated target branches or
 * writes made after the alias variable itself was reassigned.
 */
const CASES = [
  {
    id: 'post-capture-error-overwritten-by-later-write',
    body: "const replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = error as never; replacement.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'initial-error-overwritten-after-capture',
    body: "const source = { x: error as never }; let params = { x: 'ok' as never }; params = source; source.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'headers-initial-error-overwritten-after-capture',
    body: "const source = { x: error as never }; let headers = { x: 'ok' as never }; headers = source; source.x = 'fixed' as never; return new Headers(headers);",
    converts: false,
  },
  {
    id: 'bracket-overwrite-after-capture',
    body: "const source = { x: error as never }; let params = { x: 'ok' as never }; params = source; source['x'] = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'object-assign-overwrite-after-capture',
    body: "const source: Record<string, string> = { x: error as never }; let params: Record<string, string> = { x: 'ok' }; params = source; Object.assign(source, { x: 'fixed' }); return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'define-property-overwrite-after-capture',
    body: "const source: Record<string, string> = { x: error as never }; let params: Record<string, string> = { x: 'ok' }; params = source; Object.defineProperty(source, 'x', { value: 'fixed' }); return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'new-key-error-overwritten-after-capture',
    body: "const replacement: Record<string, string> = { x: 'ok' }; let params: Record<string, string> = { x: 'ok' }; params = replacement; replacement.y = error as never; replacement.y = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'pre-capture-new-key-error-overwritten-after-capture',
    body: "const source: Record<string, string> = {}; source.x = error as never; let params: Record<string, string> = {}; params = source; source.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'overwrite-before-later-source-reassignment',
    body: "let replacement = { x: error as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = 'fixed' as never; replacement = { x: 'later' as never }; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'chained-constant-alias-overwrite-after-capture',
    body: "const origin = { x: error as never }; const alias = origin; let params = { x: 'ok' as never }; params = alias; origin.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: false,
  },
  {
    id: 'spread-consumer-after-post-capture-overwrite',
    body: "const source = { x: error as never }; let params = { x: 'ok' as never }; params = source; source.x = 'fixed' as never; return new URLSearchParams({ ...params });",
    converts: false,
  },
  {
    id: 'conditional-capture-keeps-unreplaced-target-branch-pin',
    body: "const replacement = { x: 'ok' as never }; let params = { x: error as never }; if (flag) { params = replacement; } replacement.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'source-reassigned-before-field-write-keeps-captured-error-pin',
    body: "let replacement = { x: error as never }; let params = { x: 'ok' as never }; params = replacement; replacement = { x: 'other' as never }; replacement.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'conditional-post-capture-write-keeps-error-pin',
    body: "const replacement = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = replacement; replacement.x = error as never; if (flag) { replacement.x = 'fixed' as never; } return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'later-conditional-error-after-overwrite-kept-pin',
    body: "const source = { x: 'ok' as never }; let params = { x: 'ok' as never }; params = source; source.x = 'fixed' as never; if (flag) { source.x = error as never; } return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'logical-or-assignment-does-not-overwrite-error-pin',
    body: "const source = { x: error as never }; let params = { x: 'ok' as never }; params = source; source.x ||= 'fixed' as never; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'setter-accessor-leaves-getter-error-pin',
    body: "const source = { get x() { return error as never; }, set x(_value: never) {} }; let params = { x: 'ok' as never }; params = source as never; source.x = 'fixed' as never; return new URLSearchParams(params);",
    converts: true,
  },
  {
    id: 'spread-snapshot-before-later-overwrite-keeps-error-pin',
    body: "const source = { x: error as never }; let params = { x: 'ok' as never }; params = source; const snapshot = { ...params }; source.x = 'fixed' as never; return new URLSearchParams(snapshot);",
    converts: true,
  },
] as const;

describe('definite post-capture field overwrites on record aliases', () => {
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
  const source = `function frames(error: Error, flag: boolean) { ${body} }`;
  using parsed = parseModule(api, 'record-captured-alias-overwrites.ts', source);
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
