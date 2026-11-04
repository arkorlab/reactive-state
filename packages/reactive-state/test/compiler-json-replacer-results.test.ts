import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded serialization still completes before the authority receives its string input. */
const fixture = stateFixture('json-replacer-results', 'JsonReplacerResults', 'spaced');

/** JSON serialization rejects a primitive bigint returned for its root by a synchronous replacer. */
describe('written JSON replacer results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'JSON.stringify({}, () => 1n)',
    'JSON.stringify(0, () => 1n)',
    'JSON.stringify([first], () => 1n)',
    'JSON.stringify({}, () => { return 1n; })',
    'JSON.stringify({}, function () { return 1n; })',
    '(() => { const replace = () => 1n; return JSON.stringify({}, replace); })()',
    'globalThis.JSON.stringify({}, () => 1n)',
  ])('refuses a necessarily returned bigint: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "JSON.stringify({}, () => Symbol('omitted'))",
    'JSON.stringify({}, () => 0)',
    'JSON.stringify({}, () => undefined)',
    'JSON.stringify({}, async () => 1n)',
    'JSON.stringify({}, function* () { return 1n; })',
    'JSON.stringify({}, () => { if (false) { return 1n; } return 0; })',
    'JSON.stringify({}, () => {})',
    'JSON.stringify({}, () => { return; })',
    'JSON.stringify({}, (_key, value) => value)',
    'JSON.stringify({}, (_key, value = 1n) => value)',
    'JSON.stringify({}, [first])',
    '(() => { try { JSON.stringify({}, () => 1n); } catch {} return first; })()',
    'false && JSON.stringify({}, () => 1n)',
    '(() => JSON.stringify({}, () => 1n))',
    '(() => { const JSON = { stringify(_: unknown, _replace: unknown) { return first; } }; return JSON.stringify({}, () => 1n); })()',
    '(() => { let replace = () => 1n as unknown; replace = () => 0; return JSON.stringify({}, replace); })()',
    '(() => { const saved = BigInt; try { return (globalThis.BigInt = (() => 0) as never, JSON.stringify({}, () => BigInt(1))); } finally { globalThis.BigInt = saved; } })()',
  ])('keeps valid, opaque, caught and deferred results: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
