import path from 'node:path';
import { parseArgs } from 'node:util';

import { givenHost } from './host.ts';
import { compileApp, writeOutputs } from './index.ts';

/**
 * Compiles an application's `.reactive.tsx` components:
 *
 *   node src/compiler/cli.ts <srcDir> --out <dir> --app <appDir> [--database <specifier>#<export>]
 *     [--session <specifier>#<export>] [--prefetch <profile>|<stale>/<revalidate>/<expire>]
 *     [--no-share] [--check]
 *
 * compiles every component under `<srcDir>` first, in memory, with the custom hooks, the
 * `'use server'` modules and the shared modules it reaches, and reports each refusal; only when it
 * refuses nothing does it write the build into `<dir>`, and the route into `<appDir>` — or, with
 * `--check`, write nothing and exit 1 when any of it is not what a compile would write now.
 * `--session` names how the application reads its own signed-in session, where it signs its users in
 * itself; `--prefetch`, the private cache the roots a request alone renders are rendered inside, for
 * a link's prefetch to carry them; `--no-share`, that nothing is shared — no route's view — and
 * every root renders for its own session.
 */

const USAGE =
  'usage: cli.ts <srcDir> --out <dir> --app <appDir> [--database <specifier>#<export>] [--session <specifier>#<export>] [--prefetch <profile>|<stale>/<revalidate>/<expire>] [--no-share] [--check]';
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A path as the person who ran the command would write it. */
function shown(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') ? file : relative;
}

interface Run {
  readonly srcDir: string;
  readonly out: string;
  readonly app: string;
  readonly database: string | undefined;
  readonly session: string | undefined;
  readonly prefetch: string | undefined;
  /** Whether anything may be shared: not where `--no-share` is given. */
  readonly share: boolean;
  readonly check: boolean;
}

/** The run the arguments ask for, or why they ask for none. */
type Parsed = { readonly run: Run } | { readonly usage: string };

function argumentsOf(argv: readonly string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: {
        app: { type: 'string' },
        check: { type: 'boolean' },
        database: { type: 'string' },
        out: { type: 'string' },
        'no-share': { type: 'boolean' },
        prefetch: { type: 'string' },
        session: { type: 'string' },
      },
    });
  } catch (error) {
    return { usage: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` };
  }
  const { app, check, database, out, prefetch, session } = parsed.values;
  const share = parsed.values['no-share'] !== true;
  const [srcDir, ...more] = parsed.positionals;
  if (out === undefined || app === undefined || srcDir === undefined || more.length > 0) {
    return { usage: USAGE };
  }
  return { run: { app, check: check === true, database, out, prefetch, session, share, srcDir } };
}

function main(argv: readonly string[]): number {
  const parsed = argumentsOf(argv);
  if ('usage' in parsed) {
    write(parsed.usage);
    return EXIT_USAGE;
  }
  const { run } = parsed;
  const compiled = compileApp({
    appDir: run.app,
    outDir: run.out,
    srcDir: run.srcDir,
    ...givenHost(run),
  });
  for (const refusal of compiled.refusals) {
    write(refusal.message);
  }
  if (compiled.refusals.length > 0) {
    return EXIT_FAILED;
  }
  const changed = writeOutputs(compiled.outputs, run.out, { check: run.check }).filter(
    (output) => !output.current,
  );
  for (const output of changed) {
    if (run.check) {
      write(`stale: ${shown(output.path)}`);
    } else {
      write(`${output.leftover ? 'removed' : 'wrote'} ${shown(output.path)}`);
    }
  }
  if (run.check && changed.length > 0) {
    write('compile the components again, and commit what it writes');
    return EXIT_FAILED;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
