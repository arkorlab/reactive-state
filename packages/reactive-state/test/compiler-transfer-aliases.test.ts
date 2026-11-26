import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Native cloning rejects repeated transferable identities, including stable lexical aliases. */
describe('source-written transferable identities', () => {
  const { apps, compile } = compilerApplications();
  const fixture = stateFixture('transfer-aliases', 'TransferAliases');

  it.each([
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;return structuredClone('x',{transfer:[buffer,alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const middle=buffer;const alias=middle;return structuredClone('x',{transfer:[buffer,alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const left=buffer;const right=buffer;return structuredClone('x',{transfer:[left,right]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;const transfer=[buffer,alias];const options={transfer};return structuredClone('x',options);})()",
    "(()=>{const Buffer=ArrayBuffer;const buffer=new Buffer(1);const alias=buffer;return structuredClone('x',{transfer:[buffer,alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=(buffer as ArrayBuffer);return structuredClone('x',{transfer:[(buffer),alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);return structuredClone('x',{transfer:[buffer,buffer]});})()",
    "structuredClone('x',{transfer:[1 as never]})",
  ])('refuses a source-proven invalid transfer list: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "(()=>{const left=new ArrayBuffer(1);const right=new ArrayBuffer(1);return structuredClone('x',{transfer:[left,right]});})()",
    "(()=>{const make=()=>new ArrayBuffer(1);const left=make();const right=make();return structuredClone('x',{transfer:[left,right]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);let alias=buffer;alias=new ArrayBuffer(1);return structuredClone('x',{transfer:[buffer,alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;const transfer=[buffer,alias];transfer[1]=new ArrayBuffer(1);return structuredClone('x',{transfer});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;const options={transfer:[buffer,alias]};options.transfer=[];return structuredClone('x',options);})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;const transfer=[buffer,alias];return structuredClone((transfer[1]=new ArrayBuffer(1),'x'),{transfer});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;const transfer=[buffer,alias];return structuredClone('x',{transfer},transfer[1]=new ArrayBuffer(1));})()",
    "(()=>{const saved=structuredClone;const buffer=new ArrayBuffer(1);const alias=buffer;try{globalThis.structuredClone=(()=>first) as never;return structuredClone('x',{transfer:[buffer,alias]});}finally{globalThis.structuredClone=saved;}})()",
    "(()=>{const saved=structuredClone;const buffer=new ArrayBuffer(1);const alias=buffer;try{globalThis.structuredClone=(()=>first) as never;return(()=>structuredClone('x',{transfer:[buffer,alias]}))();}finally{globalThis.structuredClone=saved;}})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;try{return structuredClone('x',{transfer:[buffer,alias]});}catch{return first;}})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;return false&&structuredClone('x',{transfer:[buffer,alias]});})()",
    "(()=>{const buffer=new ArrayBuffer(1);const alias=buffer;return()=>structuredClone('x',{transfer:[buffer,alias]});})()",
  ])('keeps distinct, repaired and deferred identities: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
