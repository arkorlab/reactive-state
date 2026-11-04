import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The membership expression runs before a discarded result becomes a JSON string. */
const fixture = stateFixture('function-instanceof', 'FunctionInstanceOf');

/** Function values are objects for OrdinaryHasInstance's prototype validation. */
describe('function-valued instanceof left operands', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '((()=>0) instanceof (()=>0) as never)',
    '((function(){}) instanceof (()=>0) as never)',
    '((async function(){}) instanceof (()=>0) as never)',
    '((function*(){}) instanceof (()=>0) as never)',
    '((class{}) instanceof (()=>0) as never)',
    '(()=>{const value=()=>0;return value instanceof (()=>0) as never;})()',
    '(()=>{function value(){}return value instanceof (()=>0) as never;})()',
    '((function(value=(()=>0)()){return value;}) instanceof (()=>0) as never)',
  ])('refuses an object function against a missing prototype: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(1 instanceof (()=>0) as never)',
    '((()=>0) instanceof Function)',
    '((()=>0) instanceof (function*(){}) as never)',
    '((()=>0) instanceof (class{}))',
    '((class{}) instanceof Function)',
    '((()=>0) instanceof ({[Symbol.hasInstance](){return true;}} as never))',
    "(()=>{const target=()=>0;Object.defineProperty(target,'prototype',{value:{}});return(()=>0) instanceof target;})()",
    "(()=>{const target=()=>0;return(class{static{Object.defineProperty(target,'prototype',{value:{}});}}) instanceof target;})()",
    "(()=>{const target=()=>0;return(class{[(Object.defineProperty(target,'prototype',{value:{}}),'key')](){}}) instanceof target;})()",
    "(()=>{const target=()=>0;return(class extends(Object.defineProperty(target,'prototype',{value:{}}),Object){}) instanceof target;})()",
    "(()=>{const target=()=>0;return(class{static repaired=Object.defineProperty(target,'prototype',{value:{}});}) instanceof target;})()",
    '(()=>{try{return(()=>0) instanceof (()=>0) as never;}catch{return first;}})()',
    'false&&((()=>0) instanceof (()=>0) as never)',
    '(()=>((()=>0) instanceof (()=>0) as never))',
  ])('keeps ordinary targets, class evaluation and deferred boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
