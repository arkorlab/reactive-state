import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded invocation inside an authority-evaluated state initializer. */
const fixture = stateFixture('noncallable', 'Noncallable', 'ok');

/** Calls and constructions reject a value the source proves cannot perform that invocation. */
describe('written noncallable callees', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(1 as never)()',
    '(true as never)()',
    '("text" as never)()',
    '(1n as never)()',
    '(Symbol("key") as never)()',
    '({} as never)()',
    '([] as never)()',
    '(/x/ as never)()',
    '({} as {missing: () => void}).missing()',
    '({run: 1} as never as {run: () => void}).run()',
    '((class {}) as never)()',
    'new (1 as never)()',
    'new (({} as {missing: new () => unknown}).missing)()',
    'new ((() => 0) as never)()',
    'new ((async function() {}) as never)()',
    'new ((function*() {}) as never)()',
    'new (({run() {}}).run as never)()',
    '(1 as never)?.()',
    '(() => { const fn = 1; const alias = fn; return (alias as never)(); })()',
    '(() => { const box = {run: 0}; return (box.run as never)(); })()',
  ])('refuses a statically invalid invocation: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('no JSON holds');
  });

  it.each([
    '(function() { return 0; })()',
    'new (function() {})()',
    'new (class {})()',
    '({run() { return 0; }}).run()',
    '({get run() { return () => 0; }}).run()',
    '({__proto__: {run() { return 0; }}} as never as {run: () => number}).run()',
    '({...{run: () => 0}}).run()',
    '([() => 0])[0]!()',
    '({}).toString()',
    'new (({}).constructor as new () => unknown)()',
    '({} as {missing?: (value: unknown) => void}).missing?.(decodeURIComponent("%"))',
    '(null as null | {run: (value: unknown) => void})?.run(decodeURIComponent("%"))',
    '(() => { let fn: unknown = 1; fn = () => 0; return (fn as () => number)(); })()',
    '(new Proxy(() => 0, {}))()',
    '(new (function Factory() { return () => 0; })())()',
    '(() => { const box = {run: 1 as unknown}; box.run = () => 0; return (box.run as () => number)(); })()',
  ])(
    'keeps callable, constructed, unknown and short-circuited invocations: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
