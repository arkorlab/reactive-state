import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority invokes the method before receiving a trailing JSON string. */
const fixture = stateFixture('object-prototype-calls', 'ObjectPrototypeCalls');

/** Generic Object methods retain nullish receiver and legacy accessor callback requirements. */
describe('written Object prototype calls', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.prototype.hasOwnProperty.call(null,"x")',
    'Object.prototype.valueOf.call(undefined)',
    'Object.prototype.propertyIsEnumerable.apply(null,["x"])',
    'Object.prototype.__lookupGetter__.call(undefined,"x")',
    'Object.prototype.__lookupSetter__.call(null,"x")',
    'Object.prototype.toLocaleString.call(null)',
    'Object.prototype.__defineGetter__.call({},"x",1)',
    'Object.prototype.__defineSetter__.call({},"x",null)',
    'Object.prototype.__defineGetter__.apply({},["x",undefined])',
    'Reflect.apply(Object.prototype.__defineSetter__,{},["x","bad"])',
    '({}).__defineGetter__("x",1)',
    '({}).__defineSetter__("x",null)',
  ])('refuses a necessarily invalid native Object invocation: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.prototype.toString.call(null)',
    'Object.prototype.toString.call(undefined)',
    'Object.prototype.isPrototypeOf.call(null,1)',
    'Object.prototype.valueOf.call(1)',
    'Object.prototype.__defineGetter__.call({},"x",()=>first)',
    'Object.prototype.__defineSetter__.call({},"x",()=>{})',
    'Object.prototype.__defineGetter__.call({},"x",class {})',
    '({__defineGetter__(){return first;}}).__defineGetter__("x",1)',
    '(()=>{const target={};target.__defineGetter__=(()=>first) as never;return target.__defineGetter__("x",1);})()',
    '(()=>{const proto=Object.prototype;proto.hasOwnProperty=(()=>true) as never;return Object.prototype.hasOwnProperty.call(null,"x");})()',
    '(()=>{Object.prototype.__defineGetter__=(()=>first) as never;return Object.prototype.__defineGetter__.call({},"x",1);})()',
    '(()=>{try{return Object.prototype.__defineGetter__.call({},"x",1);}catch{return first;}})()',
    'false&&Object.prototype.__defineGetter__.call({},"x",1)',
    '(()=>Object.prototype.__defineGetter__.call({},"x",1))',
    'Object.prototype.hasOwnProperty.call(first,"x")',
    'Object.prototype.__lookupGetter__.call({},"x")',
  ])('keeps valid, custom, changed, unknown and deferred calls: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
