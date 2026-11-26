import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the call before receiving the trailing JSON string. */
const fixture = stateFixture('tdz-reads', 'TdzReads');

/** Source-proven synchronous lexical reads respect their declaration initialization order. */
describe('written synchronous TDZ reads', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "(()=>{const value=read();const later='ok';function read(){return later;}return value;})()",
    "(()=>{const value=read();let later='ok';function read(){return later;}return value;})()",
    "(()=>{const read=function(){return later;};const value=read();const later='ok';return value;})()",
    "(()=>{const read=()=>later;const value=read();const later='ok';return value;})()",
    "(()=>{const invoke=read;const value=invoke();const later='ok';function read(){return later;}return value;})()",
    "(()=>{const value=read();class Later{}function read(){return Later;}return 'ok';})()",
    "(()=>{const value=read();function read(){return value;}return 'ok';})()",
    "(()=>{return later;const later='ok';})()",
  ])('refuses a proven synchronous lexical TDZ read: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "(()=>{const later='ok';const value=read();function read(){return later;}return value;})()",
    "(()=>{const value=read();var later='ok';function read(){return later;}return value;})()",
    "(()=>{function read(){return later;}const later='ok';return 'ok';})()",
    "(()=>{const read=()=>later;const later='ok';return 'ok';})()",
    "(()=>{function read(){return later;}const invoke=()=>read();const later='ok';return invoke();})()",
    "(()=>{const value=read('given');const later='ok';function read(later:string){return later;}return value;})()",
    "(()=>{try{const value=read();const later='ok';function read(){return later;}return value;}catch{return 'ok';}})()",
    "(()=>{const value=false&&read();const later='ok';function read(){return later;}return value;})()",
  ])('keeps initialized hoisted shadowed and unevaluated reads: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
