import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API } from 'typescript/sync';

import { type Compiled, compileApp, type ReactiveCompileError } from '../../src/compiler/index.ts';

/**
 * The application the compiler is first measured against (`fixtures/next-project-…`), copied into
 * a directory of a suite's own — inside this package, so that `@arkorlab/reactive-state` and React
 * resolve from it as they do from an application — with the `tsconfig.json` an application of it
 * has: `@/*` its sources, `framework/*` the package's. A suite changes a copy, compiles it, and
 * reads what the compile wrote.
 */

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../../fixtures/next-project-todo/src/', import.meta.url));
/** The fixture's variants: each a copy of what differs of it, by its path in `src`. */
const VARIANTS = fileURLToPath(
  new URL('../../../../fixtures/next-project-todo/variants/', import.meta.url),
);

export interface Application {
  readonly root: string;
  readonly src: string;
  readonly out: string;
  readonly appDir: string;
  readonly tsconfig: string;
}

/** A copy of the application, its files changed by `files` (paths in `src`) where given. */
export async function application(files: Readonly<Record<string, string>> = {}): Promise<Application> {
  const root = await mkdtemp(path.join(PACKAGE, '.reactive-state-compiler-'));
  const src = path.join(root, 'src');
  await cp(FIXTURE, src, { recursive: true });
  const tsconfig = path.join(root, 'tsconfig.json');
  await writeFile(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          jsx: 'react-jsx',
          lib: ['ES2024', 'ESNext.Disposable', 'DOM', 'DOM.Iterable'],
          paths: { '@/*': ['./src/*'], 'framework/*': ['../src/framework/*.ts'] },
          types: ['node'],
        },
        extends: '../../../tsconfig.base.json',
        include: ['.reactive/**/*', 'src/app/api/**/*', '*.mts'],
      },
      null,
      2,
    ),
  );
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, file)), { recursive: true });
    await writeFile(path.join(src, file), text);
  }
  return { appDir: path.join(src, 'app'), out: path.join(root, '.reactive'), root, src, tsconfig };
}

export async function removed(app: Application): Promise<void> {
  await rm(app.root, { force: true, recursive: true });
}

/** A source of the application, as the fixture holds it. */
export async function source(file: string): Promise<string> {
  return readFile(path.join(FIXTURE, file), 'utf8');
}

/** A source of the application as the fixture's variant `name` holds it: `v2`, `inline`, `aliases`. */
export async function variantSource(name: string, file: string): Promise<string> {
  return readFile(path.join(VARIANTS, name, 'src', file), 'utf8');
}

/** `text` with `from`, which must occur in it exactly once, replaced by `to`. */
export function variant(text: string, from: string, to: string): string {
  const [before = '', after, ...more] = text.split(from);
  if (after === undefined || more.length > 0) {
    throw new Error(`The source holds ${JSON.stringify(from)} other than exactly once.`);
  }
  return `${before}${to}${after}`;
}

export function compiledApp(app: Application, api: API): Compiled {
  return compileApp({ api, appDir: app.appDir, outDir: app.out, srcDir: app.src });
}

/** The text the compile wrote at `file`, a path in the output directory. */
export function output(compiled: Compiled, app: Application, file: string): string {
  const text = compiled.outputs.get(path.join(app.out, file));
  if (text === undefined) {
    throw new Error(`The compile wrote no ${file}: ${[...compiled.outputs.keys()].join(', ')}`);
  }
  return text;
}

/** Where `marker` first starts in `text`, as a refusal names a place: one-based. */
export function positionOf(text: string, marker: string): { line: number; column: number } {
  const index = text.indexOf(marker);
  if (index === -1) {
    throw new Error(`The source does not hold ${JSON.stringify(marker)}.`);
  }
  const lines = text.slice(0, index).split('\n');
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
}

/** The one refusal of a compile; it fails where the compile refused nothing, or more. */
export function refusalOf(compiled: Compiled): ReactiveCompileError {
  const [refusal, ...more] = compiled.refusals;
  if (refusal === undefined || more.length > 0) {
    throw new Error(
      `The compile refused ${String(compiled.refusals.length)} things: ${compiled.refusals.map((each) => each.message).join('\n')}`,
    );
  }
  return refusal;
}

/** Runs `script`, an ES module, in a Node of its own, from `cwd`. */
export function node(script: string, cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd, encoding: 'utf8' });
}

/** The compiler's command line, run as a person runs it. */
export function cli(...args: readonly string[]): SpawnSyncReturns<string> {
  const entry = fileURLToPath(new URL('../../src/compiler/cli.ts', import.meta.url));
  const sourceArgument = args[0];
  const cache =
    sourceArgument !== undefined && path.isAbsolute(sourceArgument)
      ? path.join(path.dirname(sourceArgument), '.node-compile-cache')
      : undefined;
  const env =
    cache === undefined
      ? process.env
      : { ...process.env, NODE_COMPILE_CACHE: process.env['NODE_COMPILE_CACHE'] ?? cache };
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env });
}

/** The application's type check of what the compile wrote, as `tsc` makes it. */
export function typeCheck(app: Application): SpawnSyncReturns<string> {
  const tsc = path.join(PACKAGE, 'node_modules/typescript/bin/tsc');
  return spawnSync(process.execPath, [tsc, '--noEmit', '-p', app.root], { encoding: 'utf8' });
}
