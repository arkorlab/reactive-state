import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('regexp-escape', 'RegExpEscape');

/** Native RegExp.escape accepts actual strings rather than coercing a written input. */
describe('regexp.escape input kinds', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'RegExp.escape(1 as never)',
    'RegExp.escape(NaN as never)',
    'RegExp.escape(Infinity as never)',
    'RegExp.escape(true as never)',
    'RegExp.escape(false as never)',
    'RegExp.escape(null as never)',
    'RegExp.escape(undefined as never)',
    'RegExp.escape(void 0 as never)',
    'RegExp.escape(1n as never)',
    'RegExp.escape(-1n as never)',
    'RegExp.escape({} as never)',
    'RegExp.escape([] as never)',
    'RegExp.escape((()=>{}) as never)',
    'RegExp.escape(/x/ as never)',
    'RegExp.escape()',
    '(()=>{const value=1;return RegExp.escape(value as never);})()',
    '(()=>{const escape=RegExp.escape;return escape(1 as never);})()',
  ])('refuses a quiet source-proven non-string input: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('which no JSON holds'),
    ]);
  });

  it.each([
    "RegExp.escape('')",
    "RegExp.escape('a-b')",
    "(()=>{const value='a-b';return RegExp.escape(value);})()",
    "(()=>{const escape=RegExp.escape;return escape('a-b');})()",
    'RegExp.escape(first)',
    "(()=>{const read=()=> 'a-b';return RegExp.escape(read());})()",
    "RegExp.escape('a-b',1 as never)",
    "(()=>{const holder={escape:(_value:unknown)=>'ok'};return holder.escape(1);})()",
    "(()=>{RegExp.escape=(()=> 'ok') as never;return RegExp.escape(1 as never);})()",
    "(()=>{let value:unknown=1;value='ok';return RegExp.escape(value as never);})()",
  ])(
    'keeps strings, unknown inputs, ignored arguments and changed natives: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
