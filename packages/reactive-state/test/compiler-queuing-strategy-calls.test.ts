import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Ordinary native construction precedes a discarded result in an authority-started state. */
const fixture = stateFixture('queuing-strategy-calls', 'QueuingStrategyCalls');

/** The native queuing strategy classes require construction even when their options are valid. */
describe('native queuing strategy ordinary calls', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'ByteLengthQueuingStrategy({highWaterMark:1})',
    'CountQueuingStrategy({highWaterMark:1})',
    '(()=>{const Strategy=ByteLengthQueuingStrategy;return Strategy({highWaterMark:1});})()',
    'ByteLengthQueuingStrategy.call(null,{highWaterMark:1})',
    'CountQueuingStrategy.apply(null,[{highWaterMark:1}])',
    'Reflect.apply(ByteLengthQueuingStrategy,null,[{highWaterMark:1}])',
    '(CountQueuingStrategy as Function)()',
  ])('refuses a native strategy called without new: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new ByteLengthQueuingStrategy({highWaterMark:1})',
    'new CountQueuingStrategy({highWaterMark:1})',
    "new CountQueuingStrategy({highWaterMark:0,ignored:Symbol('ignored')} as never)",
    '(()=>{function CountQueuingStrategy(options:{highWaterMark:number}){return options;}return CountQueuingStrategy({highWaterMark:1});})()',
    '(()=>{const saved=CountQueuingStrategy;try{globalThis.CountQueuingStrategy=(()=>first) as never;return (()=>CountQueuingStrategy({highWaterMark:1}))();}finally{globalThis.CountQueuingStrategy=saved;}})()',
    '(()=>{const saved=ByteLengthQueuingStrategy;try{return(globalThis.ByteLengthQueuingStrategy=(()=>first) as never,ByteLengthQueuingStrategy({highWaterMark:1}));}finally{globalThis.ByteLengthQueuingStrategy=saved;}})()',
    '(()=>{let Strategy=ByteLengthQueuingStrategy;Strategy=(()=>first) as never;return Strategy({highWaterMark:1});})()',
    '(()=>{function create(options:unknown){return new CountQueuingStrategy(options as never);}return create({highWaterMark:1});})()',
    '(()=>{try{return CountQueuingStrategy({highWaterMark:1});}catch{return first;}})()',
    'false&&ByteLengthQueuingStrategy({highWaterMark:1})',
    '(()=>CountQueuingStrategy({highWaterMark:1}))',
  ])('keeps construction, changed targets and evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
