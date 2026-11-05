import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { aliasesOf, resolveAlias } from '../src/authority/aliases.ts';

/**
 * A configuration's `baseUrl` and `paths` of `null` — TypeScript 6's migration writes a `baseUrl`
 * of `null` to clear an inherited one — read as TypeScript reads them: none in place of what the
 * configuration inherits. Each case answers as `tsc --traceResolution` resolves the same
 * configurations: `lib/x` under `baseUrl` alone, `@/x` through `paths`.
 */

/** A configuration that sets both, and the modules `lib/x` and `@/x` lead to through them. */
const BASE: Readonly<Record<string, string>> = {
  'base/lib/x.ts': "export const from = 'paths';\n",
  'base/src/lib/x.ts': "export const from = 'baseUrl';\n",
  'base/tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: './src', paths: { '@/*': ['./lib/*'] } },
  }),
};

/**
 * A directory of `BASE`, of `files`, and of `child/tsconfig.json` as `child`, removed when the
 * test ends.
 */
async function directoryOf(
  child: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-reset-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const written = { ...BASE, ...files, 'child/tsconfig.json': JSON.stringify(child) };
  for (const [name, text] of Object.entries(written)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

describe('aliasesOf', () => {
  it('reads the `baseUrl` and `paths` inherited where a configuration sets neither', async () => {
    const directory = await directoryOf({ extends: '../base/tsconfig.json' });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.baseUrl).toBe(path.join(directory, 'base/src'));
    expect(resolveAlias(aliases, 'lib/x')).toBe(path.join(directory, 'base/src/lib/x.ts'));
    // From `baseUrl`, which is in force.
    expect(resolveAlias(aliases, '@/x')).toBe(path.join(directory, 'base/src/lib/x.ts'));
  });

  it('reads a `baseUrl` of `null` as none in place of the one inherited', async () => {
    const directory = await directoryOf({
      compilerOptions: { baseUrl: null },
      extends: '../base/tsconfig.json',
    });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.baseUrl).toBeUndefined();
    expect(resolveAlias(aliases, 'lib/x')).toBeUndefined();
    // From the directory of the configuration that declared them, with no `baseUrl` in force.
    expect(resolveAlias(aliases, '@/x')).toBe(path.join(directory, 'base/lib/x.ts'));
  });

  it('reads `paths` of `null` as none in place of those inherited', async () => {
    const directory = await directoryOf({
      compilerOptions: { paths: null },
      extends: '../base/tsconfig.json',
    });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.paths).toStrictEqual([]);
    expect(resolveAlias(aliases, 'lib/x')).toBe(path.join(directory, 'base/src/lib/x.ts'));
    expect(resolveAlias(aliases, '@/x')).toBeUndefined();
  });

  it('lets the later of an `extends` array clear what the earlier sets, with `null`', async () => {
    const directory = await directoryOf(
      { extends: ['../base/tsconfig.json', '../reset/tsconfig.json'] },
      { 'reset/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: null } }) },
    );
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.baseUrl).toBeUndefined();
    expect(resolveAlias(aliases, 'lib/x')).toBeUndefined();
    expect(resolveAlias(aliases, '@/x')).toBe(path.join(directory, 'base/lib/x.ts'));
  });

  it('reads a `baseUrl` of another type as none, as TypeScript 6.0 does', async () => {
    const directory = await directoryOf({
      compilerOptions: { baseUrl: 5 },
      extends: '../base/tsconfig.json',
    });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.baseUrl).toBeUndefined();
    expect(resolveAlias(aliases, 'lib/x')).toBeUndefined();
    expect(resolveAlias(aliases, '@/x')).toBe(path.join(directory, 'base/lib/x.ts'));
  });

  it('takes no substitution of a pattern that is no array, nor one that is no text', async () => {
    // TypeScript reports both (TS5063, TS5064); the pattern still takes the specifiers it matches.
    const directory = await directoryOf({
      compilerOptions: { paths: { '@/*': './lib/*', '~/*': [5, '../base/lib/*'] } },
    });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(resolveAlias(aliases, '@/x')).toBeUndefined();
    expect(resolveAlias(aliases, '~/x')).toBe(path.join(directory, 'base/lib/x.ts'));
  });

  it('reads `paths` of another type as none, as TypeScript 6.0 does', async () => {
    const directory = await directoryOf({
      compilerOptions: { paths: './lib/*' },
      extends: '../base/tsconfig.json',
    });
    const aliases = aliasesOf(path.join(directory, 'child/tsconfig.json'));

    expect(aliases.paths).toStrictEqual([]);
    expect(resolveAlias(aliases, 'lib/x')).toBe(path.join(directory, 'base/src/lib/x.ts'));
    expect(resolveAlias(aliases, '@/x')).toBeUndefined();
  });
});
