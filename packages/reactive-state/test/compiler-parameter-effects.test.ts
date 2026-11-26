import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded invocation must still initialize its selected parameters before returning. */
const fixture = stateFixture('parameter-effects', 'ParameterEffects', 'indented');

/** Earlier selected defaults can replace a formal before a later parameter reads it. */
describe('parameter initialization effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '((value: any = null, repaired = (value = []), [] = value) => first)()',
    '((value: any = 0, repaired = ([value] = [[]]), [] = value) => first)()',
    '((value: any = null, repaired = (value = {}), {} = value) => first)()',
    "((value = {entry: undefined as string | undefined}, repaired = (value.entry = first), {entry = decodeURIComponent('%')} = value) => first)()",
  ])('keeps a later binding after its source is changed: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '((value: any = null, flag = false, repaired = (flag = true), [] = value) => first)()',
    "((value: any = null, repaired = decodeURIComponent('%'), [] = value) => first)()",
    "((value: any = null, repaired = (value = []), [] = value) => first)(null, 'provided' as never)",
    '((value: any = null, [] = value) => first)()',
    '((value: any = null, repair = () => { value = []; }, [] = value) => first)()',
    '((value: any = null, repair = false && (value = []), [] = value) => first)()',
  ])('retains unaffected, earlier or unexecuted-repair failures: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });
});
