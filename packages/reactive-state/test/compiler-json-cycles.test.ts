import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Only the discarded serialization is under inspection; the state itself is a prop-based string. */
const fixture = stateFixture('json-cycles', 'JsonCycles', 'spaced');

/** A plain local object's established cycle still throws when the serialization is discarded. */
describe('written JSON serialization cycles', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "(() => { const value: any = {}; value.self = value; JSON.stringify(value); return 'ok'; })()",
    "(() => { const value: any[] = []; value[0] = value; JSON.stringify(value); return 'ok'; })()",
    "(() => { const value: any = {}; const alias = value; alias.self = value; JSON.stringify(value); return 'ok'; })()",
    "(() => { const a: any = {}; const b: any = {}; a.child = b; b.parent = a; JSON.stringify(a); return 'ok'; })()",
    "(() => { const value: any = { child: {} }; value.child.parent = value; JSON.stringify(value); return 'ok'; })()",
    "(() => { const value: any = {}; value.self = value; globalThis.JSON.stringify(value); return 'ok'; })()",
    "(() => { const value: any = {}; value.self = value; JSON.stringify(value, null); return 'ok'; })()",
    "(() => { const value: any = {}; value.self = value; JSON.stringify(value, undefined); return 'ok'; })()",
  ])('refuses an established serialization cycle: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    '(() => { const value: any = {}; value.self = value; delete value.self; return JSON.stringify(value); })()',
    '(() => { const value: any = {}; value.self = value; value.self = null; return JSON.stringify(value); })()',
    '(() => { const shared = {}; return JSON.stringify({ a: shared, b: shared }); })()',
    '(() => { const value: any = {}; value.self = value; value.toJSON = () => 0; return JSON.stringify(value); })()',
    '(() => { const value: any = {}; value.self = value; return JSON.stringify(value, () => 0); })()',
    '(() => { const value: any = {}; value.self = value; return JSON.stringify(value, []); })()',
    '(() => { const value: any = {}; value.self = value; try { JSON.stringify(value); } catch {} return first; })()',
    '(() => { const value: any = {}; value.self = value; return () => JSON.stringify(value); })()',
    '(() => { const value: any = {}; value.self = value; return false && JSON.stringify(value); })()',
    '(() => { const value: any = {}; function repair() { delete value.self; } value.self = value; repair(); return JSON.stringify(value); })()',
    '(() => { const value: any = {}; if (first) { value.self = value; } return JSON.stringify(value); })()',
    '(() => { const value: any[] & { self?: unknown } = []; value.self = value; return JSON.stringify(value); })()',
    '(() => { const value: any[] = []; value[0] = value; value.length = 0; return JSON.stringify(value); })()',
    '(() => { const value: any[] = []; value[4294967295] = value; return JSON.stringify(value); })()',
    "(() => { const value: any = {}; value.self = value; const JSON = { stringify(_: unknown) { return 'ok'; } }; return JSON.stringify(value); })()",
  ])('keeps repaired, repeated, opaque and unexecuted references: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
