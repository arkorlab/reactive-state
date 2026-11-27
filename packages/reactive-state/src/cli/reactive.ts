#!/usr/bin/env node
import { dev } from './dev.ts';

/** The command an application runs: `reactive dev`, in its root. */

const USAGE = 'usage: reactive dev [the options of `next dev`]';
const EXIT_USAGE = 2;

const [command, ...args] = process.argv.slice(2);
if (command === 'dev') {
  await dev(process.cwd(), args);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = EXIT_USAGE;
}
