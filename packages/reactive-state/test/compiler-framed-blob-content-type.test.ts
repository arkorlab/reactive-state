import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'blob-direct-type',
    source: 'function words(error:Error){return new Blob([],{type:error as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-direct-type',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,type:error as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-caught-platform-type',
    source:
      'function words(error:Error){try{return decodeURIComponent("%");}catch(caught){return new Blob([],{type:caught as never}).type;}}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-caught-platform-type',
    source:
      'function words(error:Error){try{return decodeURIComponent("%");}catch(caught){return new File([],"fixed",{lastModified:0,type:caught as never}).type;}}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-constant-options',
    source:
      'function words(error:Error){const options={type:error as never};return new Blob([],options).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-constant-options',
    source:
      'function words(error:Error){const options={lastModified:0,type:error as never};return new File([],"fixed",options).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-options-chain',
    source:
      'function words(error:Error){const original={type:error as never};const options=original;return new Blob([],options).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-literal-spread',
    source: 'function words(error:Error){return new Blob([],{...{type:error as never}}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-literal-spread',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,...{type:error as never}}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-aliased-spread',
    source:
      'function words(error:Error){const options={type:error as never};return new Blob([],{...options}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-spread-overwrites-data',
    source:
      'function words(error:Error){return new Blob([],{type:"text/plain",...({type:error as never} as BlobPropertyBag)}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-constructor-alias',
    source:
      'function words(error:Error){const NativeBlob=Blob;return new NativeBlob([],{type:error as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-constructor-alias',
    source:
      'function words(error:Error){const NativeFile=globalThis.File;return new NativeFile([],"fixed",{lastModified:0,type:error as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-argument-spread',
    source:
      'function words(error:Error){const args:[BlobPart[],BlobPropertyBag]=[[],{type:error as never}];return new Blob(...args).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-argument-spread',
    source:
      'function words(error:Error){const args:[BlobPart[],string,FilePropertyBag]=[[],"fixed",{lastModified:0,type:error as never}];return new File(...args).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-literal-type-getter',
    source:
      'function words(error:Error){return new Blob([],{get type(){return error as never;}}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-array-type',
    source: 'function words(error:Error){return new Blob([],{type:[error] as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'blob-plain-mime-pin',
    source: 'function words(error:Error){return new Blob([],{type:"text/plain"}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-plain-mime-pin',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,type:"text/plain"}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'blob-local-error-words-pin',
    source:
      'function words(error:Error){return new Blob([],{type:new Error("fixed") as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-local-error-words-pin',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,type:new Error("fixed") as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'blob-ignored-option-pin',
    source:
      'function words(error:Error){return new Blob([],{type:"text/plain",ignored:error} as BlobPropertyBag).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-ignored-option-pin',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,type:"text/plain",ignored:error} as FilePropertyBag).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'blob-later-data-overwrite-pin',
    source:
      'function words(error:Error){return new Blob([],{type:error as never,...({type:"text/plain"} as BlobPropertyBag)}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-later-data-overwrite-pin',
    source:
      'function words(error:Error){return new File([],"fixed",{lastModified:0,type:error as never,...({type:"text/plain"} as BlobPropertyBag)}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: true,
  },
  {
    id: 'blob-changed-options-pin',
    source:
      'function words(error:Error){const options={type:error as never};options.type="text/plain" as never;return new Blob([],options).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'blob-ignored-third-argument-pin',
    source:
      'function words(error:Error){const NativeBlob=Blob as unknown as new(...args:unknown[])=>Blob;return new NativeBlob([],{type:"text/plain"},{type:error}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-ignored-fourth-argument-pin',
    source:
      'function words(error:Error){const NativeFile=File as unknown as new(...args:unknown[])=>File;return new NativeFile([],"fixed",{lastModified:0,type:"text/plain"},{type:error}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: true,
  },
  {
    id: 'blob-local-constructor-pin',
    source:
      'class Blob{type="fixed";constructor(_parts:unknown,_options:unknown){}}function words(error:Error){return new Blob([],{type:error}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'file-local-constructor-pin',
    source:
      'class File{type="fixed";constructor(_parts:unknown,_name:unknown,_options:unknown){}}function words(error:Error){return new File([],"fixed",{type:error}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'blob-own-array-text-pin',
    source:
      'function words(error:Error){const type=Object.assign([error],{toString(){return "fixed";}});return new Blob([],{type:type as never}).type;}',
    invocation: 'words(new Error("ours"))',
    reader: true,
    refused: true,
  },
] as const;

describe('native Blob and File content-type words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-content-type.ts', source);
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

describe('shared Blob and File content-type admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_BLOB_OBSERVATIONS'];
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
