import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Reading a prop makes the authority check the initializer's selected branch. */
const fixture = stateFixture('iterator-next', 'IteratorNext', 'value');

const ITERABLE = '{[Symbol.iterator](){return{next(){throw new Error("next");}};}}';

/** Obtaining an iterator does not run its next body; requesting the first entry does. */
describe('source-written iterator next failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    `[...${ITERABLE}]`,
    `((_value: unknown) => 0)(...${ITERABLE})`,
    `new (class {})(...${ITERABLE})`,
    `(() => { for(const entry of ${ITERABLE}) { void entry; break; } return 0; })()`,
    `(() => { const [entry] = ${ITERABLE}; return entry; })()`,
    `(() => { const [,] = ${ITERABLE}; return 0; })()`,
    `(() => { const [...entries] = ${ITERABLE}; return entries; })()`,
    `new Set(${ITERABLE})`,
  ])('refuses a consumed next that throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    `(() => { const [] = ${ITERABLE}; return 0; })()`,
    `(() => { try { [...${ITERABLE}]; } catch {} return 0; })()`,
    `(function*() { yield* ${ITERABLE}; })()`,
    '(() => { const source = {[Symbol.iterator]() { let initial = true; return {next() { if(initial) { initial = false; return {done: false, value: 0}; } throw new Error("later"); }}; }}; for(const entry of source) { void entry; break; } return 0; })()',
    '[...{[Symbol.iterator]() { return {next() { return {done: true, value: 0}; }}; }}]',
    '[...{[Symbol.iterator]() { return {next() { if(first === "throws") { throw new Error("unknown"); } return {done: true, value: 0}; }}; }}]',
    '(() => { const [entry] = {[Symbol.iterator]() { return {*next() { throw new Error("deferred"); }}; }}; void entry; return 0; })()',
    '[...{[Symbol.iterator]() { return {next() { throw new Error("overwritten"); }, next() { return {done: true, value: 0}; }}; }}]',
    `Iterator.from(${ITERABLE})`,
  ])('keeps unconsumed, deferred, caught and uncertain next calls: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
