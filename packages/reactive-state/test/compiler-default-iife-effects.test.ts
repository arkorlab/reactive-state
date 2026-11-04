import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded invocation still reads a later binding after its earlier defaults finish. */
const fixture = stateFixture('default-iife-effects', 'DefaultIifeEffects', 'indented');

/** Invoked source functions can repair captured formals before a later parameter binds them. */
describe('selected default immediate function effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '((value: any = null, repaired = (() => { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (function () { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (async () => { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { (() => { value = []; })(); })(), [] = value) => first)()',
  ])('keeps a synchronous captured repair: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '((value: any = null, repaired = () => { value = []; }, [] = value) => first)()',
    '((value: any = null, repaired = (function* () { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (async function* () { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (async () => { await 0; value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = (() => { return 0; value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = false && (() => { value = []; })(), [] = value) => first)()',
    '((value: any = null, repaired = ((value: any) => { value = []; })(null), [] = value) => first)()',
  ])(
    'retains deferred, unreachable, skipped or shadowed repair failures: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
    },
  );

  it.each([
    '((value: any = null, repaired = (async () => { value = []; await 0; })(), [] = value) => first)()',
    '((value: any = null, repaired = (async () => { await (value = []); })(), [] = value) => first)()',
  ])(
    'preserves the existing awaited-state boundary after binding succeeds: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('server part awaits');
    },
  );
});
