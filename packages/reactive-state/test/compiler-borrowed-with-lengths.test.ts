import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The generic native call runs before its result is discarded in an authority initializer. */
const fixture = stateFixture('borrowed-with-lengths', 'BorrowedWithLengths');

/** Array.with obtains a generic receiver length before replacing the selected index. */
describe('borrowed Array.with generic receiver lengths', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "Array.prototype.with.call('a',1,'x')",
    "Array.prototype.with.call('abc',-4,'x')",
    "Array.prototype.with.call('')",
    "Reflect.apply(Array.prototype.with,'ab',[2,'x'])",
    "Array.prototype.with.apply({length:1},[1,'x'])",
    "Array.prototype.with.call({length:-1},0,'x')",
    "Array.prototype.with.call({length:1.9},1,'x')",
    "(()=>{const value={length:'1'};return Array.prototype.with.call(value,1,'x');})()",
  ])('refuses a generic receiver index outside ToLength: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "Array.prototype.with.call('a',0,'x')",
    "Array.prototype.with.call('a',-1,'x')",
    "Array.prototype.with.call('a',-0.9,'x')",
    "Array.prototype.with.call('😀',1,'x')",
    "Array.prototype.with.apply({length:2},[1,'x'])",
    "Array.prototype.with.call({length:'2.9'},1,'x')",
    "Array.prototype.with.call({length:first.length},1,'x')",
    "Array.prototype.with.call({get length(){return 2;}},1,'x')",
    "(()=>{const value={length:1};value.length=2;return Array.prototype.with.call(value,1,'x');})()",
    "(()=>{const value={length:1};return Array.prototype.with.call(value,1,(value.length=2,'x'));})()",
    "(()=>{try{return Array.prototype.with.call('a',1,'x');}catch{return first;}})()",
    "false&&Array.prototype.with.call('a',1,'x')",
    "(()=>Array.prototype.with.call('a',1,'x'))",
    "(()=>{const saved=Array.prototype.with;try{return(Array.prototype.with=(()=>[]) as never,Array.prototype.with.call('a',1,'x'));}finally{Array.prototype.with=saved;}})()",
  ])('keeps valid, changed and unknown generic lengths: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
