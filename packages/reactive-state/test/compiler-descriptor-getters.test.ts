import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Conversion executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('descriptor-getters', 'DescriptorGetters');

/** Descriptor conversion invokes getters, after keys and all argument expressions are evaluated. */
describe('written descriptor getters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.defineProperty({},"x",{get enumerable(){throw new Error("bad");}})',
    'Object.defineProperty({},"x",{get configurable(){throw new Error("bad");}})',
    'Object.defineProperty({},"x",{get value(){throw new Error("bad");}})',
    'Object.defineProperty({},"x",{get writable(){throw new Error("bad");}})',
    'Object.defineProperty({},"x",{get get(){throw new Error("bad");}})',
    'Object.defineProperty({},"x",{get set(){throw new Error("bad");}})',
    'Reflect.defineProperty({},"x",{get enumerable(){throw new Error("bad");}})',
    'Object.defineProperties({},{x:{get enumerable(){throw new Error("bad");}}})',
    'Object.create(null,{x:{get value(){throw new Error("bad");}}})',
    '(()=>{const descriptor={get enumerable(){throw new Error("bad");}};return Object.defineProperty({},"x",descriptor);})()',
    'Object.defineProperties({},{a:{value:1},b:{get value(){throw new Error("bad");}}})',
    'Object.defineProperty({},"x",{get enumerable(){throw new Error("bad");},set enumerable(value){void value;}})',
  ])('refuses a necessarily throwing descriptor conversion: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.defineProperty({},"x",{get other(){throw new Error("unused");},value:first})',
    'Object.defineProperty({},"x",{get enumerable(){throw new Error("overwritten");},enumerable:true,value:first})',
    'Object.defineProperty({},"x",{get enumerable(){throw new Error("overwritten");},enumerable:true,set enumerable(value){void value;}})',
    'Object.defineProperty({},"x",{get enumerable(){return true;},set enumerable(value){void value;},value:first})',
    'Object.defineProperty({},"x",{get(){throw new Error("deferred");}})',
    '(()=>{try{return Object.defineProperty({},"x",{get enumerable(){throw new Error("caught");}});}catch{return first;}})()',
    'false&&Object.defineProperty({},"x",{get enumerable(){throw new Error("skipped");}})',
    '(()=>Object.defineProperty({},"x",{get enumerable(){throw new Error("deferred");}}))',
    '(()=>{const descriptor={get enumerable(){Object.defineProperty(descriptor,"configurable",{value:true});return true;},get configurable(){throw new Error("repaired");}};return Object.defineProperty({},"x",descriptor);})()',
    '(()=>{const descriptor={get enumerable(){throw new Error("repaired");}};const key={toString(){Object.defineProperty(descriptor,"enumerable",{value:true});return "x";}};return Object.defineProperty({},key as never,descriptor);})()',
    '(()=>{const descriptor={get enumerable(){throw new Error("repaired");}};return Object.defineProperty({},"x",descriptor,Object.defineProperty(descriptor,"enumerable",{value:true}));})()',
    '(()=>{const descriptor={get enumerable(){throw new Error("repaired");}};return Object.defineProperties({},{get x(){Object.defineProperty(descriptor,"enumerable",{value:true});return descriptor;}});})()',
    '(()=>{const descriptor={get enumerable(){throw new Error("replaced");}};Object.defineProperty(descriptor,"enumerable",{value:true});return Object.defineProperty({},"x",descriptor);})()',
    '(()=>{const object=Object;object.defineProperty=(()=>first) as never;return object.defineProperty({},"x",{get enumerable(){throw new Error("unused");}});})()',
    'Object.defineProperty({},"x",(first||{}) as never)',
    'Object.defineProperties({},{x:{value:first,enumerable:true}})',
    '(()=>{const original=Object.defineProperty;try{Object.defineProperty=(()=>({})) as never;return(()=>Object.defineProperty({},"x",{get value(){throw new Error("nested repair");}}))();}finally{Object.defineProperty=original;}})()',
  ])('keeps unused, overwritten, uncertain and handled getters: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
