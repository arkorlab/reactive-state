import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('url-symbols', 'UrlSymbols');

/** URL construction converts its input and optional base to strings. */
describe('source-written URL symbol inputs', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new URL(Symbol('input') as never)",
    "new URL('https://example.test', Symbol('base') as never)",
    'new URL(Symbol.iterator as never)',
    "new globalThis.URL(Symbol('input') as never)",
  ])('refuses a known symbol in a consumed slot: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "new URL('https://example.test/path')",
    "new URL('/path', 'https://example.test')",
    "new URL('https://example.test', undefined, Symbol('ignored'))",
    "(() => { class URL { constructor(value: unknown) { void value; } } return new URL(Symbol('raw')); })()",
    "(() => { const saved = URL; try { globalThis.URL = class {} as never; return new URL(Symbol('raw') as never); } finally { globalThis.URL = saved; } })()",
    "(() => { const saved = Symbol; try { globalThis.Symbol = Object.setPrototypeOf((() => 'https://example.test') as never, saved); return new URL(Symbol('text') as never); } finally { globalThis.Symbol = saved; } })()",
    "(() => { try { return new URL(Symbol('caught') as never); } catch { return first; } })()",
    "false && new URL(Symbol('skipped') as never)",
    "(() => new URL(Symbol('deferred') as never))",
    'new URL(first)',
  ])('keeps valid, ignored, changed and opaque construction: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
