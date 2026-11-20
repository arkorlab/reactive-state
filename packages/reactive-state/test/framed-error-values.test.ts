import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Source-written assertions, transparent wrappers and synchronous local factory results. */
describe('written error values', () => {
  it.each([
    {
      name: 'as assertion',
      source: 'function frames(value: unknown) { return (value as Error).stack; }',
      framed: true,
    },
    {
      name: 'angle assertion',
      source: 'function frames(value: unknown) { return (<Error>value).stack; }',
      framed: true,
    },
    {
      name: 'asserted alias',
      source:
        'type Failure = Error; function frames(value: unknown) { return (value as Failure).stack; }',
      framed: true,
    },
    {
      name: 'asserted nested member',
      source: 'function frames(value: unknown) { return (value as {error: Error}).error.stack; }',
      framed: true,
    },
    {
      name: 'asserted wrapper',
      source: 'function frames(value: unknown) { return ((value as Error)!).stack; }',
      framed: true,
    },
    {
      name: 'asserted destructuring',
      source: 'function frames(value: unknown) { const {stack} = value as Error; return stack; }',
      framed: true,
    },
    {
      name: 'caught parenthesized initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = (error); return message; } }',
      framed: true,
    },
    {
      name: 'caught nonnull initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = error!; return message; } }',
      framed: true,
    },
    {
      name: 'caught asserted initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = error as Error; return message; } }',
      framed: true,
    },
    {
      name: 'created wrapped stack',
      source:
        'function frames() { const error = new Error("ours"); const {stack} = (error); return stack; }',
      framed: true,
    },
    {
      name: 'arrow IIFE result',
      source: 'function frames() { return (() => new Error("ours"))().stack; }',
      framed: true,
    },
    {
      name: 'function IIFE result',
      source:
        'function frames() { return (function() { return new TypeError("ours"); })().stack; }',
      framed: true,
    },
    {
      name: 'local declaration result',
      source:
        'function make() { return new Error("ours"); } function frames() { return make().stack; }',
      framed: true,
    },
    {
      name: 'local arrow result',
      source: 'const make = () => new Error("ours"); function frames() { return make().stack; }',
      framed: true,
    },
    {
      name: 'local factory alias',
      source:
        'function make() { return new Error("ours"); } const factory = make; function frames() { return factory().stack; }',
      framed: true,
    },
    {
      name: 'local result alias',
      source:
        'function make() { const result = new Error("ours"); return result; } function frames() { const result = make(); return result.stack; }',
      framed: true,
    },
    {
      name: 'nested factory result',
      source:
        'function make() { return new Error("ours"); } function outer() { return make(); } function frames() { return outer().stack; }',
      framed: true,
    },
    {
      name: 'factory shadow native name',
      source:
        'function frames() { function make() { return new TypeError("ours"); } return make().stack; }',
      framed: true,
    },
    {
      name: 'plain asserted stack',
      source: 'function frames(value: unknown) { return (value as {stack: string}).stack; }',
      framed: false,
    },
    {
      name: 'local error type shadow',
      source:
        'type Error = {stack:string}; function frames(value: unknown) { return (value as Error).stack; }',
      framed: false,
    },
    {
      name: 'wrapped ordinary data',
      source:
        'function frames() { const value = {stack:"data"}; const {stack} = (value!); return stack; }',
      framed: false,
    },
    {
      name: 'IIFE ordinary data',
      source: 'function frames() { return (() => ({stack:"data"}))().stack; }',
      framed: false,
    },
    {
      name: 'factory ordinary data',
      source:
        'function make() { return {stack:"data"}; } function frames() { return make().stack; }',
      framed: false,
    },
    {
      name: 'factory lexical shadow',
      source:
        'function make() { return new Error("ours"); } function frames() { const make = () => ({stack:"data"}); return make().stack; }',
      framed: false,
    },
    {
      name: 'async factory boundary',
      source:
        'async function make() { return new Error("ours"); } function frames() { return (make() as unknown as {stack:string}).stack; }',
      framed: false,
    },
    {
      name: 'generator factory boundary',
      source:
        'function* make() { return new Error("ours"); } function frames() { return (make() as unknown as {stack:string}).stack; }',
      framed: false,
    },
    {
      name: 'recursive factory termination',
      source:
        'function make(): never { return make(); } function frames() { return (make() as unknown as {stack:string}).stack; }',
      framed: false,
    },
    {
      name: 'unreachable constructor result',
      source:
        'function make() { return {stack:"data"}; return new Error("ours"); } function frames() { return make().stack; }',
      framed: false,
    },
    {
      name: 'created asserted words',
      source: 'function frames() { return (new Error("ours") as Error).message; }',
      framed: false,
    },
    {
      name: 'factory written words',
      source:
        'function make() { return new Error("ours"); } function frames() { return make().message; }',
      framed: false,
    },
    {
      name: 'typed factory written words',
      source:
        'function make(): Error { return new Error("ours"); } function frames() { return String(make()); }',
      framed: false,
    },
    {
      name: 'asserted factory written words',
      source:
        'function make() { return new Error("ours"); } function frames() { return (make() as Error).message; }',
      framed: false,
    },
    {
      name: 'case factory result',
      source:
        'function frames(flag: boolean) { switch(flag) { case true: function make() { return new Error("ours"); } return make().stack; default: return "data"; } }',
      framed: true,
    },
    {
      name: 'case asserted alias',
      source:
        'function frames(value: unknown, flag: boolean) { switch(flag) { case true: const error = value as Error; return error.stack; default: return "data"; } }',
      framed: true,
    },
    {
      name: 'case factory data shadow',
      source:
        'function make() { return new Error("ours"); } function frames(flag: boolean) { switch(flag) { case true: const make = () => ({stack:"data"}); return make().stack; default: return "data"; } }',
      framed: false,
    },
    {
      name: 'hoisted factory data shadow',
      source:
        'function make() { return new Error("ours"); } function frames() { { var make = () => ({stack:"data"}); } return make().stack; }',
      framed: false,
    },
    {
      name: 'reassigned factory parameter words',
      source:
        'function frames(error: Error) { function make() { return new Error("fixed"); } make = () => error; return (make() as Error).message; }',
      framed: true,
    },
    {
      name: 'reassigned factory caught words',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { function make() { return new Error("fixed"); } make = () => error as Error; return (make() as Error).message; } }',
      framed: true,
    },
    {
      name: 'destructured factory reassignment',
      source:
        'function frames(error: Error) { function make() { return new Error("fixed"); } ({make} = {make: () => error}); return (make() as Error).message; }',
      framed: true,
    },
    {
      name: 'loop factory reassignment',
      source:
        'function frames(error: Error) { function make() { return new Error("fixed"); } for (make of [() => error]) {} return (make() as Error).message; }',
      framed: true,
    },
    {
      name: 'reassigned factory plain data',
      source:
        'function frames() { function make() { return new Error("fixed"); } make = () => ({name:"data",message:"data"}); return make().message; }',
      framed: false,
    },
    {
      name: 'reassigned factory own words',
      source:
        'function frames() { function make() { return {name:"data",message:"data"}; } make = () => new Error("ours"); return make().message; }',
      framed: false,
    },
    {
      name: 'unchanged factory repeated words',
      source:
        'function frames() { function make() { return new Error("ours"); } const first = (make() as Error).message; return first + (make() as Error).message; }',
      framed: false,
    },
    {
      name: 'other lexical factory reassignment',
      source:
        'function frames() { function make() { return new Error("ours"); } { let make = () => ({message:"data"}); make = () => ({message:"next"}); } return (make() as Error).message; }',
      framed: false,
    },
  ])('$name', ({ source, framed }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-values.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
