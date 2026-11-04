import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('find-holes', 'FindHoles');

/** Find visits absent array entries, while the other callback methods skip them. */
describe('written array find callbacks on holes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "[,].find(() => { throw new Error('hole'); })",
    "[,].findIndex(() => { throw new Error('hole'); })",
    "[,].findLast(() => { throw new Error('hole'); })",
    "[,].findLastIndex(() => { throw new Error('hole'); })",
    "(() => { const values = [,]; return values.find(() => { throw new Error('hole'); }); })()",
    "(() => { const values = [,]; return values.findLastIndex(() => { throw new Error('hole'); }); })()",
    "[,].findLast(() => { throw new Error('called'); }, 0)",
    "[,].findLast(() => { throw new Error('called'); }, () => { throw new Error('unused thisArg body'); })",
  ])('refuses a synchronous callback reached through a hole: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "[].find(() => { throw new Error('empty'); })",
    "[].findIndex(() => { throw new Error('empty'); })",
    "[].findLast(() => { throw new Error('empty'); })",
    "[].findLastIndex(() => { throw new Error('empty'); })",
    "[,].map(() => { throw new Error('unused'); })",
    "[,].filter(() => { throw new Error('unused'); })",
    "[,].some(() => { throw new Error('unused'); })",
    "[,].every(() => { throw new Error('unused'); })",
    "[,].forEach(() => { throw new Error('unused'); })",
    "[,].reduce(() => { throw new Error('unused'); }, 0)",
    "[,].find(function* () { throw new Error('deferred'); })",
    "(() => { try { [,].find(() => { throw new Error('caught'); }); } catch {} return first; })()",
    "false && [,].find(() => { throw new Error('skipped'); })",
    "(() => { const values = [,]; values.find = () => first; return values.find(() => { throw new Error('unused'); }); })()",
    "({ find() { return first; } }).find(() => { throw new Error('unused'); })",
    "(() => { const sparse = [,,]; return sparse.findLast(() => { throw new Error('unused holes'); }, (sparse.length = 0, undefined)); })()",
  ])('keeps empty, skipped, deferred and changed callback work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
