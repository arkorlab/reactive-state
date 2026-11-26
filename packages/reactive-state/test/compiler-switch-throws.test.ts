import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded source invocation completes before the authority receives a JSON string. */
const fixture = stateFixture('switch-throws', 'SwitchThrows', 'spaced');

/** Native switch selection evaluates case tests before entering one fallthrough suffix. */
describe('selected switch exception flow', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(() => { switch (1) { case 1: throw new Error("bad"); } return first; })()',
    '(() => { switch ("one") { case "one": throw new Error("bad"); } return first; })()',
    '(() => { switch (true) { case true: throw new Error("bad"); } return first; })()',
    '(() => { switch (null) { case null: throw new Error("bad"); } return first; })()',
    '(() => { switch (undefined) { case undefined: throw new Error("bad"); } return first; })()',
    '(() => { switch (1n) { case 1n: throw new Error("bad"); } return first; })()',
    '(() => { switch (1) { case 2: return first; default: throw new Error("bad"); } })()',
    '(() => { switch (1) { default: return first; case 1: throw new Error("bad"); } })()',
    '(() => { switch (1) { case 1: case 2: throw new Error("bad"); } return first; })()',
    '(() => { const mode = 1; switch (mode) { case 1: throw new Error("bad"); } return first; })()',
    '(() => { switch (1) { case 1: break; } throw new Error("after"); })()',
    '(() => { switch (1) { case 1: return decodeURIComponent("%"); } return first; })()',
    '(() => { switch (decodeURIComponent("%")) { default: return first; } })()',
    '(() => { switch (1) { case decodeURIComponent("%") as never: return first; default: return first; } })()',
  ])('refuses an exception on the selected path: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('which no JSON holds'),
    ]);
  });

  it.each([
    '(() => { switch (1) { case 2: return decodeURIComponent("%"); default: return first; } })()',
    '(() => { switch (1) { case 1: break; default: return decodeURIComponent("%"); } return first; })()',
    '(() => { switch (1) { case 1: return first; default: return decodeURIComponent("%"); } })()',
    '(() => { switch (1) { case 1: break; return decodeURIComponent("%"); } return first; })()',
    '(() => { switch (1) { case 1: { break; } return decodeURIComponent("%"); } return first; })()',
    '(() => { switch (first) { case "bad": return decodeURIComponent("%"); default: return first; } })()',
    '(() => { switch ("1") { case 1 as never: throw new Error("unused"); default: return first; } })()',
    '(() => { switch (NaN) { case NaN: throw new Error("unused"); default: return first; } })()',
    '(() => { switch (1) { case 1: return first; case 1: throw new Error("unused"); } })()',
    '(() => { switch (1) { default: throw new Error("unused"); case 1: return first; } })()',
    '(() => { switch (1) { case 2: throw new Error("unused"); } return first; })()',
    '(() => { try { switch (1) { case 1: throw new Error("caught"); } } catch {} return first; })()',
    '(() => { try { switch (1) { case 1: throw new Error("replaced"); } } finally { return first; } })()',
    '(() => () => { switch (1) { case 1: throw new Error("deferred"); } })()',
    '((async () => { switch (1) { case 1: throw new Error("deferred"); } })().catch(() => first))',
    '((function* () { switch (1) { case 1: throw new Error("deferred"); } })())',
    '(() => { let mode = 1; function label() { mode = 2; return 0; } switch (mode) { case label(): break; case 2: throw new Error("unused"); default: return first; } })()',
  ])('keeps unselected, opaque, exiting and handled paths: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
