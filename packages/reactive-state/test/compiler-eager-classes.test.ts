import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded class definition in an initializer the authority must evaluate. */
const fixture = stateFixture('eager-classes', 'EagerClasses', 'ok');

/** Class definition executes static work and computed names while deferring instance work. */
describe('eager class definition exceptions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "(class { static { throw new Error('bad'); } })",
    "(class { static value = decodeURIComponent('%'); })",
    "(class { [decodeURIComponent('%')] = 1; })",
    "(class { [decodeURIComponent('%')]() {} })",
    "(class { get [decodeURIComponent('%')]() { return 1; } })",
    "(class { set [decodeURIComponent('%')](_value: unknown) {} })",
    '(class { [Object.create(null) as never]() {} })',
    "(class { static { [1].map(() => { throw new Error('bad'); }); } })",
    "(class extends (decodeURIComponent('%') as never) {})",
    "(() => { class Eager { static { throw new Error('bad'); } } return Eager; })()",
  ])('refuses eager class work that synchronously throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    "(class { constructor() { throw new Error('later'); } })",
    "(class { value = decodeURIComponent('%'); })",
    "(class { method() { throw new Error('later'); } })",
    "(class { static method() { decodeURIComponent('%'); } })",
    "(class { static value = () => { throw new Error('later'); }; })",
    "(class { static { try { throw new Error('caught'); } catch {} } })",
    "(class { static { try { decodeURIComponent('%'); } catch {} } })",
    "(class { static { if (false) { throw new Error('skipped'); } } })",
    "(class { static { if (false) { decodeURIComponent('%'); } } })",
    "(class { ['value'] = decodeURIComponent('%'); })",
    "(class { static get value() { throw new Error('later'); } })",
  ])('keeps deferred work and handled or skipped static exceptions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
