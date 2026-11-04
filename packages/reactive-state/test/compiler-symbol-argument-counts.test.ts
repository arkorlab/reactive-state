import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the call before receiving the trailing JSON string. */
const fixture = stateFixture('symbol-argument-counts', 'SymbolArgumentCounts');

/** Native conversions ignore later arguments while still evaluating their expressions. */
describe('written Symbol conversion argument counts', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{const convert=Number;return(convert as Function)(1,Symbol("ignored"));})()',
    '(()=>{const math=Math;return(math.abs as Function)(1,Symbol("ignored"));})()',
    '(()=>{const convert=parseFloat;return(convert as Function)("1",Symbol("ignored"));})()',
    '(()=>{const convert=parseInt;return(convert as Function)("1",10,Symbol("ignored"));})()',
    '(()=>{const math=Math;return(math.random as Function)(Symbol("ignored"));})()',
    '(()=>{const math=Math;return(math.pow as Function)(2,2,Symbol("ignored"));})()',
    '(()=>{const convert=Date.UTC;return(convert as Function)(2020,0,1,0,0,0,0,Symbol("ignored"));})()',
    '(()=>{const convert=encodeURIComponent;return(convert as Function)("x",Symbol("ignored"));})()',
    '(()=>{const convert=Number.parseFloat;return(convert as Function)("1",Symbol("ignored"));})()',
    '(()=>{const convert=Number.parseInt;return(convert as Function)("1",10,Symbol("ignored"));})()',
    '(()=>{const convert=Number;return(convert as Function)(...[1,Symbol("ignored")]);})()',
  ])('keeps an ignored Symbol argument: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '(()=>{const convert=Number;return convert(Symbol("converted") as never);})()',
    '(()=>{const math=Math;return math.abs(Symbol("converted") as never);})()',
    '(()=>{const convert=parseFloat;return convert(Symbol("converted") as never);})()',
    '(()=>{const convert=parseInt;return convert("1",Symbol("converted") as never);})()',
    '(()=>{const math=Math;return math.pow(2,Symbol("converted") as never);})()',
    '(()=>{const convert=Date.UTC;return convert(2020,0,1,0,0,0,Symbol("converted") as never);})()',
    '(()=>{const math=Math;return math.max(1,Symbol("converted") as never);})()',
    '(()=>{const math=Math;return math.min(1,Symbol("converted") as never);})()',
    '(()=>{const math=Math;return math.hypot(1,Symbol("converted") as never);})()',
    '(()=>{const convert=String.fromCharCode;return convert(1,Symbol("converted") as never);})()',
    '(()=>{const convert=String.fromCodePoint;return convert(1,Symbol("converted") as never);})()',
    '(()=>{const convert=Number;return(convert as Function)(1,+Symbol("evaluated"));})()',
  ])('refuses a converted Symbol or an evaluated throwing argument: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });
});
