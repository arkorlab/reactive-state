import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority computes the discarded call before selecting a JSON state value. */
const fixture = stateFixture('collection-callbacks', 'CollectionCallbacks', 'spaced');

/** Native forEach invokes its source callback when a constructed collection is known nonempty. */
describe('written nonempty collection callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new Set([first]).forEach(() => { throw new Error('callback'); })",
    "new Map([[first, 1]]).forEach(() => { throw new Error('callback'); })",
    "new Uint8Array([1]).forEach(() => { throw new Error('callback'); })",
    "new Uint8Array(1).forEach(() => { throw new Error('callback'); })",
    "new BigInt64Array(1).forEach(() => { throw new Error('callback'); })",
    "(() => { const entries = new Set([first]); return entries.forEach(() => { throw new Error('callback'); }); })()",
    "(() => { const Bag = Set; return new Bag([first]).forEach(() => { throw new Error('callback'); }); })()",
  ])('refuses a guaranteed synchronous throwing callback: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "new Set().forEach(() => { throw new Error('unused'); })",
    "new Map([]).forEach(() => { throw new Error('unused'); })",
    "new Uint8Array(0).forEach(() => { throw new Error('unused'); })",
    "new Uint8Array(Number(first)).forEach(() => { throw new Error('unknown'); })",
    "(() => { const entries = new Set([first]); entries.clear(); return entries.forEach(() => { throw new Error('unused'); }); })()",
    "(() => { const entries = new Map([[first, 1]]); entries.clear(); return entries.forEach(() => { throw new Error('unused'); }); })()",
    "(() => { class Set { forEach(_: () => void) {} } return new Set().forEach(() => { throw new Error('unused'); }); })()",
    "(() => { const entries = new Set([first]); entries.forEach = () => {}; return entries.forEach(() => { throw new Error('unused'); }); })()",
    "(() => { const entries = new Set([first]); return entries.forEach((() => { entries.clear(); return () => { throw new Error('unused'); }; })()); })()",
    "new Set([first]).forEach(async () => { throw new Error('rejection'); })",
    "new Set([first]).forEach(function* () { throw new Error('deferred'); })",
    "(() => { try { new Set([first]).forEach(() => { throw new Error('caught'); }); } catch {} return first; })()",
    "false && new Set([first]).forEach(() => { throw new Error('skipped'); })",
    "(() => new Set([first]).forEach(() => { throw new Error('deferred'); }))",
    "new Set([(() => first)()]).forEach(() => { throw new Error('opaque source effects'); })",
    'new Set([first]).forEach(() => first)',
    "(() => { const saved = Set.prototype.forEach; try { new Set([class { static { Set.prototype.forEach = function () {}; } }]).forEach(() => { throw new Error('unused after static effect'); }); return first; } finally { Set.prototype.forEach = saved; } })()",
  ])('keeps empty, opaque, changed and deferred collection work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
