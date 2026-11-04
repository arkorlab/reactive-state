import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextAdapter } from 'next';
import { describe, expect, it } from 'vitest';

import { createReactiveAdapter } from '../src/next/adapter.ts';
import { configWritten, NOTHING_WRITTEN } from '../src/next/config-read.ts';

/** The config's export is read only where nothing else can change the object it exposes. */
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = path.join(PACKAGE, 'next.config.js');
type BuildConfig = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];
type Context = Parameters<NonNullable<NextAdapter['modifyConfig']>>[1];

describe('a CommonJS config read from its source', () => {
  it.each([
    'module.exports.cacheComponents = false;',
    "module.exports['cacheComponents'] = false;",
    "module['exports'].cacheComponents = false;",
    'const config = module.exports; config.cacheComponents = false;',
    'Object.assign(module.exports, { cacheComponents: false });',
    'change(module);',
    'module.exports.experimental = { useCache: false };',
  ])(
    'does not mistake an exported object changed elsewhere for an empty config: %s',
    (mutation) => {
      expect(configWritten(CONFIG, `module.exports = {}; ${mutation}`)).toBeUndefined();
    },
  );

  it.each([
    ['module.exports = {};', NOTHING_WRITTEN],
    ['const config = {}; module.exports = config;', NOTHING_WRITTEN],
    [
      'module.exports = { cacheComponents: false };',
      { ...NOTHING_WRITTEN, cacheComponents: false },
    ],
    [
      'module.exports = { experimental: { useCache: false } };',
      { ...NOTHING_WRITTEN, useCache: false },
    ],
  ])('still reads a plain CommonJS export: %s', (text, written) => {
    expect(configWritten(CONFIG, text)).toStrictEqual(written);
  });

  it('refuses a CommonJS config that turns caching off after assigning its export', async () => {
    const projectDir = mkdtempSync(path.join(PACKAGE, '.reactive-state-config-'));
    const configFile = path.join(projectDir, 'next.config.js');
    writeFileSync(configFile, 'module.exports = {}; module.exports.cacheComponents = false;');
    const config = {
      cacheComponents: false,
      configFile,
      configFileName: 'next.config.js',
      experimental: { cachedNavigations: false, useCache: false },
      pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
    } as unknown as BuildConfig;
    const context = {
      nextVersion: '16.4.2',
      phase: 'phase-export',
      projectDir,
    } as Context;
    try {
      await expect(createReactiveAdapter().modifyConfig?.(config, context)).rejects.toThrow(
        /leaves Cache Components off as Next\.js read it, and computes what it says/u,
      );
      expect(config.cacheComponents).toBe(false);
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  });
});

describe('lexical references of a plain config export', () => {
  it.each([
    'const config = { images: { config: true } }; export default config;',
    'module.exports = { metadata: { module: true } };',
    'const settings = {}; settings.module; module.exports = {};',
    'const config = { webpack(config) { return config; } }; export default config;',
    'module.exports = { webpack(module) { return module; } };',
    'const config = {}; function helper(config) { return config; } export default config;',
    'const config = {}; { const config = {}; config.used = true; } export default config;',
    '{ const module = {}; module.used = true; } module.exports = {};',
    'for (const module of []) { module.used = true; } module.exports = {};',
    'try {} catch (module) { module.used = true; } module.exports = {};',
    'const config = { webpack: function config() { return config; } }; export default config;',
    'module.exports = { handler: class module { value() { return module; } } };',
    'type config = { value: string }; const config = {}; export default config;',
    'const config = {}; type Saved = typeof config; export default config;',
    'import type { config as Data } from "./types"; const config = {}; export default config;',
    'import { config as Data } from "./data"; const config = {}; export default config;',
    'const config = {}; const other = 1; export { other as config }; export default config;',
    'const { config: ignored } = { config: true }; const config = {}; export default config;',
    'type Handler = (module: string) => string; module.exports = {};',
    'module: for (const value of []) { break module; } module.exports = {};',
    'const config = {}; export * as config from "./data"; export default config;',
    'const config = {}; export type * as config from "./types"; export default config;',
    'export * as module from "./data"; module.exports = {};',
  ])('ignores property names, erased types and separate local bindings: %s', (source) => {
    expect(configWritten(CONFIG, source)).toStrictEqual(NOTHING_WRITTEN);
  });

  it.each([
    'const config = {}; config.cacheComponents = false; export default config;',
    'const config = {}; const alias = config; alias.cacheComponents = false; export default config;',
    'const config = {}; const other = { config }; export default config;',
    'const config = {}; const other = { [config]: true }; export default config;',
    'const config = {}; function helper() { return config; } export default config;',
    'const config = {}; function helper(value = config) {} export default config;',
    'const config = {}; function helper(value = config) { var config; } export default config;',
    'const config = {}; const other = { [config](config) { return config; } }; export default config;',
    'const config = {}; export { config as named }; export default config;',
    'const config = {}; function helper(config) {} helper(config); export default config;',
    'function helper(value = module) {} module.exports = {};',
    'const other = { module }; module.exports = {};',
    'const other = { [module]: true }; module.exports = {};',
    'const module = {}; module.exports = {};',
    'function module() {} module.exports = {};',
    'class module {} module.exports = {};',
    'enum module { Value } module.exports = {};',
    'import module from "./data"; module.exports = {};',
    'namespace module { export const value = true; } module.exports = {};',
    'const { module } = {}; module.exports = {};',
    'if (false) { var module; } module.exports = {};',
    'const config = {}; var config; export default config;',
  ])('preserves actual escapes, mutation paths and top-level binding conflicts: %s', (source) => {
    expect(configWritten(CONFIG, source)).toBeUndefined();
  });

  it('keeps explicit cache flags even beside harmless matching names', () => {
    expect(
      configWritten(
        CONFIG,
        'const config = { cacheComponents: false, experimental: { useCache: false }, webpack(config) { return config; } }; export default config;',
      ),
    ).toStrictEqual({
      ...NOTHING_WRITTEN,
      cacheComponents: false,
      useCache: false,
    });
  });
});

describe('decorators in a config source', () => {
  it.each([
    'const config = {}; class C { @((value) => { config.cacheComponents = false; return value; }) method(config) {} } export default config;',
    'const config = {}; class C { method(@((target, key, index) => { config.cacheComponents = false; }) config) {} } export default config;',
    'const config = {}; @((config) => config) class C {} export default config;',
    'module.exports = {}; class C { @((value) => { module.exports.cacheComponents = false; return value; }) method(module) {} }',
    'const config = { cacheComponents: true }; @((config) => config) class C {} export default config;',
    'const config = {}; @((value) => { config.cacheComponents = false; return value; }) class C {} export default config;',
  ])(
    'leaves decorator evaluation opaque instead of borrowing its decorated scope: %s',
    (source) => {
      expect(configWritten(path.join(PACKAGE, 'next.config.ts'), source)).toBeUndefined();
    },
  );

  it.each([
    {
      cacheComponents: false,
      expected: {
        error: expect.stringMatching(
          /leaves Cache Components off as Next\.js read it, and computes what it says/u,
        ),
      },
    },
    { cacheComponents: true, expected: { cacheComponents: true } },
  ])(
    'uses the existing fallback for a decorated config Next.js read as $cacheComponents',
    async ({ cacheComponents, expected }) => {
      const projectDir = mkdtempSync(path.join(PACKAGE, '.reactive-state-config-'));
      const configFile = path.join(projectDir, 'next.config.ts');
      const source = cacheComponents
        ? 'const config = { cacheComponents: true }; @((config) => config) class C {} export default config;'
        : 'const config = {}; class C { @((value) => { config.cacheComponents = false; return value; }) method(config) {} } export default config;';
      writeFileSync(configFile, source);
      const config = {
        cacheComponents,
        configFile,
        configFileName: 'next.config.ts',
        experimental: { cachedNavigations: false, useCache: false },
        pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
      } as unknown as BuildConfig;
      const context = { nextVersion: '16.4.2', phase: 'phase-export', projectDir } as Context;
      try {
        let outcome: { readonly cacheComponents: boolean | undefined } | { readonly error: string };
        try {
          const value = await createReactiveAdapter().modifyConfig?.(config, context);
          outcome = { cacheComponents: value?.cacheComponents };
        } catch (error) {
          outcome = { error: String(error) };
        }

        expect(outcome).toStrictEqual(expected);
        expect(config.cacheComponents).toBe(cacheComponents);
      } finally {
        rmSync(projectDir, { force: true, recursive: true });
      }
    },
  );
});
