import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded write must complete before this authority-started JSON value is available. */
const fixture = stateFixture('primitive-writes', 'PrimitiveWrites');

/** An ESM property write keeps its primitive receiver even though a read would box that receiver. */
describe('source-written strict primitive property writes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(1 as any).value=2',
    '("text" as any).value=2',
    '(true as any).value=2',
    '(Symbol("value") as any).value=2',
    '(1n as any).value=2',
    '(()=>{const value=1;const key="slot";return(value as any)[key]=2;})()',
    '++(true as any).value',
    '(1 as any).value++',
    '("text" as any).length+=1',
    '(1 as any).value??=2',
    '(1 as any).value||=2',
    '("text" as any)[0]&&=2',
  ])('refuses a selected strict write to a primitive: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(new Number(1) as any).value=2',
    '(new String("text") as any).value=2',
    '(1 as any).__proto__={}',
    '(1 as any).value&&=2',
    '("text" as any).length||=2',
    '("text" as any)[0]??=2',
    '(()=>{try{(1 as any).value=2;}catch{}return 0;})()',
    '(()=>(1 as any).value=2)',
    'false&&((1 as any).value=2)',
    '(JSON.parse(first||"{}") as any).value=2',
    '(()=>{try{return(1 as any).value=Object.defineProperty(Number.prototype,"value",{set(_value:unknown){},configurable:true});}finally{delete(Number.prototype as any).value;}})()',
    '(()=>{Object.defineProperty(Number.prototype,"slot",{set(_value:unknown){},configurable:true});try{return(1 as any).slot=2;}finally{delete(Number.prototype as any).slot;}})()',
  ])('keeps boxed, shorted, intercepted, unknown and unexecuted writes: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
