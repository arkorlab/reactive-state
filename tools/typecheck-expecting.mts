import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * `tsc --noEmit` for a package whose sources are still arriving: it passes when `tsc` reports
 * exactly the diagnostics the file it is given lists — none other, and none of them gone.
 *
 * The compiler's modules import one another in a cycle of type-only imports, which arrives over
 * several pull requests, and one of those imports names a module a later one brings. Listing what
 * `tsc` reports of it keeps the check whole for everything else; the day the module arrives, this
 * fails until the pull request that brings it removes the list, and this tool with it.
 *
 * Run from the package's directory, it runs the `tsc` of the TypeScript the package depends on.
 *
 *   node ../../tools/typecheck-expecting.mts <expected-file> [tsc arguments…]
 */
const DIAGNOSTIC = /\berror TS\d+:/u;

function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The `tsc` script of the TypeScript the package in the working directory resolves. */
function tscOf(directory: string): string {
  const manifest = createRequire(path.join(directory, 'package.json')).resolve(
    'typescript/package.json',
  );
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    readonly bin: { readonly tsc: string };
  };
  return path.resolve(path.dirname(manifest), bin.tsc);
}

const [expectedFile, ...args] = process.argv.slice(2);
if (expectedFile === undefined) {
  console.error('usage: typecheck-expecting <expected-file> [tsc arguments…]');
  process.exitCode = 2;
} else {
  const expected = new Set(linesOf(readFileSync(expectedFile, 'utf8')));
  const run = spawnSync(
    process.execPath,
    [tscOf(process.cwd()), '--noEmit', '--pretty', 'false', ...args],
    { encoding: 'utf8' },
  );
  const reported = new Set(
    linesOf(`${run.stdout}\n${run.stderr}`).filter((line) => DIAGNOSTIC.test(line)),
  );
  let mismatched = false;
  for (const line of reported) {
    if (!expected.has(line)) {
      console.error(line);
      mismatched = true;
    }
  }
  for (const line of expected) {
    if (!reported.has(line)) {
      console.error(`listed, but no longer reported: ${line}`);
      mismatched = true;
    }
  }
  const failed = run.error !== undefined || (run.status !== 0 && reported.size === 0);
  if (failed) {
    console.error(run.error?.message ?? `${run.stdout}${run.stderr}`);
  }
  process.exitCode = failed || mismatched ? 1 : 0;
}
