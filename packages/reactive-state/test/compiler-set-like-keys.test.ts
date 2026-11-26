import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('set-like-keys', 'SetLikeKeys');

/** Set composition obtains an iterator only on the native branch that consumes its keys. */
describe('source-written set-like keys methods', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new Set().union({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set().union({ size: 0, has: () => false, keys: () => 1 })',
    'new Set().union({ size: 0, has() { return false; }, keys() {} })',
    'new Set().symmetricDifference({ size: 0, has() { return false; }, keys() { return undefined; } })',
    'new Set([1]).difference({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set([1]).intersection({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set([1]).isDisjointFrom({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set().isSupersetOf({ size: 0, has() { return false; }, keys() { return null; } })',
    "new Set().union({ size: 0, has() { return false; }, keys() { throw new Error('keys'); } })",
    "new Set().symmetricDifference({ size: 0, has() { return false; }, keys: () => { throw new Error('keys'); } })",
    "new Set([1]).intersection({ size: 0, has() { return false; }, keys() { throw new Error('keys'); } })",
  ])('refuses an invoked invalid result or synchronous throw: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    'new Set().union({ size: 0, has() { return false; }, keys() { return [].values(); } })',
    'new Set().symmetricDifference({ size: 0, has() { return false; }, keys: () => ({ next: () => ({ done: true }) }) })',
    'new Set().difference({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set().intersection({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set().isDisjointFrom({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set([1]).isSubsetOf({ size: 0, has() { return false; }, keys() { return null; } })',
    'new Set().isSupersetOf({ size: 1, has() { return false; }, keys() { return null; } })',
    "new Set().union({ size: 0, has() { throw new Error('unused'); }, keys() { return [].values(); } })",
    'new Set().union({ size: 0, has() { return false; }, *keys() {} })',
    '(() => { try { new Set().union({ size: 0, has() { return false; }, keys() { return null; } }); } catch {} return first; })()',
    'false && new Set().union({ size: 0, has() { return false; }, keys() { return null; } })',
    '(() => new Set().union({ size: 0, has() { return false; }, keys() { return null; } }))',
    '({ union() { return first; } }).union({ size: 0, has() { return false; }, keys() { return null; } })',
    '(() => { const entries = { size: 0, has() { return false; }, keys() { return null; } }; entries.keys = () => [].values() as never; return new Set().union(entries); })()',
    'new Set().union({ size: 0, has() { return false; }, keys() { return first; } })',
  ])('keeps unselected, valid and opaque keys work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
