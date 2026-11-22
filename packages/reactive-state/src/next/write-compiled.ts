/* eslint-disable security/detect-non-literal-fs-filename -- a build's compile writes where the application's build says, as `./compile-on-build.ts` does */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { writeOutputs } from '../compiler/index.ts';

/**
 * How the compile a build runs (`./compile-on-build.ts`) puts what it compiled on disk: each file
 * whole, and the manifest last.
 */

/** The manifest, which a compile writes last. */
const MANIFEST = 'manifest.json';

/** Writes `text` to `file` whole: beside it first, then in its place in one rename. */
export function writeWhole(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Writes what the compile wrote that is not on disk already, each file whole; takes away the files
 * an earlier compile wrote that this one does not; then the manifest, last. Answers whether it
 * changed anything.
 */
export function writeCompiled(outputs: ReadonlyMap<string, string>, outDir: string): boolean {
  const manifest = path.join(outDir, MANIFEST);
  const stale = writeOutputs(outputs, outDir, { check: true }).filter((output) => !output.current);
  const ordered = stale.toSorted(
    (left, right) => Number(left.path === manifest) - Number(right.path === manifest),
  );
  for (const output of ordered) {
    const text = outputs.get(output.path);
    if (text === undefined || output.leftover) {
      rmSync(output.path, { force: true });
    } else {
      writeWhole(output.path, text);
    }
  }
  return stale.length > 0;
}
