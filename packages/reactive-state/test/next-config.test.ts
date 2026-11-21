import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';

import { LOADER, REACTIVE_SOURCES, withReactiveState } from '../src/next/config.ts';

/**
 * How an application connects to reactive state: `withReactiveState` in its `next.config.ts`, whose
 * Turbopack loader hands an import of a component's source the root entry the compile wrote.
 */

/** The loader, as Turbopack's loader runner requires it. */
const loader = createRequire(import.meta.url)('../src/next/loader.cjs') as (this: {
  readonly resourcePath: string;
  readonly getOptions: () => Readonly<Record<string, string>>;
}) => string;

const ROOT = path.resolve('/apps/project-todo');

/** What the loader makes of `file`, under the options `withReactiveState` sets. */
function load(file: string, options: Readonly<Record<string, string>> = {}): string {
  return loader.call({
    getOptions: () => ({ out: '.reactive', root: ROOT, src: 'src', ...options }),
    resourcePath: file,
  });
}

describe('withReactiveState', () => {
  it('adds the loader for every `.reactive.tsx` source of the application, and this package', () => {
    const config = withReactiveState({ cacheComponents: true }, { root: ROOT });

    expect(config).toStrictEqual({
      cacheComponents: true,
      transpilePackages: ['@arkorlab/reactive-state'],
      turbopack: {
        rules: {
          [REACTIVE_SOURCES]: {
            as: '*.tsx',
            condition: { not: 'foreign' },
            loaders: [{ loader: LOADER, options: { out: '.reactive', root: ROOT, src: 'src' } }],
          },
        },
      },
    });
    expect(path.isAbsolute(LOADER)).toBe(true);
    expect(existsSync(LOADER)).toBe(true);
  });

  it('keeps every other rule and option, and the packages already compiled, once', () => {
    const svg = { as: '*.js', loaders: ['@svgr/webpack'] };
    const original: NextConfig = {
      transpilePackages: ['@arkorlab/reactive-state', 'other'],
      turbopack: { resolveAlias: { underscore: 'lodash' }, rules: { '*.svg': svg } },
    };

    const config = withReactiveState(original, { out: 'generated', root: ROOT, src: 'app-src' });

    expect(config.transpilePackages).toStrictEqual(['@arkorlab/reactive-state', 'other']);
    expect(config.turbopack?.resolveAlias).toStrictEqual({ underscore: 'lodash' });
    expect(config.turbopack?.rules?.['*.svg']).toBe(svg);
    expect(config.turbopack?.rules?.[REACTIVE_SOURCES]).toMatchObject({
      loaders: [{ options: { out: 'generated', root: ROOT, src: 'app-src' } }],
    });
    expect(original.turbopack?.rules).toStrictEqual({ '*.svg': svg });
  });

  it('tells the loader where the application turned sharing off, and nothing where it did not', () => {
    const off = withReactiveState({ cacheComponents: true }, { root: ROOT, share: false });
    const on = withReactiveState({ cacheComponents: true }, { root: ROOT, share: true });

    expect(off.turbopack?.rules?.[REACTIVE_SOURCES]).toMatchObject({
      loaders: [{ options: { share: 'off' } }],
    });
    expect(on.turbopack?.rules?.[REACTIVE_SOURCES]).toStrictEqual({
      as: '*.tsx',
      condition: { not: 'foreign' },
      loaders: [{ loader: LOADER, options: { out: '.reactive', root: ROOT, src: 'src' } }],
    });
  });

  it('takes the directory `next` runs in for the application’s root unless told another', () => {
    const rule = withReactiveState().turbopack?.rules?.[REACTIVE_SOURCES];

    expect(rule).toMatchObject({ loaders: [{ options: { root: process.cwd() } }] });
  });

  it('refuses a config of page extensions other than Next.js’s own, which the compile reads an app directory by, and takes them in any order', () => {
    expect(() => withReactiveState({ pageExtensions: ['page.tsx', 'page.ts'] })).toThrow(
      'The config withReactiveState is given sets `pageExtensions` to ["page.tsx","page.ts"]',
    );
    expect(() => withReactiveState({ pageExtensions: ['mdx', 'tsx', 'ts', 'jsx', 'js'] })).toThrow(
      'a page of another would be a route it never registers, whose reactive root renders without the guards of the route middleware around it',
    );
    expect(withReactiveState({ pageExtensions: ['js', 'jsx', 'ts', 'tsx'] })).toMatchObject({
      pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
    });
  });

  it('refuses a config with a rule of its own for the same sources', () => {
    expect(() =>
      withReactiveState({ turbopack: { rules: { [REACTIVE_SOURCES]: { loaders: ['x'] } } } }),
    ).toThrow(/already has a rule/u);
  });
});

describe('the loader', () => {
  it('re-exports the root entry the compile wrote for a component, from the source’s directory', () => {
    expect(load(path.join(ROOT, 'src/components/project.reactive.tsx'))).toBe(
      'export { default } from "../../.reactive/components/project.root.tsx";\n',
    );
    expect(load(path.join(ROOT, 'src/components/todo/editor.reactive.tsx'))).toBe(
      'export { default } from "../../../.reactive/components/todo/editor.root.tsx";\n',
    );
  });

  it('names an entry beside the source relatively, never as a package', () => {
    expect(load(path.join(ROOT, 'counter.reactive.tsx'), { src: '.' })).toBe(
      'export { default } from "./.reactive/counter.root.tsx";\n',
    );
    expect(load(path.join(ROOT, 'src/page.reactive.tsx'), { out: 'src/generated' })).toBe(
      'export { default } from "./generated/page.root.tsx";\n',
    );
  });

  it('reads a path from the application’s root as one', () => {
    expect(load('src/components/project.reactive.tsx')).toBe(
      'export { default } from "../../.reactive/components/project.root.tsx";\n',
    );
  });

  it('refuses a source outside the components the compile reads', () => {
    expect(() => load(path.join(ROOT, 'lib/project.reactive.tsx'))).toThrow(
      /not a component under/u,
    );
    expect(() => load(path.join(ROOT, 'src/project.tsx'))).toThrow(/not a component under/u);
  });
});
