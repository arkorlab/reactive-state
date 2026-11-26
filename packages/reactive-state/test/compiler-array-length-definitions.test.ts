import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The definition result is discarded before the authority selects a JSON state value. */
const fixture = stateFixture('array-length-definitions', 'ArrayLengthDefinitions');

/** ArraySetLength validates values supplied through native property definitions. */
describe('written array length definitions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "Object.defineProperty([], 'length', {value:1.5})",
    "Object.defineProperty([], 'length', {value:-1})",
    "Object.defineProperty([], 'length', {value:2**32})",
    "Object.defineProperty([], 'length', {value:NaN})",
    "Object.defineProperty([], 'length', {value:Infinity})",
    "Object.defineProperty([], 'length', {value:'-1'})",
    "Object.defineProperty([], 'length', {value:undefined})",
    'Object.defineProperties([], {length:{value:1.5}})',
    "(()=>{const list:any[]=[];const descriptor={value:-1};return Object.defineProperty(list,'length',descriptor);})()",
    "Object.defineProperty(Object.seal([]), 'length', {value:0.5})",
  ])('refuses a written invalid array length: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "(()=>{const list:any[]=[];const descriptor={value:-1};descriptor.value=2;return Object.defineProperty(list,'length',descriptor);})()",
    "(()=>{const list:any[]=[];const descriptor={value:-1};return(Object.defineProperty as Function)(list,'length',descriptor,descriptor.value=2);})()",
    "Object.defineProperty([], 'length', {value:first})",
    "(()=>{const native=Object.defineProperty;try{Object.defineProperty=((target:any)=>target) as never;return Object.defineProperty([],'length',{value:-1});}finally{Object.defineProperty=native;}})()",
    "Object.defineProperty([], 'length', {value:0})",
    "Object.defineProperty([], 'length', {value:3})",
    "Object.defineProperty([], 'length', {value:2**32-1})",
    "Object.defineProperty([], 'length', {value:'2'})",
    "Object.defineProperty([], 'length', {value:null})",
    "Object.defineProperty([], 'length', {value:true})",
    "Object.defineProperty([], 'length', {writable:false})",
    "Object.defineProperty({length:0}, 'length', {value:-1})",
    "Object.defineProperty(Object.create([]), 'length', {value:-1})",
    "Reflect.defineProperty([], 'length', {value:2})",
    "(()=>{try{Object.defineProperty([], 'length', {value:-1});}catch{return 'ok';}})()",
    "false&&Object.defineProperty([], 'length', {value:-1})",
    "()=>Object.defineProperty([], 'length', {value:-1})",
    "Object.defineProperty([], 'length', {value:{valueOf(){return 2;}}})",
  ])('keeps valid lengths, ordinary objects and escaping boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
