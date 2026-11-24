import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Reflected Blob conversions preserve earlier native evaluation order. */
const CASES = [
  {
    id: 'blob-opaque-prior-part-order-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return Reflect.construct(Blob,[[head,value as never]]).size;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-quiet-prior-part-error-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[["part",error as never]]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-opaque-new-target-prototype-pin',
    source:
      'function frames(error:Error){function collect(value:Error,Native:typeof Blob){return Reflect.construct(Blob,[[value as never]],Native).size;}const Native=new Proxy(Blob,{get(target,key,receiver){if(key==="prototype")Object.assign(error,{name:"Fixed",message:"fixed"});return Reflect.get(target,key,receiver);}});return collect(error,Native);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-unknown-nested-prior-part-order-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return Reflect.construct(Blob,[[[head],value as never]]).size;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-unknown-part-before-type-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return Reflect.construct(Blob,[[head],{type:value as never}]).type;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-unknown-error-message-part-order-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return Reflect.construct(Blob,[[new Error(head as never),value as never]]).size;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-unknown-endings-getter-conversion-pin',
    source:
      'function frames(error:Error){function collect(value:Error,mode:unknown){const options={get endings(){return mode as never;},type:value as never};return Reflect.construct(Blob,[[],options]).type;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"transparent";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-unknown-endings-data-conversion-pin',
    source:
      'function frames(error:Error){function collect(value:Error,mode:unknown){return Reflect.construct(Blob,[[],{endings:mode as never,type:value as never}]).type;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"transparent";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-native-target-error-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[error as never]],Blob).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-native-target-alias-error-control',
    source:
      'function frames(error:Error){const Native=Blob;return Reflect.construct(Blob,[[error as never]],Native).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-literal-prior-parts-error-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[["part",0,false,null,["nested"],error as never]]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-native-error-prior-part-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[new Error("fixed"),error as never]]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-primitive-alias-prior-part-control',
    source:
      'function frames(error:Error){const first="part";const alias=first;return Reflect.construct(Blob,[[alias,error as never]]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-literal-endings-type-error-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[],{endings:"transparent",type:error as never}]).type;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-primitive-alias-endings-getter-control',
    source:
      'function frames(error:Error){const mode="transparent";const options={get endings(){return mode;},type:error as never};return Reflect.construct(Blob,[[],options]).type;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-overwritten-endings-control',
    source:
      'function frames(error:Error){const first={endings:"transparent"};return Reflect.construct(Blob,[[],{...first,endings:"transparent",type:error as never}]).type;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-root-array-own-text-control',
    source:
      'function frames(error:Error){const parts=[error];Object.defineProperty(parts,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[parts]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-nested-array-own-text-pin',
    source:
      'function frames(error:Error){const nested=[error];Object.defineProperty(nested,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[[nested]]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-mutated-root-part-order-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){const parts=[value as never];parts.unshift(head as never);return Reflect.construct(Blob,[parts]).size;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-fixed-data-control',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[["part"],{endings:"transparent",type:"text/plain"}],Blob).type;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'blob-direct-parts-still-observed-control',
    source: 'function frames(error:Error){return new Blob([error as never]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-reflected-file-still-timed-pin',
    source:
      'function frames(error:Error){return Reflect.construct(File,[["fixed"],"name",{lastModified:0}]).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: false,
  },
  {
    id: 'blob-root-decoration-result-exposure-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){const parts=[value as never];const same=Object.defineProperty(parts,"toString",{value(){return "fixed";}});same.unshift(head as never);return Reflect.construct(Blob,[parts]).size;}return collect(error,{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"part";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('reflected Blob conversion order readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-blob.ts', source);
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

describe('reflected Blob conversion order admissions', () => {
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
