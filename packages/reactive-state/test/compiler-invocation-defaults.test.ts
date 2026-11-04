import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-dependent state initializer whose discarded call result still evaluates its parameters. */
const fixture = stateFixture('invocation-defaults', 'InvocationDefaults', 'indented');

/** Selected parameter defaults and bindings execute before an immediate source body begins. */
describe('immediate invocation parameter initialization', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "((entry = decodeURIComponent('%')) => 'ok')()",
    "(function (entry = decodeURIComponent('%')) { return 'ok'; })()",
    "((entry = decodeURIComponent('%')) => 'ok')(undefined)",
    "((entry = decodeURIComponent('%')) => 'ok')(void 0)",
    "((entry = decodeURIComponent('%')) => 'ok')(...[])",
    "(({entry = decodeURIComponent('%')} = {}) => 'ok')()",
    "(([entry = decodeURIComponent('%')] = []) => 'ok')()",
    "(({}) => 'ok')()",
    "(([]) => 'ok')()",
    "(([]) => 'ok')(0 as never)",
    "(({}) => 'ok')(null as never)",
    "(function* (entry = decodeURIComponent('%')) { yield 'ok'; })()",
    "(async function* (entry = decodeURIComponent('%')) { yield 'ok'; })()",
    "((entry = (() => { throw new Error('default'); })()) => 'ok')()",
    "(({nested: {}}: {nested: never}) => 'ok')({nested: null as never})",
    "((earlier = undefined, entry = earlier ?? decodeURIComponent('%')) => 'ok')()",
    "(() => { const missing = undefined; return ((entry = decodeURIComponent('%')) => 'ok')(missing); })()",
  ])('refuses synchronous selected initialization failures: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "((entry = decodeURIComponent('%')) => 'ok')('provided')",
    "((entry = decodeURIComponent('%')) => 'ok')(null as never)",
    "((entry = decodeURIComponent('%')) => 'ok')(0 as never)",
    "(({entry = decodeURIComponent('%')}) => 'ok')({entry: 'provided'})",
    "(([entry = decodeURIComponent('%')]) => 'ok')(['provided'])",
    "(({}) => 'ok')(0)",
    "(([]) => 'ok')([])",
    "((entry = 'default') => entry)()",
    "(() => { const later = (entry = decodeURIComponent('%')) => 'ok'; return first; })()",
    "(async (entry = decodeURIComponent('%')) => 'ok')()",
    "(function* () { throw new Error('deferred'); })()",
    "(async function* () { throw new Error('deferred'); })()",
    "(() => { try { ((entry = decodeURIComponent('%')) => 'ok')(); } catch {} return first; })()",
    "((entry = decodeURIComponent('%')) => 'ok')(projectId)",
    "(({entry = decodeURIComponent('%')}) => 'ok')({entry: projectId})",
    "(({toString = decodeURIComponent('%')} = {}) => 'ok')()",
    "(() => { const options = {entry: undefined as string | undefined}; options.entry = first; return (({entry = decodeURIComponent('%')}) => 'ok')(options); })()",
    "(() => { let again = true; function recur(entry = again ? (again = false, recur()) : first): string { return 'ok'; } return recur(); })()",
  ])(
    'keeps provided values, unknown selections and deferred or caught failures: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
