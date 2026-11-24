import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Reflected native Blob/File calls retain only source-proven consumed text. */
const CASES = [
  {
    id: 'file-filename',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[],error as never]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'blob-parts',
    source: 'function frames(error:Error){return Reflect.construct(Blob,[[error as never]]).size;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'file-parts',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[error as never],"fixed"]).size;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'blob-content-type',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[],{type:error as never}]).type;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'file-content-type',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[],"fixed",{type:error as never}]).type;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'constructor-alias',
    source:
      'function frames(error:Error){const Native=File;return Reflect.construct(Native,[[],error as never]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'argument-list-alias',
    source:
      'function frames(error:Error){const args=[[],error as never];return Reflect.construct(File,args).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'fixed-outer-spread',
    source:
      'function frames(error:Error){const args=[File,[[],error as never]] as const;return Reflect.construct(...args).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'fixed-inner-spread',
    source:
      'function frames(error:Error){const tail=[error as never] as const;return Reflect.construct(File,[[],...tail]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'direct-file-control',
    source: 'function frames(error:Error){return new File([],error as never).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'direct-blob-control',
    source: 'function frames(error:Error){return new Blob([error as never]).size;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'fixed-file-data',
    source:
      'function frames(error:Error){return Reflect.construct(File,[["fixed"],"fixed",{type:"text/plain",lastModified:0}]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'fixed-blob-data',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[["fixed"],{type:"text/plain"}]).type;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'local-error-name-data',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[],new Error("fixed") as never]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'local-error-parts-data',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[new Error("fixed") as never]]).size;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'local-file-shadow',
    source:
      'function frames(error:Error){class File{readonly name="fixed";constructor(_parts:unknown,_name:unknown){}}return Reflect.construct(File,[[],error]).name;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'local-blob-shadow',
    source:
      'function frames(error:Error){class Blob{readonly size=0;constructor(_parts:unknown){}}return Reflect.construct(Blob,[[error]]).size;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'ignored-options-field',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[],"fixed",{ignored:error,type:"text/plain",lastModified:0}]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'ignored-outer-field',
    source:
      'function frames(error:Error){return (Reflect.construct as(...args:unknown[])=>File)(File,[[],"fixed"],File,error).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'changed-argument-list',
    source:
      'function frames(error:Error){const args:unknown[]=[[],error];args[1]="fixed";return Reflect.construct(File,args).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'effectful-ignored-tail-data',
    source:
      'function frames(error:Error){return (Reflect.construct as(...args:unknown[])=>File)(File,[[],error as never],File,Object.assign(error,{name:"Fixed",message:"fixed"})).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'parts-coercion-data',
    source:
      'function frames(error:Error){const part={toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return "part";}};return Reflect.construct(File,[[part],error as never]).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'options-earlier-getter-data',
    source:
      'function frames(error:Error){const options={get endings(){Object.assign(error,{name:"Fixed",message:"fixed"});return "transparent";},type:error as never};return Reflect.construct(Blob,[[],options]).type;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'native-new-target',
    source:
      'function frames(error:Error){return Reflect.construct(File,[[],error as never],File).name;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    reader: false,
  },
  {
    id: 'blob-constructor-alias',
    source:
      'function frames(error:Error){const Native=Blob;return Reflect.construct(Native,[[error as never]]).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-argument-list-alias',
    source:
      'function frames(error:Error){const args=[[error as never]];return Reflect.construct(Blob,args).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-fixed-outer-spread',
    source:
      'function frames(error:Error){const args=[Blob,[[error as never]]] as const;return Reflect.construct(...args).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-fixed-inner-spread',
    source:
      'function frames(error:Error){const parts=[error as never] as const;return Reflect.construct(Blob,[[...parts]]).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-option-getter',
    source:
      'function frames(error:Error){const options={get type(){return error as never;}};return Reflect.construct(Blob,[[],options]).type;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-native-new-target',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[error as never]],Blob).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-ignored-effect-tail-data',
    source:
      'function frames(error:Error){return(Reflect.construct as(...args:unknown[])=>Blob)(Blob,[[error as never]],Blob,Object.assign(error,{name:"Fixed",message:"fixed"})).size;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-prior-part-effect-data',
    source:
      'function frames(error:Error){const part={toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return "part";}};return Reflect.construct(Blob,[[part,error as never]]).size;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-part-creation-effect-data',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[Object.assign(error,{name:"Fixed",message:"fixed"})],{type:error as never}]).type;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-quiet-tail-sensitivity',
    source:
      'function frames(error:Error){return(Reflect.construct as(...args:unknown[])=>Blob)(Blob,[[error as never]],Blob,0).size;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-own-toString-parts',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[[error]]).size;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-own-toString-type',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[[],{type:error as never}]).type;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-array-own-toString',
    source:
      'function frames(error:Error){const parts=[error];Object.defineProperty(parts,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[parts]).size;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-native-error-message-origin',
    source:
      'function frames(error:Error){return Reflect.construct(Blob,[[new Error(error as never)]]).size;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-hole-parts-origin',
    source: 'function frames(error:Error){return Reflect.construct(Blob,[[,error]]).size;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-own-primitive-type-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,Symbol.toPrimitive,{value(){return "fixed";}});return Reflect.construct(Blob,[[],{type:error as never}]).type;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-parts-holder-later-own-conversion',
    source:
      'function frames(error:Error){const parts=[error];Object.defineProperty(error,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[parts]).size;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'blob-type-holder-later-own-conversion',
    source:
      'function frames(error:Error){const options={type:error as never};Object.defineProperty(error,"toString",{value(){return "fixed";}});return Reflect.construct(Blob,[[],options]).type;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('reflected Blob and File readers', () => {
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

describe('reflected Blob and File admissions', () => {
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
