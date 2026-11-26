import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The discarded sort completes before the authority selects its JSON input. */
const fixture = stateFixture('comparator-results', 'ComparatorResults', 'spaced');

/** Sort converts a comparator's result to Number after invoking it for defined elements. */
describe('written comparator result conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "[2, 1].sort(() => Symbol('result') as never)",
    "[2, 1].toSorted(() => Symbol('result') as never)",
    '[2, 1].sort(() => 1n as never)',
    '[2, 1].toSorted(() => 1n as never)',
    "[2, 1].sort(() => { return Symbol('result') as never; })",
    '[2, 1].sort(function () { return 1n as never; })',
    "new Uint8Array([2, 1]).sort(() => Symbol('result') as never)",
    'new Uint8Array(2).toSorted(() => 1n as never)',
    "(() => { const values = [2, 1]; return values.sort(() => Symbol('result') as never); })()",
    "(() => { const compare = () => Symbol('result') as never; return [2, 1].sort(compare); })()",
  ])(
    'refuses a necessarily invoked comparator with an invalid numeric result: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
    },
  );

  it.each([
    "[].sort(() => Symbol('unused') as never)",
    "[1].toSorted(() => Symbol('unused') as never)",
    "[, 1].sort(() => Symbol('unused') as never)",
    "[undefined, 1].toSorted(() => Symbol('unused') as never)",
    "[undefined, undefined].sort(() => Symbol('unused') as never)",
    "new Uint8Array(1).sort(() => Symbol('unused') as never)",
    '[2, 1].sort(() => 0)',
    '[2, 1].sort(() => undefined as never)',
    '[2, 1].sort((Symbol: number) => Symbol)',
    "[2, 1].sort(() => { if (false) { return Symbol('unused') as never; } })",
    "[2, 1].sort(async () => Symbol('unused') as never)",
    "[2, 1].sort(function* () { return Symbol('deferred'); } as never)",
    "(() => { const values = [2, 1]; values.length = 0; return values.sort(() => Symbol('unused') as never); })()",
    "(() => { const holder = {sort(_: unknown) { return first; }}; return holder.sort(() => Symbol('unused')); })()",
    "(() => { try { [2, 1].sort(() => Symbol('caught') as never); } catch {} return first; })()",
    "false && [2, 1].sort(() => Symbol('skipped') as never)",
    "(() => [2, 1].sort(() => Symbol('deferred') as never))",
    "[(() => 2)(), 1].sort(() => Symbol('opaque source effects') as never)",
    "(() => { const saved = Symbol; try { return new Uint8Array([{valueOf() { globalThis.Symbol = (() => 0) as never; return 2; }}, 1] as never).sort(() => Symbol('changed before callback') as never); } finally { globalThis.Symbol = saved; } })()",
  ])(
    'keeps unused, valid, opaque, caught and deferred comparison results: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
