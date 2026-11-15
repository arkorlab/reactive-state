import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Unknown property selections retain a source-known error, with finite safe keys left intact. */
describe('computed selections of known errors', () => {
  it.each([
    {
      name: 'typed conditional stack choice',
      source:
        'function frames(error: Error, flag: boolean) { return error[flag ? "stack" : "name"]; }',
      refused: true,
    },
    {
      name: 'typed arbitrary property parameter',
      source: 'function frames(error: Error, key: keyof Error) { return error[key]; }',
      refused: true,
    },
    {
      name: 'caught conditional stack choice',
      source:
        'function frames(flag: boolean) { try { JSON.parse("bad"); } catch(error) { return error[flag ? "stack" : "message"]; } }',
      refused: true,
    },
    {
      name: 'wrapped typed receiver',
      source:
        'function frames(value: unknown, flag: boolean) { return ((value as Error)!)[flag ? "stack" : "name"]; }',
      refused: true,
    },
    {
      name: 'nested declared error',
      source:
        'function frames(box: {error: Error}, flag: boolean) { return box.error[flag ? "stack" : "name"]; }',
      refused: true,
    },
    {
      name: 'generic nested declared error',
      source:
        'type Box<T> = {error:T}; function frames(box: Box<Error>, flag: boolean) { return box.error[flag ? "stack" : "name"]; }',
      refused: true,
    },
    {
      name: 'computed destructured initializer',
      source:
        'function frames(error: Error, key: keyof Error) { const {[key]: value} = error; return value; }',
      refused: true,
    },
    {
      name: 'computed typed parameter binding',
      source: 'function frames({[key]: value}: Error, key: keyof Error) { return value; }',
      refused: true,
    },
    {
      name: 'nested computed typed binding',
      source:
        'function frames({error: {[key]: value}}: {error: Error}, key: keyof Error) { return value; }',
      refused: true,
    },
    {
      name: 'nested computed initialized binding',
      source:
        'function frames(box: {error: Error}, key: keyof Error) { const {error: {[key]: value}} = box; return value; }',
      refused: true,
    },
    {
      name: 'tuple nested computed initialized binding',
      source:
        'function frames(box: {errors: [Error]}, key: keyof Error) { const {errors: [{[key]: value}]} = box; return value; }',
      refused: true,
    },
    {
      name: 'computed caught binding',
      source:
        'function frames(flag: boolean) { const key = flag ? "stack" : "message"; try { JSON.parse("bad"); } catch({[key]: value}) { return value; } }',
      refused: true,
    },
    {
      name: 'wrapped caught initializer binding',
      source:
        'function frames(flag: boolean) { try { JSON.parse("bad"); } catch(error) { const {[flag ? "stack" : "name"]: value} = ((error as Error)!); return value; } }',
      refused: true,
    },
    {
      name: 'constructed conditional stack choice',
      source:
        'function frames(flag: boolean) { return new Error("ours")[flag ? "stack" : "message"]; }',
      refused: true,
    },
    {
      name: 'constructed local factory choice',
      source:
        'function make() { return new Error("ours"); } function frames(flag: boolean) { return make()[flag ? "stack" : "message"]; }',
      refused: true,
    },
    {
      name: 'declared mutable stack key',
      source: 'function frames(error: Error) { var key: "stack" = "stack"; return error[key]; }',
      refused: true,
    },
    {
      name: 'unknown key retains possible stack',
      source: 'function frames(error: Error, key: string) { return error[key as keyof Error]; }',
      refused: true,
    },
    {
      name: 'ordinary dynamic data',
      source:
        'function frames(error: Record<string, string>, flag: boolean) { return error[flag ? "stack" : "name"]; }',
      refused: false,
    },
    {
      name: 'shadowed Error type data',
      source:
        'type Error = {stack:string;name:string}; function frames(error: Error, flag: boolean) { return error[flag ? "stack" : "name"]; }',
      refused: false,
    },
    {
      name: 'shadowed Error constructor data',
      source:
        'class Error { stack="fixed"; name="data"; } function frames(flag: boolean) { return new Error()[flag ? "stack" : "name"]; }',
      refused: false,
    },
    {
      name: 'nearer caught binding data',
      source:
        'function frames(flag: boolean) { try { JSON.parse("bad"); } catch(error) { { const error = {stack:"fixed",name:"data"}; return error[flag ? "stack" : "name"]; } } }',
      refused: false,
    },
    {
      name: 'constant safe name key',
      source: 'const key = "name"; function frames(error: Error) { return error[key]; }',
      refused: false,
    },
    {
      name: 'written safe literal key parameter',
      source: 'function frames(error: Error & {data:string}, key: "data") { return error[key]; }',
      refused: false,
    },
    {
      name: 'written safe literal union parameter',
      source:
        'function frames(error: Error & {data:string}, key: "data" | "name") { return error[key]; }',
      refused: false,
    },
    {
      name: 'safe conditional key names',
      source:
        'function frames(error: Error & {data:string}, flag: boolean) { return error[flag ? "data" : "name"]; }',
      refused: false,
    },
    {
      name: 'written safe mutable key',
      source:
        'function frames(error: Error & {data:string}) { var key: "data" = "data"; return error[key]; }',
      refused: false,
    },
    {
      name: 'constructed literal message',
      source: 'function frames() { return new Error("ours")["message"]; }',
      refused: false,
    },
    {
      name: 'constructed safe conditional words',
      source:
        'function frames(flag: boolean) { return new Error("ours")[flag ? "message" : "name"]; }',
      refused: false,
    },
    {
      name: 'constructed safe written key union',
      source: 'function frames(key: "message" | "name") { return new Error("ours")[key]; }',
      refused: false,
    },
    {
      name: 'constructed safe computed binding',
      source:
        'function frames(flag: boolean) { const {[flag ? "message" : "name"]: value} = new Error("ours"); return value; }',
      refused: false,
    },
    {
      name: 'nested ordinary data binding',
      source:
        'function frames(box: {error: {stack:string;name:string}}, key: "stack" | "name") { const {error: {[key]: value}} = box; return value; }',
      refused: false,
    },
    {
      name: 'opaque receiver remains unclassified',
      source: 'function frames(error: any, key: string) { return error[key]; }',
      refused: false,
    },
    {
      name: 'const annotation cannot hide conditional stack',
      source:
        'function frames(error: Error, flag: boolean) { const key: "name" = flag ? "stack" as "name" : "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'const annotation cannot hide aliased conditional stack',
      source:
        'function frames(error: Error, flag: boolean) { const raw = flag ? "stack" : "name"; const key: "name" = raw as "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'written safe mutable reassignment',
      source:
        'function frames(error: Error & {data:string}) { let key: "data" | "name" = "name"; key = "data"; return error[key]; }',
      refused: false,
    },
    {
      name: 'hoisted written safe key before initializer',
      source:
        'const key="stack"; function frames(error: Error & {data:string}) { const value = error[key]; { var key: "data" = "data"; } return value; }',
      refused: false,
    },
    {
      name: 'written safe loop var key',
      source:
        'const key="stack"; function frames(error: Error & {data:string}) { for(var key: "data" = "data"; false;) {} return error[key]; }',
      refused: false,
    },
    {
      name: 'written safe static block var key',
      source:
        'const key="stack"; function frames() { class Holder { static result=""; static { { var key: "data" = "data"; } const error: Error & {data:string} = Object.assign(new Error("ours"), {data:"fixed"}); Holder.result = error[key]; } } return Holder.result; }',
      refused: false,
    },
    {
      name: 'written safe inner let key shadow',
      source:
        'const key="stack"; function frames(error: Error) { let key: "name" = "name"; return error[key]; }',
      refused: false,
    },
    {
      name: 'written safe switch let key shadow',
      source:
        'const key="stack"; function frames(error: Error) { switch(true) { default: let key: "name" = "name"; return error[key]; } }',
      refused: false,
    },
    {
      name: 'Reflect literal stack',
      source: 'function frames(error: Error) { return Reflect.get(error, "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect bracket get stack',
      source: 'function frames(error: Error) { return Reflect["get"](error, "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect global qualified stack',
      source: 'function frames(error: Error) { return globalThis.Reflect.get(error, "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect constant key stack',
      source:
        'function frames(error: Error) { const key="stack"; return Reflect.get(error, key); }',
      refused: true,
    },
    {
      name: 'Reflect conditional key stack',
      source:
        'function frames(error: Error, flag: boolean) { return Reflect.get(error, flag ? "stack" : "name"); }',
      refused: true,
    },
    {
      name: 'Reflect unknown key stack',
      source: 'function frames(error: Error, key: keyof Error) { return Reflect.get(error, key); }',
      refused: true,
    },
    {
      name: 'Reflect nested typed error stack',
      source: 'function frames(box: {error:Error}) { return Reflect.get(box.error, "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect caught engine words',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return Reflect.get(error as Error, "message"); } }',
      refused: true,
    },
    {
      name: 'Reflect constructed error stack',
      source: 'function frames() { return Reflect.get(new Error("ours"), "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect wrapped error stack',
      source: 'function frames(value: unknown) { return Reflect.get((value as Error)!, "stack"); }',
      refused: true,
    },
    {
      name: 'Reflect ordinary data stack',
      source: 'function frames(value: {stack:string}) { return Reflect.get(value, "stack"); }',
      refused: false,
    },
    {
      name: 'Reflect local own get implementation',
      source:
        'function frames(error: Error) { const Reflect={get(_value: unknown, key: string) {return key;}}; return Reflect.get(error, "stack"); }',
      refused: false,
    },
    {
      name: 'Reflect parameter own get implementation',
      source:
        'function frames(error: Error, Reflect: {get(value:unknown,key:string):string}) { return Reflect.get(error, "stack"); }',
      refused: false,
    },
    {
      name: 'Reflect local global object shadow',
      source:
        'function frames(error: Error) { const globalThis={Reflect:{get(_value: unknown, key: string) {return key;}}}; return globalThis.Reflect.get(error, "stack"); }',
      refused: false,
    },
    {
      name: 'Reflect source written error message',
      source: 'function frames() { return Reflect.get(new Error("ours"), "message"); }',
      refused: false,
    },
    {
      name: 'Reflect safe literal name',
      source: 'function frames(error: Error) { return Reflect.get(error, "name"); }',
      refused: false,
    },
    {
      name: 'Reflect safe written key union',
      source:
        'function frames(error: Error & {data:string}, key: "name" | "data") { return Reflect.get(error, key); }',
      refused: false,
    },
    {
      name: 'Reflect safe conditional key union',
      source:
        'function frames(error: Error & {data:string}, flag: boolean) { return Reflect.get(error, flag ? "name" : "data"); }',
      refused: false,
    },
    {
      name: 'Reflect shadowed Error data type',
      source:
        'type Error={stack:string}; function frames(error:Error) { return Reflect.get(error, "stack"); }',
      refused: false,
    },
    {
      name: 'Reflect unrelated own get implementation',
      source:
        'function frames(error:Error) { const own={get(_value: unknown, key:string){return key;}}; return own.get(error, "stack"); }',
      refused: false,
    },
  ])('$name', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'computed-errors.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});
