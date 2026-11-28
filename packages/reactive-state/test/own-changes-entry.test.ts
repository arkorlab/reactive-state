import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as entry from '../src/own-changes.ts';

/**
 * The light entry a Worker of the application's own imports to write followed tables
 * (`./own-changes`): `ownChanges` alone, of a module that imports none but the reading of SQL's
 * text, so a bundle that holds it holds no authority, no Drizzle and no React.
 */

/** The text of a module of the package's, by its path from `src`. */
async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

/** The modules `source` imports, by their specifiers. */
function importsOf(source: string): readonly string[] {
  return [...source.matchAll(/ from '([^']+)';/gu)].map((match) => match[1] ?? '');
}

describe('the own changes entry', () => {
  it('answers ownChanges alone', () => {
    expect(Object.keys(entry)).toStrictEqual(['ownChanges']);
    expect(entry.ownChanges).toBeTypeOf('function');
  });

  it('is exported as ./own-changes', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Readonly<Record<string, unknown>> };

    expect(manifest.exports['./own-changes']).toBe('./src/own-changes.ts');
  });

  it("imports the module alone, which imports none but the reading of SQL's text and a set", async () => {
    const own = await sourceOf('own-changes.ts');
    const module = await sourceOf('sql/sqlite/own-changes.ts');
    const reading = await sourceOf('sql/sqlite/where.ts');
    const tracked = await sourceOf('sql/sqlite/tracked.ts');

    expect(importsOf(own)).toStrictEqual(['./sql/sqlite/own-changes.ts']);
    expect(importsOf(module)).toStrictEqual(['./tracked.ts', './where.ts']);
    expect(importsOf(reading)).toStrictEqual([]);
    expect(importsOf(tracked)).toStrictEqual([]);

    for (const source of [module, reading, tracked]) {
      expect(source).not.toContain('import(');
      expect(source).not.toContain('require(');
    }
  });
});
