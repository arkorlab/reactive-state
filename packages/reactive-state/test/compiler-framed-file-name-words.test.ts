import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'file-converted-filename',
    source:
      'function frames(error:Error){return new File(["fixed"],error as unknown as string,{lastModified:0}).name;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'file-name-native-constructor-alias',
    source:
      'const Document=File;function frames(error:Error){return new Document(["fixed"],error as never,{lastModified:0}).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'file-name-array-words',
    source:
      'function frames(error:Error){return new File(["fixed"],[error] as never,{lastModified:0}).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'file-name-fixed-data',
    source: 'function frames(){return new File(["fixed"],"fixed",{lastModified:0}).name;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'file-name-local-written-words',
    source:
      'function frames(){return new File(["fixed"],new Error("fixed") as never,{lastModified:0}).name;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'file-name-local-constructor-shadow',
    source:
      'function frames(error:Error){class File{name="fixed";constructor(_parts:unknown,_name:unknown,_options:unknown){}}return new File(["fixed"],error,{lastModified:0}).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'file-name-ignored-options-entry',
    source:
      'function frames(error:Error){return new File(["fixed"],"fixed",{lastModified:0,ignored:error} as FilePropertyBag).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'file-name-own-array-text',
    source:
      'function frames(error:Error){const name=[error];name.toString=()=>"fixed";return new File(["fixed"],name as never,{lastModified:0}).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
];

describe('native File name readers', () => {
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

describe('shared native File names', () => {
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
