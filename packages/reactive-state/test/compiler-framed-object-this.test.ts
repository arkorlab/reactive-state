import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A directly invoked literal method keeps its original quiet receiver. */
const CASES = [
  {
    id: 'object-this-immediate-error',
    source:
      'function frames(error:Error){return({error,read(){return this.error.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-renamed-field-error',
    source:
      'function frames(error:Error){return({failure:error,read(){return this.failure.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-nested-field-error',
    source:
      'function frames(error:Error){return({holder:{failure:error},read(){return this.holder.failure.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-bracket-error',
    source:
      'function frames(error:Error){return({error,read(){return this["error"].stack;}})["read"]();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-method-string-name-error',
    source:
      'function frames(error:Error){return({error,"read"(){return this.error.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-local-error-stack',
    source:
      'function frames(){return({failure:new Error("fixed"),read(){return this.failure.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames()',
  },
  {
    id: 'object-this-alias-field-error',
    source:
      'function frames(error:Error){const alias=error;return({failure:alias,read(){return this.failure.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-caught-error',
    source:
      'function frames(){try{throw new Error("ours");}catch(error){return({failure:error as Error,read(){return this.failure.stack;}}).read();}}',
    refused: true,
    reader: true,
    invocation: 'frames()',
  },
  {
    id: 'object-this-quiet-ignored-arg-error',
    source:
      'function frames(error:Error){return({error,read(..._args:unknown[]){return this.error.stack;}}).read(0);}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-explicit-receiver-existing-pin',
    source:
      'function frames(error:Error){return({error,read(this:{error:Error;read:unknown}){return this.error.stack;}}).read();}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-data-field-pin',
    source:
      'function frames(value:{stack:string}){return({value,read(){return this.value.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'object-this-unselected-data-pin',
    source:
      'function frames(error:Error){return({error,data:{stack:"fixed"},read(){return this.data.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-local-message-data-pin',
    source:
      'function frames(){return({failure:new Error("fixed"),read(){return this.failure.message;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames()',
  },
  {
    id: 'object-this-extracted-call-data-pin',
    source:
      'function frames(error:Error){const box={error,read(){return this.error.stack;}};const read=box.read;return read.call({error:{stack:"fixed"}});}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-native-call-data-pin',
    source:
      'function frames(error:Error){return({error,read(){return this.error.stack;}}).read.call({error:{stack:"fixed"}});}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-native-apply-data-pin',
    source:
      'function frames(error:Error){return({error,read(){return this.error.stack;}}).read.apply({error:{stack:"fixed"}},[]);}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-later-method-replacement-pin',
    source:
      'function frames(error:Error){const box={error,read(){return this.error.stack;}};box.read=()=>"fixed";return box.read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-spread-method-replacement-pin',
    source:
      'function frames(error:Error){const override:{read?:()=>string}={read(){return "fixed";}};return({error,read(){return this.error.stack;},...override}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-getter-data-pin',
    source:
      'function frames(error:Error){return({get failure(){return {stack:"fixed"};},read(){return this.failure.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-ignored-arg-mutation-pin',
    source:
      'function frames(error:Error){return({error,read(..._args:unknown[]){return this.error.stack;}}).read(Object.assign(error,{stack:"fixed"}));}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-field-creation-mutation-pin',
    source:
      'function frames(error:Error){return({ignored:Object.assign(error,{stack:"fixed"}),error,read(){return this.error.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-computed-key-mutation-pin',
    source:
      'function frames(error:Error){return({error,read(){return this.error.stack;}})[(Object.assign(error,{stack:"fixed"}),"read")]();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-body-prefix-mutation-pin',
    source:
      'function frames(error:Error){return({error,read(){Object.assign(this.error,{stack:"fixed"});return this.error.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-own-stack-data-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return({error,read(){return this.error.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-this-error-type-shadow-data-pin',
    source:
      'type Error={stack:string};function frames(error:Error){return({error,read(){return this.error.stack;}}).read();}',
    refused: false,
    reader: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'object-this-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return ({value,read(){return this.value.stack;}}).read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{ready:unknown}){prepare.ready;return ({value,read(){return this.value.stack;}}).read();}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-prior-conversion-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:unknown){String(prepare);return ({value,read(){return this.value.stack;}}).read();}return collect(error,{toString(){Object.assign(error,{stack:"fixed"});return "fixed";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-prior-native-keys-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:Record<string,unknown>){Object.keys(prepare);return ({value,read(){return this.value.stack;}}).read();}return collect(error,new Proxy({},{ownKeys(){Object.assign(error,{stack:"fixed"});return [];}}));}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-owner-default-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){return ({value,read(){return this.value.stack;}}).read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return ({value,read(){return this.value.stack;}}).read();}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-quiet-owner-constant',
    source:
      'function frames(error:Error){const label="fixed";return ({error,label,read(){return this.error.stack;}}).read();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'object-this-quiet-native-birth',
    source:
      'function frames(error:Error){const ignored=new Error("fixed");return ({error,ignored,read(){return this.error.stack;}}).read();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'object-this-deferred-body',
    source:
      'function frames(error:Error){function untouched(){Object.assign(error,{stack:"fixed"});}return ({error,read(){return this.error.stack;}}).read();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'object-this-constructor-field-prefix-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){class Read{prepared=prepare();result:string|undefined;constructor(error:Error){this.result=({error,read(){return this.error.stack;}}).read();}}return new Read(value).result;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'object-this-anonymous-function-prefix',
    source:
      'function frames(error:Error){const ignored=function(){return 0;};return ({error,read(){return this.error.stack;}}).read();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
] as const;

describe('literal method this readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'object-this.ts', source);
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

describe('literal method this admissions', () => {
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
