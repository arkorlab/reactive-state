import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
