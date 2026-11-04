import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native array spread expands before the yielded elements are serialized. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-spread-ignores-source-hook',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-supplied-message',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["message"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'global-native-assign',
    source:
      'function frames(error:Error){return JSON.stringify([...globalThis.Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-whole-alias',
    source:
      'function frames(error:Error){const assign=Object.assign;return JSON.stringify([...assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'source-whole-alias',
    source:
      'function frames(error:Error){const source=Object.assign([error],{toJSON(){return "fixed";}});return JSON.stringify([...source],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'source-alias-chain',
    source:
      'function frames(error:Error){const source=Object.assign([error],{toJSON(){return "fixed";}});const saved=source;return JSON.stringify([...saved],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'target-whole-alias',
    source:
      'function frames(error:Error){const source=[error];return JSON.stringify([...Object.assign(source,{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-target-mutators',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign(Object.assign([error],{toJSON(){return "fixed";}}),{extra:1})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-spread-only',
    source:
      'function frames(error:Error){return JSON.stringify([...[...Object.assign([error],{toJSON(){return "fixed";}})]],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'source-data-tojson',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([{stack:"fixed"}],{toJSON(){return error;}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-empty-tojson',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([],{toJSON(){return error;}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-noncallable-tojson',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{toJSON:0})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defined-source-hook',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.defineProperty([error],"toJSON",{value(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-defined-source-hook',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.defineProperties([error],{toJSON:{value(){return "fixed";}}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'descriptor-getter-not-read',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.defineProperty([error],"toJSON",{get(){return()=>"fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-element-hook-retained',
    source:
      'function frames(error:Error){return JSON.stringify([Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ordinary-element-return-error',
    source:
      'function frames(error:Error){return JSON.stringify([Object.assign([0],{toJSON(){return error;}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-element-hook-retained',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([Object.assign([error],{toJSON(){return "fixed";}})],{toJSON(){return error;}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'plain-spread-sensitive-pin',
    source: 'function frames(error:Error){return JSON.stringify([...[error]],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-data-spread-pin',
    source:
      'function frames(error:Error){return JSON.stringify([...[{stack:"fixed"}]],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-hole-keeps-next-element',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([,error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-call',
    source:
      'function frames(error:Error){return JSON.stringify.call(null,[...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-apply',
    source:
      'function frames(error:Error){return JSON.stringify.apply(null,[[...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-reflect',
    source:
      'function frames(error:Error){return Reflect.apply(JSON.stringify,null,[[...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-alias',
    source:
      'function frames(error:Error){const stringify=JSON.stringify;return stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-source-slot-replaced',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{0:{stack:"fixed"},toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-length-truncated',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{length:0,toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-custom-iterator-data',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{*[Symbol.iterator](){yield{stack:"fixed"};},toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-source-slot-write',
    source:
      'function frames(error:Error){const source=Object.assign([error],{toJSON(){return "fixed";}});source[0]={stack:"fixed"} as Error;return JSON.stringify([...source],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-error-words-replaced',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return JSON.stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'captured-prepare-replaces-words',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return JSON.stringify([...Object.assign([value],{toJSON(){return "fixed";}})],["stack"]);}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'runtime-tail-replaces-words',
    source:
      'function frames(error:Error){return(JSON.stringify as(...args:unknown[])=>string)([...Object.assign([error],{toJSON(){return "fixed";}})],["stack"],0,Object.assign(error,{stack:"fixed"}));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'excluded-field-keeps-data',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["other"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-json-shadow',
    source:
      'function frames(error:Error){const JSON={stringify(_value:unknown,_keys:readonly string[]){return "fixed";}};return JSON.stringify([...Object.assign([error],{toJSON(){return "fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unknown-head-serialization-rewrites',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return JSON.stringify([...Object.assign([head,value],{toJSON(){return"fixed";}})],["stack"]);}return collect(error,{toJSON(){Object.assign(error,{stack:"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-sibling-hook-rewrites',
    source:
      'function frames(error:Error){return JSON.stringify([{toJSON(){Object.assign(error,{stack:"fixed"});return 0;}},...Object.assign([error],{toJSON(){return"fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'earlier-yielded-hook-rewrites',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([{toJSON(){Object.assign(error,{stack:"fixed"});return 0;}},error],{toJSON(){return"fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'yielded-own-hook-keeps-error',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([{toJSON(){return error;}}],{toJSON(){return"fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quiet-sibling-keeps-later-error',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.assign([{toJSON(){return"fixed";}},error],{toJSON(){return"fixed";}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unread-source-hook-can-throw',
    source:
      'function frames(error:Error){return JSON.stringify([...Object.defineProperty([error],"toJSON",{get(){throw new Error("unused");}})],["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('spread JSON element readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'defined-accessors.ts', source);
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

describe('shared spread JSON element admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
