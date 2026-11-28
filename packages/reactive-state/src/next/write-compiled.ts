/* eslint-disable security/detect-non-literal-fs-filename -- a build's compile writes where the application's build says, as `./compile-on-build.ts` does */
import { rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { writeOutputs } from '../compiler/index.ts';
import { writeWhole } from './write-whole.ts';

/**
 * How the compile a build runs (`./compile-on-build.ts`) puts what it compiled on disk, at build
 * time: what an earlier compile wrote that this one does not is taken away first, as the compiler's
 * own write takes it away (`writeOutputs`); then each file is written whole (`./write-whole.ts`);
 * the manifest last.
 */

/** The manifest, which a compile writes last. */
const MANIFEST = 'manifest.json';

/** Takes away `directory`, and each directory above it below `root`, while each is empty. */
function removeEmptied(directory: string, root: string): void {
  for (
    let each = directory;
    each !== root && each.startsWith(`${root}${path.sep}`);
    each = path.dirname(each)
  ) {
    try {
      rmdirSync(each);
    } catch {
      // One that is not empty holds what is not the compile's: it stays, and so does what it is in.
      return;
    }
  }
}

/**
 * Takes away the files an earlier compile wrote into `outDir` that this one does not, and the
 * directories that leaves empty; then writes what the compile wrote that is not on disk, each file
 * whole; the manifest last, once every file it describes is in place and none it does not is left.
 * Answers whether it changed anything.
 *
 * The files to take away go first, as in the compiler's own write (`writeOutputs`): where the file
 * system keeps no case (macOS, Windows), a file of a name that differs from an output's in case
 * alone is that output's, and the output put in place first would be taken away with the old
 * spelling after it. What is on disk is read again once they are gone, since an output that was
 * there under the spelling of one of them is there no more. A directory an earlier compile's files
 * were in, emptied, blocks no file that takes its name.
 */
export function writeCompiled(outputs: ReadonlyMap<string, string>, outDir: string): boolean {
  const manifest = path.join(outDir, MANIFEST);
  const root = path.resolve(outDir);
  const found = writeOutputs(outputs, outDir, { check: true });
  const leftovers = found.filter((output) => output.leftover);
  for (const { path: file } of leftovers) {
    rmSync(file, { force: true });
    removeEmptied(path.dirname(file), root);
  }
  const checked = leftovers.length === 0 ? found : writeOutputs(outputs, outDir, { check: true });
  const stale = checked
    .filter((output) => !output.current && !output.leftover)
    .toSorted((left, right) => Number(left.path === manifest) - Number(right.path === manifest));
  for (const { path: file } of stale) {
    const text = outputs.get(file);
    if (text !== undefined) {
      writeWhole(file, text);
    }
  }
  return leftovers.length > 0 || stale.length > 0;
}
