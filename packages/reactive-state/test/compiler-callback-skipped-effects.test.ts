import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards the replacement result before the authority starts its JSON state. */
const fixture = stateFixture('callback-skipped-effects', 'CallbackSkippedEffects');

/** Known skipped and deferred prefixes do not repair callbacks invoked later. */
describe('skipped callback prefix effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(false&&(globalThis.decodeURIComponent=()=>"ok"),(()=>{globalThis.decodeURIComponent=()=>"ok";}),+1,"a".replace("a",()=>decodeURIComponent("%")))',
  ])('refuses a called failure after a skipped repair: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const original=decodeURIComponent;try{return(true&&(globalThis.decodeURIComponent=()=>"ok"),"a".replace("a",()=>decodeURIComponent("%")));}finally{globalThis.decodeURIComponent=original;}})()',
    '(()=>{const flag=false;const original=decodeURIComponent;try{return((flag:boolean)=>(flag&&(globalThis.decodeURIComponent=()=>"ok"),"a".replace("a",()=>decodeURIComponent("%"))))(true);}finally{globalThis.decodeURIComponent=original;}})()',
  ])('keeps executed repairs and unproven lexical selectors: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
