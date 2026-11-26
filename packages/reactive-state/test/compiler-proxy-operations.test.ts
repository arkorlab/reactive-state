import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch causes the authority to check the discarded operation before its JSON state. */
const fixture = stateFixture('proxy-operation', 'ProxyOperation');

/** Source-written Proxy traps can throw even when an operation's result is discarded. */
describe('written Proxy operation traps', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.keys(new Proxy({}, {ownKeys(){throw new Error("bad");}}))',
    'Object.values(new Proxy({}, {ownKeys(){throw new Error("bad");}}))',
    'Object.entries(new Proxy({}, {ownKeys(){throw new Error("bad");}}))',
    'Reflect.ownKeys(new Proxy({}, {ownKeys(){throw new Error("bad");}}))',
    'Object.keys(new Proxy({}, {get ownKeys(){throw new Error("bad");}}))',
    'Object.keys(new Proxy({}, {ownKeys:()=>{throw new Error("bad");}}))',
    '"held" in new Proxy({}, {has(){throw new Error("bad");}})',
    'Reflect.has(new Proxy({}, {has(){throw new Error("bad");}}),"held")',
    'delete (new Proxy({}, {deleteProperty(){throw new Error("bad");}}) as Record<string,unknown>).held',
    'Reflect.deleteProperty(new Proxy({}, {deleteProperty(){throw new Error("bad");}}),"held")',
    '(new Proxy({held:""}, {set(){throw new Error("bad");}})).held=first',
    'Reflect.set(new Proxy({}, {set(){throw new Error("bad");}}),"held",first)',
    'Object.keys(new Proxy({}, {get ownKeys(){throw new Error("bad");},set ownKeys(value:unknown){void value;}}))',
  ])('refuses a necessarily invoked synchronous trap: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.keys(new Proxy({}, {ownKeys(){return [];}}))',
    'Object.keys(new Proxy({}, {get(){throw new Error("unused");}}))',
    'Object.keys(new Proxy({}, {ownKeys(){throw new Error("overwritten");},...{ownKeys(){return [];}}}))',
    'Object.keys(new Proxy({}, {set ownKeys(value:unknown){void value;}}))',
    '(()=>{const handler={ownKeys(){throw new Error("changed");}};const proxy=new Proxy({},handler);handler.ownKeys=()=>[];return Object.keys(proxy);})()',
    '(()=>{const handler={ownKeys(){throw new Error("changed");}};const proxy=new Proxy({},handler);return (Object.keys as Function)(proxy,handler.ownKeys=()=>[]);})()',
    '(()=>{try{Object.keys(new Proxy({}, {ownKeys(){throw new Error("caught");}}));}catch{}return first;})()',
    'false&&Object.keys(new Proxy({}, {ownKeys(){throw new Error("skipped");}}))',
    '()=>Object.keys(new Proxy({}, {ownKeys(){throw new Error("deferred");}}))',
    'Object.keys(new Proxy({}, {*ownKeys(){throw new Error("deferred");}}))',
    'new Proxy({}, {ownKeys(){throw new Error("unused");}})',
    '(()=>{const Object={keys(value:unknown){void value;return [];}};return Object.keys(new Proxy({}, {ownKeys(){throw new Error("unused");}}));})()',
    '"held" in new Proxy({held:1}, {has(){return true;}})',
    'Reflect.deleteProperty(new Proxy({held:1}, {deleteProperty(){return true;}}),"held")',
    'Reflect.set(new Proxy({}, {set(){return true;}}),"held",first)',
    '(()=>{const handler={set(){throw new Error("changed");}};const proxy=new Proxy({held:""},handler);return proxy.held=(handler.set=()=>true,first);})()',
    '(()=>{const handler={has(){throw new Error("changed");}};const proxy=new Proxy({},handler);return ({[Symbol.toPrimitive](){handler.has=()=>true;return "held";}} as never) in proxy;})()',
    '(()=>{const handler={deleteProperty(){throw new Error("changed");}};const proxy=new Proxy({},handler);return delete (proxy as Record<string,unknown>)[({[Symbol.toPrimitive](){handler.deleteProperty=()=>true;return "held";}} as never)];})()',
  ])('keeps quiet, changed, unknown, handled and deferred operations: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
