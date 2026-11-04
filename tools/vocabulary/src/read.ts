import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { isBinaryKind, textOf } from './scan.ts';

const KIB = 1024;
const MIB = KIB * KIB;
const SCAN_MIB = 64;
const CHUNK_KIB = 64;
/** Matches the source archive's per-source bound; a violation fails the gate, never skips a file. */
export const MAX_FILE_BYTES = MIB;
/** The scanner already allows this much Git output; retained source bytes have the same ceiling. */
export const MAX_SCAN_BYTES = SCAN_MIB * MIB;
const CHUNK_BYTES = CHUNK_KIB * KIB;
const SNIFF_KIB = 8;
/** How much of a file of a binary kind is read to tell whether it is binary, as Git's own guess does. */
export const SNIFF_BYTES = SNIFF_KIB * KIB;

/**
 * A file's bytes, read within the budget: the whole file, refused past `MAX_FILE_BYTES` or what
 * remains of the budget, or — given `prefix` — no more than its first `prefix` bytes, however long it
 * is. Either way only a regular file inside the repository is opened, and it is the file that was
 * looked at.
 */
export function boundedFile(
  root: string,
  file: string,
  remaining = MAX_SCAN_BYTES,
  prefix?: number,
): Buffer {
  const location = path.resolve(root, file);
  const relative = path.relative(realpathSync(root), realpathSync(path.dirname(location)));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the repository`);
  }
  const before = lstatSync(location);
  if (!before.isFile()) throw new Error(`${file} is not a regular file`);
  const limit = Math.min(prefix ?? MAX_FILE_BYTES, remaining);
  if (prefix === undefined && before.size > limit) {
    throw new Error(`${file} exceeds the vocabulary byte budget`);
  }
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : // eslint-disable-next-line no-bitwise -- operating-system file flags are combined as a mask.
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(location, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${file} changed while opening or is not a regular file`);
    }
    return prefix === undefined ? readWhole(fd, file, limit) : readPrefix(fd, limit);
  } finally {
    closeSync(fd);
  }
}

/** All of an open file, refused once it is past `limit` bytes. */
function readWhole(fd: number, file: string, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, limit - total + 1));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > limit) throw new Error(`${file} exceeds the vocabulary byte budget`);
    chunks.push(chunk.subarray(0, count));
  }
  throw new Error(`${file} exceeds the vocabulary byte budget`);
}

/** The first `limit` bytes of an open file, or all of it where it is shorter. */
function readPrefix(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, limit - total));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Whether a file's first bytes say it is binary: a NUL, or a byte that is not UTF-8. A character cut
 * off where the prefix ends is no such byte.
 */
function startsBinary(prefix: Uint8Array): boolean {
  if (prefix.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true });
    return false;
  } catch {
    return true;
  }
}

/** What a file of the repository is read as: how many of its bytes were read, and its text, if any. */
export interface RepositoryFile {
  readonly bytes: number;
  readonly text: string | undefined;
}

/**
 * A file of the repository, read within the budget and as `textOf` reads it. A file of a binary kind
 * is first read only as far as `SNIFF_BYTES`: where those bytes say it is binary, the rest is not
 * read at all, so a binary is never refused for its size — while one that reads as text is read
 * whole, and refused past the bound, as any text is.
 */
export function readRepositoryFile(
  root: string,
  file: string,
  remaining = MAX_SCAN_BYTES,
): RepositoryFile {
  if (isBinaryKind(file)) {
    const prefix = boundedFile(root, file, remaining, SNIFF_BYTES);
    if (startsBinary(prefix)) return { bytes: prefix.byteLength, text: undefined };
  }
  const bytes = boundedFile(root, file, remaining);
  return { bytes: bytes.byteLength, text: textOf(file, bytes) };
}
