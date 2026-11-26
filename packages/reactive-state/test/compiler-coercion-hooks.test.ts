import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The assignment result is discarded before the authority selects a JSON state value. */
const fixture = stateFixture('coercion-hooks', 'CoercionHooks');

/** Primitive conversion invokes source hooks before its enclosing expression produces a value. */
describe('source primitive conversion hooks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "({[Symbol.toPrimitive](){throw new Error('bad')}} as any)+1",
    "1+({[Symbol.toPrimitive](){throw new Error('bad')}} as any)",
    "+({[Symbol.toPrimitive](){throw new Error('bad')}} as any)",
    "({[Symbol.toPrimitive](){throw new Error('bad')}} as any)<1",
    "({valueOf(){throw new Error('bad')}} as any)+1",
    "({toString(){throw new Error('bad')}} as any)+1",
    `\`\${{toString(){throw new Error('bad')}}}\``,
    "({[Symbol.toPrimitive]:()=>{throw new Error('bad')}} as any)-1",
  ])('refuses an invoked throwing primitive conversion: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '({[Symbol.toPrimitive](){return 1}} as any)+1',
    "({valueOf(){return 1},toString(){throw new Error('unused')}} as any)+1",
    "({[Symbol.toPrimitive](){throw new Error('unused')}} as any)===1",
    "({[Symbol.toPrimitive](){throw new Error('unused')}} as any)==null",
    "!({[Symbol.toPrimitive](){throw new Error('unused')}} as any)",
    `((parts:any,...values:any[])=>'ok')\`\${{[Symbol.toPrimitive](){throw new Error('unused')}}}\``,
    "(()=>{try{return +({[Symbol.toPrimitive](){throw new Error('caught')}} as any)}catch{return 'ok'}})()",
    "false&&+({[Symbol.toPrimitive](){throw new Error('unused')}} as any)",
    "()=>+({[Symbol.toPrimitive](){throw new Error('deferred')}} as any)",
    "(()=>{const item:any={valueOf(){throw new Error('replaced')}};return item+(item.valueOf=()=>1,0)})()",
    "(()=>{const proto:any=Object.prototype;proto[Symbol.toPrimitive]=()=>1;try{return ({valueOf(){throw new Error('unused')}} as any)+1}finally{delete proto[Symbol.toPrimitive]}})()",
  ])('keeps nonthrowing conversions and uninvoked hooks: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
