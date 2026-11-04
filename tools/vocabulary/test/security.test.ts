import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { errorAnnotation, plainDiagnostic } from '../src/annotate.ts';
import { boundedFile, MAX_FILE_BYTES, readRepositoryFile } from '../src/read.ts';
import { hitsOfFile } from '../src/scan.ts';
import { FIXTURE_ALLOWED, FIXTURE_TERMS } from './fixture-terms.ts';

describe('vocabulary security', () => {
  const directories: string[] = [];
  function directory(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'vocabulary-security-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('bounded repository reads', () => {
    it('reads an ordinary file at the bound and rejects per-file and cumulative overflow', () => {
      const root = directory();
      writeFileSync(path.join(root, 'source'), Buffer.alloc(MAX_FILE_BYTES, 0x61));

      expect(boundedFile(root, 'source')).toHaveLength(MAX_FILE_BYTES);
      expect(() => boundedFile(root, 'source', MAX_FILE_BYTES - 1)).toThrow('byte budget');

      writeFileSync(path.join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1));

      expect(() => boundedFile(root, 'large')).toThrow('byte budget');
    });

    it('refuses a directory', () => {
      const root = directory();
      mkdirSync(path.join(root, 'dir'));

      expect(() => boundedFile(root, 'dir')).toThrow('regular file');
    });

    // Windows refuses to make a symbolic link without a privilege a test cannot count on (EPERM).
    it.skipIf(process.platform === 'win32')(
      'refuses symlinks, and a parent that escapes the repository',
      () => {
        const root = directory();
        const outside = directory();
        writeFileSync(path.join(outside, 'file'), 'private');
        symlinkSync(path.join(outside, 'file'), path.join(root, 'link'));
        symlinkSync(outside, path.join(root, 'parent'), 'dir');

        expect(() => boundedFile(root, 'link')).toThrow('regular file');
        expect(() => boundedFile(root, 'parent/file')).toThrow('outside the repository');
      },
    );

    it('leaves a binary past the bound unread, by what its first bytes are', () => {
      const root = directory();
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(MAX_FILE_BYTES),
      ]);
      writeFileSync(path.join(root, 'large.png'), png);

      expect(readRepositoryFile(root, 'large.png').text).toBeUndefined();
    });

    it('still refuses text past the bound, whatever the name says it is', () => {
      const root = directory();
      writeFileSync(path.join(root, 'large.png'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
      writeFileSync(path.join(root, 'large.ts'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));

      expect(() => readRepositoryFile(root, 'large.png')).toThrow('byte budget');
      expect(() => readRepositoryFile(root, 'large.ts')).toThrow('byte budget');
    });

    it.skipIf(process.platform === 'win32')('refuses a FIFO before trying to read it', () => {
      const root = directory();
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- mkfifo creates only this test's private FIFO.
      execFileSync('mkfifo', [path.join(root, 'pipe')]);

      expect(() => boundedFile(root, 'pipe')).toThrow('regular file');
    });
  });

  it('keeps exact locations across sparse lines and repeated hits', () => {
    const text = `widget\n${'\n'.repeat(1000)}  widget widget\n`;

    expect(
      hitsOfFile('source', text, FIXTURE_TERMS, FIXTURE_ALLOWED).map(({ line, column }) => ({
        line,
        column,
      })),
    ).toStrictEqual([
      { line: 1, column: 1 },
      { line: 1002, column: 3 },
      { line: 1002, column: 10 },
    ]);
  });

  it('escapes DEL, the C1 controls and the Unicode line separators too', () => {
    expect(plainDiagnostic('a\u{7F}b\u{9B}31mc\u{85}d\u{2028}e\u{2029}f')).toBe(
      String.raw`a\u007fb\u009b31mc\u0085d\u2028e\u2029f`,
    );
  });

  it('keeps hostile filenames and errors within one diagnostic line', () => {
    const message = 'a\n::warning::forged\r\u{1B}[31m%';

    expect(plainDiagnostic(message)).toBe(String.raw`a\n::warning::forged\r\u001b[31m%`);
    expect(errorAnnotation(message)).toBe(
      '::error title=vocabulary::a%0A::warning::forged%0D\u{1B}[31m%25',
    );
  });
});
