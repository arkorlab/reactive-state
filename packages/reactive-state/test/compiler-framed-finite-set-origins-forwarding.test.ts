import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'set-add-values-review',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-keys',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).keys().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-entry-zero',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).entries().next().value![0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-entry-one',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).entries().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-default',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error)[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-supplied-message',
    source:
      'function frames(error:Error){return new Set<{message:string}>().add(error).values().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-first-remains',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).add({stack:"fixed"}).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-constructor-alias',
    source:
      'function frames(error:Error){const Native=globalThis.Set;return new Native<{stack?:string}>().add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-base-alias',
    source:
      'function frames(error:Error){const values=new Set<{stack?:string}>();return values.add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-result-alias',
    source:
      'function frames(error:Error){const values=new Set<{stack?:string}>().add(error);return values.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-borrowed',
    source:
      'function frames(error:Error){return(Set.prototype.add.call(new Set(),error)as Set<{stack?:string}>).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-local-error-stack',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(new Error("fixed")).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-first-data-pin',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>([{stack:"fixed"}]).add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-data-pin',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add({stack:"fixed"}).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-local-message-pin',
    source:
      'function frames(error:Error){return new Set<{message:string}>().add(new Error("fixed")).values().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-own-add-pin',
    source:
      'function frames(error:Error){const values=new Set<{stack?:string}>();values.add=()=>new Set([{stack:"fixed"}]);return values.add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-own-values-pin',
    source:
      'function frames(error:Error){const values=new Set<{stack?:string}>();values.values=()=>[{stack:"fixed"}].values();return values.add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-ignored-tail-rewrites-pin',
    source:
      'function frames(error:Error){return(new Set<{stack?:string}>().add as(...args:unknown[])=>Set<{stack?:string}>)(error,Object.assign(error,{stack:"fixed"})).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-quiet-tail-control',
    source:
      'function frames(error:Error){return(new Set<{stack?:string}>().add as(...args:unknown[])=>Set<{stack?:string}>)(error,0).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-prior-field-write-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return new Set<{stack?:string}>().add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-review',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error])).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-message',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error])).errors[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-second',
    source:
      'function frames(error:Error){return new AggregateError(new Set([{stack:"fixed"},error])).errors[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-key-alias',
    source:
      'function frames(error:Error){const values=new Set([error]);return new AggregateError(values).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-input-alias',
    source:
      'function frames(error:Error){const input=[error];return new AggregateError(new Set(input)).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-add-chain',
    source:
      'function frames(error:Error){return new AggregateError(new Set<Error>().add(error)).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-duplicate-primitives',
    source:
      'function frames(error:Error){return new AggregateError(new Set([0,0,error])).errors[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-array-hole',
    source:
      'function frames(error:Error){return new AggregateError(new Set([,error])).errors[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-local-error-stack',
    source:
      'function frames(error:Error){return new AggregateError(new Set([new Error("fixed")])).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-first-data-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([{stack:"fixed"},error])).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-duplicate-error-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error,error])).errors[1]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-dedup-data-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error,error,{stack:"fixed"}])).errors[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-local-message-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([new Error("fixed")])).errors[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-own-iterator-pin',
    source:
      'function frames(error:Error){const values=new Set<{stack?:string}>([error]);values[Symbol.iterator]=function(){return[{stack:"fixed"}].values();};return new AggregateError(values).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-message-hook-rewrites-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error]),{toString(){Object.assign(error,{stack:"fixed"});return"fixed";}}as unknown as string).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-cause-getter-rewrites-pin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([error]),"fixed",{get cause(){Object.assign(error,{stack:"fixed"});return 0;}}).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-later-carried-write-pin',
    source:
      'function frames(error:Error){const aggregate=new AggregateError(new Set([error]));Object.assign(error,{stack:"fixed"});return aggregate.errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-prior-field-write-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return new AggregateError(new Set([error])).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-local-constructor-pin',
    source:
      'function frames(error:Error){const AggregateError=class{errors=[{stack:"fixed"}];constructor(_input:unknown){}};return new AggregateError(new Set([error])).errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-constructor-tail-rewrites-pin',
    source:
      'function frames(error:Error){return new(Set as new(...args:unknown[])=>Set<{stack?:string}>)([],Object.assign(error,{stack:"fixed"})).add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-iterable-creation-rewrites-pin',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>(Object.assign([],{side:Object.assign(error,{stack:"fixed"})})).add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-next-ignored-tail-rewrites-pin',
    source:
      'function frames(error:Error){return(new Set<{stack?:string}>().add(error).values().next as(...args:unknown[])=>IteratorResult<{stack?:string}>)(Object.assign(error,{stack:"fixed"})).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-next-quiet-tail-control',
    source:
      'function frames(error:Error){return(new Set<{stack?:string}>().add(error).values().next as(...args:unknown[])=>IteratorResult<{stack?:string}>)(0).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-saved-value-original-write-pin',
    source:
      'function frames(error:Error){const selected=new Set<{stack?:string}>().add(error).values().next().value!;Object.assign(error,{stack:"fixed"});return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-saved-value-alias-write-pin',
    source:
      'function frames(error:Error){const selected=new Set<{stack?:string}>().add(error).values().next().value!;Object.assign(selected,{stack:"fixed"});return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-saved-value-opaque-pin',
    source:
      'function frames(error:Error){const selected=new Set<{stack?:string}>().add(error).values().next().value!;return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-saved-errors-write-pin',
    source:
      'function frames(error:Error){const aggregate=new AggregateError(new Set([error]));Object.assign(aggregate.errors[0],{stack:"fixed"});return aggregate.errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-saved-opaque-pin',
    source:
      'function frames(error:Error){const aggregate=new AggregateError(new Set([error]));return aggregate.errors[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-computed-key-rewrites-pin',
    source:
      'function frames(error:Error){return new Set<{stack?:string}>().add(error).values().next().value![(Object.assign(error,{stack:"fixed"}),"stack")];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-spread-message-effect-pin',
    source:
      'function frames(error:Error){return new AggregateError(...([new Set([error]),(Object.assign(error,{stack:"fixed"}),"fixed")]as const)).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-quiet-spread-control',
    source:
      'function frames(error:Error){return new AggregateError(...([new Set([error]),"fixed"]as const)).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-spread-options-effect-pin',
    source:
      'function frames(error:Error){return new AggregateError(...([new Set([error]),"fixed",{get cause(){Object.assign(error,{stack:"fixed"});return 0;}}]as const)).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-spread-quiet-options-opaque-pin',
    source:
      'function frames(error:Error){return new AggregateError(...([new Set([error]),"fixed",{cause:0}]as const)).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-call-quiet-spread-control',
    source:
      'function frames(error:Error){return AggregateError(...([new Set([error]),"fixed"]as const)).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return new Set<{stack?:string}>().add(selected).values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return new Set<{stack?:string}>().add(value).values().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new AggregateError(new Set([value])).errors[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return new AggregateError(new Set([value])).errors[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const selected=value;return new AggregateError(new Set([selected])).errors[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-set-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return new AggregateError(new Set([value])).errors[0]!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-default-effect-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return new AggregateError(new Set([value])).errors[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-pattern-getter-data',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return new AggregateError(new Set([value])).errors[0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-set-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return new AggregateError(new Set([value])).errors[0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-reflect-effect-pin',
    source:
      'function frames(error:Error){return (Reflect.apply as(...args:unknown[])=>Set<{stack?:string}>)(Set.prototype.add,new Set(),[error],Object.assign(error,{stack:"fixed"})).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-reflect-quiet-control',
    source:
      'function frames(error:Error){return (Reflect.apply as(...args:unknown[])=>Set<{stack?:string}>)(Set.prototype.add,new Set(),[error],0).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-apply-effect-pin',
    source:
      'function frames(error:Error){return (Set.prototype.add.apply as(...args:unknown[])=>Set<{stack?:string}>)(new Set(),[error],Object.assign(error,{stack:"fixed"})).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-apply-quiet-control',
    source:
      'function frames(error:Error){return (Set.prototype.add.apply as(...args:unknown[])=>Set<{stack?:string}>)(new Set(),[error],0).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-add-constructor-spread-effect-pin',
    source:
      'function frames(error:Error){return new(Set as new(...args:unknown[])=>Set<{stack?:string}>)(...([[],Object.assign(error,{stack:"fixed"})]as const)).add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-add-constructor-spread-quiet-control',
    source:
      'function frames(error:Error){return new(Set as new(...args:unknown[])=>Set<{stack?:string}>)(...([[],0]as const)).add(error).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
] as const;

describe('native Finite Set origins words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'finite-set-origins-forwarding.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared native Finite Set origins admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
