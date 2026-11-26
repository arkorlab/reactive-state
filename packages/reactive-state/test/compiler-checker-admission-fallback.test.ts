import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Node } from 'typescript/ast';
import { afterAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whether a declared type admits an Error is TypeScript's checker's answer, in a program of the
 * module made with the nearest `tsconfig.json`'s options. Where that program has no `Error` — no
 * library, or one TypeScript cannot find — the checker answers nothing, and the type admits one, as
 * one the compile cannot read does: a Map of values typed to exclude an Error, given an input the
 * compile cannot read, is shared only where the checker reads its type.
 */

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

const SOURCE =
  "function titles():[string,{title:string;stack?:string}][]{return [['k',{title:'t',stack:'fixed'}]];}function frames(error:Error,key:string){void error;return new Map<string,{title:string;stack?:string}>(titles()).get(key)!.stack;}";

const CASES = [
  { id: 'checker-library-quiet', options: { strict: true }, refused: false },
  { id: 'checker-no-library-admits', options: { noLib: true }, refused: true },
  { id: 'checker-missing-library-admits', options: { lib: ['es-none'] }, refused: true },
];

describe('checker admission fallback readers', () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  it.each(CASES)('$id', async ({ options, refused }) => {
    const root = await mkdtemp(path.join(PACKAGE, '.reactive-state-checker-'));
    roots.push(root);
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: options }));
    using api = openTypeScript(root);
    using parsed = parseModule(api, path.join(root, 'frames.ts'), SOURCE);
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
