import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority selects this discarded invocation when the first value is empty. */
const fixture = stateFixture('default-branch-effects', 'DefaultBranchEffects', 'indented');

/** Possible synchronous branch writes invalidate earlier parameter values before later bindings. */
describe('selected default branch effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '((value: any = null, repaired = (() => { if (true) { value = []; } })(), [] = value) => first)()',
    "((value: any = null, repaired = (() => { if (first === '') { value = []; } })(), [] = value) => first)()",
    '((value: any = null, repaired = (() => { for (let index = 0; index < 1; index++) { value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { try { value = []; } finally {} })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { switch (0) { case 0: value = []; break; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { if (false) {} value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (async () => { if (true) { value = []; } })(), [] = value) => first)()',
  ])('keeps a possible synchronous branch repair: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '((value: any = null, repaired = (() => { if (false) { value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { if (true) { return 0; value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { if (true) { return 0; } value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { if (true) { const callback = () => { value = []; }; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (function* () { if (true) { value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (async () => { await 0; if (true) { value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { return 0; if (true) { value = []; } })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { if (true) { const value: any = []; } })(), [] = value) => first)()',
  ])('retains unexecuted or unrelated branch write failures: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it('preserves the awaited-state boundary after a synchronous branch repair', async () => {
    const app = await fixture(
      '((value: any = null, repaired = (async () => { if (true) { value = []; } await 0; })(), [] = value) => first)()',
    );
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('server part awaits');
  });
});
