import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { SymbolFlags } from 'typescript/sync';
import { describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * The `./d1` entry, which a host imports to prune its own change log in D1, on Node too: of values,
 * `d1Executor` and `pruneChanges` alone, and of types, the `D1Executor` the prune runs its
 * statement through, as TypeScript's checker reads the module the entry names. The module loads on
 * Node, as this test imports it there: it imports nothing of `cloudflare:` that runs.
 */

const PACKAGE = new URL('../', import.meta.url);
/** How long a program of the module takes to make, of a native compiler started under load. */
const CHECK_TIMEOUT_MS = 30_000;

/** What an export of a module is to TypeScript: a value, a type, or both, as a class is. */
type Meaning = 'both' | 'type' | 'value';

/** The file of the module the package's `./d1` entry names. */
async function entryFile(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('package.json', PACKAGE), 'utf8')) as {
    readonly exports: Readonly<Record<string, unknown>>;
  };
  const entry = manifest.exports['./d1'];
  if (typeof entry !== 'string') throw new TypeError('The `./d1` entry names no module.');
  return fileURLToPath(new URL(entry, PACKAGE));
}

/** Whether `flags` holds any of the bits of `mask`, read one bit at a time. */
function holds(flags: number, mask: number): boolean {
  for (let bit = 1; bit <= mask; bit *= 2) {
    if (Math.floor(mask / bit) % 2 === 1 && Math.floor(flags / bit) % 2 === 1) return true;
  }
  return false;
}

/** What a symbol of `flags` means: a value, a type, or both. */
function meaningOf(flags: SymbolFlags): Meaning {
  const value = holds(flags, SymbolFlags.Value);
  const type = holds(flags, SymbolFlags.Type);
  if (value && type) return 'both';
  return value ? 'value' : 'type';
}

/**
 * Each name `file` exports, by what it means, as the checker of a program of it alone reads it
 * under the package's options: an alias — `export { … }`, `export … from` — by what it names.
 */
function exportsOf(file: string): Readonly<Record<string, Meaning>> {
  using api = openTypeScript(fileURLToPath(PACKAGE));
  const { options } = api.parseConfigFile(fileURLToPath(new URL('tsconfig.json', PACKAGE)));
  using snapshot = api.createSnapshot({
    createPrograms: [{ compilerOptions: options, rootFiles: [file] }],
  });
  const [program] = snapshot.operation.createdPrograms;
  const { checker } = program.getProject();
  const source = program.getSourceFile(file);
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (module === undefined) throw new TypeError(`${file} is no module of the program.`);
  const meanings: Record<string, Meaning> = {};
  for (const symbol of checker.getExportsOfModule(module)) {
    const aliased = holds(symbol.flags, SymbolFlags.Alias);
    const named = aliased ? checker.getAliasedSymbol(symbol) : symbol;
    meanings[symbol.name] = meaningOf(named.flags);
  }
  return meanings;
}

describe('the D1 entry', () => {
  it('answers d1Executor and pruneChanges alone', async () => {
    const entry = (await import(await entryFile())) as Readonly<Record<string, unknown>>;

    // A module's namespace holds its names in their order of code units.
    expect(Object.keys(entry)).toStrictEqual(['d1Executor', 'pruneChanges']);
  });

  it(
    'exports D1Executor of types, and no other',
    async () => {
      const file = await entryFile();

      expect(exportsOf(file)).toStrictEqual({
        D1Executor: 'type',
        d1Executor: 'value',
        pruneChanges: 'value',
      });
    },
    CHECK_TIMEOUT_MS,
  );
});
