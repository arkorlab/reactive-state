import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the call before receiving the trailing JSON string. */
const fixture = stateFixture('entry-keys', 'EntryKeys');

/** Entry keys undergo native property-key conversion before the result is returned. */
describe('written Object.fromEntries key conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.fromEntries([[Object.create(null) as any, 1]])',
    'Object.fromEntries([[{__proto__:null} as any, 1]])',
    'Object.fromEntries([[{__proto__:null, id:1} as any, 1]])',
    '(()=>{const key=Object.create(null);return Object.fromEntries([[key,1]]);})()',
    '(()=>{const entries=[[Object.create(null),1]];return Object.fromEntries(entries);})()',
    "globalThis.Object['fromEntries']([[Object.create(null) as any, 1]])",
  ])('refuses source-proven unconvertible entry keys: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.fromEntries([[{},1]])',
    "Object.fromEntries([[Symbol('key'),1]])",
    'Object.fromEntries([[1,1]])',
    "Object.fromEntries([[{__proto__:null,toString(){return 'x';}},1]])",
    "(()=>{const key=Object.create(null);key.toString=()=> 'x';return Object.fromEntries([[key,1]]);})()",
    "(()=>{const key=Object.create(null);return Object.fromEntries([[key,(key.toString=()=> 'x',1)]]);})()",
    "Object.fromEntries([[Object.create(null,{toString:{value:()=> 'x'}}),1]])",
    "(()=>{const key=Object.create(null);const entries=[[key,(key.toString=()=> 'x',1)]];return Object.fromEntries(entries);})()",
    "(()=>{const key=Object.create(null);const pair=[key,(key.toString=()=> 'x',1)];return Object.fromEntries([pair]);})()",
    "(()=>{const key=Object.create(null);return (Object.fromEntries as Function)([[key,1]],(key.toString=()=> 'x'));})()",
    'Object.fromEntries([])',
    'new Map([[Object.create(null),1]])',
    "(()=>{try{return Object.fromEntries([[Object.create(null),1]]);}catch{return 'ok';}})()",
  ])('keeps native valid keys and conversion effects: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
