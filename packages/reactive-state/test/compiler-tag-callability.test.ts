import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The tag result is discarded, so only an escaping synchronous failure prevents the JSON value. */
const fixture = stateFixture('tag-callability', 'TagCallability');

/** A template tag is invoked synchronously, with the same callable requirement as an ordinary call. */
describe('written template tag callability', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '({} as never)`x`',
    '(1 as never)`x`',
    '(null as never)`x`',
    '(Symbol() as never)`x`',
    '([] as never)`x`',
    '(/x/ as never)`x`',
    '(class {})`x`',
    '({tag:1}).tag`x`',
  ])('refuses a known noncallable tag: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>first)`x`',
    '(function(){return first;})`x`',
    '({tag(){return first;}}).tag`x`',
    '(()=>{function tag(){return first;}return tag`x`;})()',
    '(()=>{const tag=()=>first;return tag`x`;})()',
    '(async function(){return first;})`x`',
    '(function*(){throw new Error("deferred");})`x`',
    `(()=>first)\`x\${Symbol()}\``,
    '({get tag(){return ()=>first;}}).tag`x`',
    '(()=>{try{return ({} as never)`x`;}catch{return first;}})()',
    '(()=>({} as never)`x`)',
    'false && ({} as never)`x`',
  ])('keeps callable, unknown, caught and deferred tags: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
