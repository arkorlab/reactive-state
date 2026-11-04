import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'blob-supplied-part',
    source: 'function frames(error:Error){return new Blob([error as never]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'file-supplied-part',
    source:
      'function frames(error:Error){return new File([error as never],"fixed",{lastModified:0}).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'blob-constructor-alias',
    source: 'const Data=Blob;function frames(error:Error){return new Data([error as never]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'blob-parts-constant-alias',
    source:
      'function frames(error:Error){const parts=[error as never];return new Blob(parts).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'blob-parts-typed-input',
    source: 'function frames(parts:Error[]){return new Blob(parts as never).size;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'blob-local-words',
    source: 'function frames(){return new Blob([new Error("fixed")as never]).size;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'blob-buffer-source-value',
    source:
      'function frames(){return new Blob([new Uint8Array([1,2]),new DataView(new ArrayBuffer(2))]).size;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'blob-part-value',
    source: 'function frames(){return new Blob([new Blob(["fixed"])]).size;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'file-fixed-parts-and-timestamp',
    source: 'function frames(){return new File(["fixed"],"fixed",{lastModified:0}).size;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'blob-local-constructor-shadow',
    source:
      'function frames(error:Error){class Blob{size=5;constructor(_parts:unknown){}}return new Blob([error]).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'file-local-constructor-shadow',
    source:
      'function frames(error:Error){class File{size=5;constructor(_parts:unknown,_name:string){}}return new File([error],"fixed").size;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'blob-extra-options-data',
    source:
      'function frames(error:Error){return new Blob(["fixed"],{type:"text/plain",ignored:error} as BlobPropertyBag).size;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('blob consumed word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-parts.ts', source);
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

describe('shared blob consumed words', () => {
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
