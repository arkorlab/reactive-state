import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  type PathLike,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GENERATED } from '../src/compiler/app-route.ts';
import { compileProject, DIGEST_FILE } from '../src/next/compile-on-build.ts';
import { writeCompiled } from '../src/next/write-compiled.ts';

/**
 * What the write of a build's compile does with what an earlier build left, which is what the
 * compiler's own write does with it (`writeOutputs`, and its suite): a file an earlier build wrote
 * that this one does not is taken away, and the directories that leaves empty, before anything is
 * put in place. Where the file system keeps no case (macOS, Windows), a file of a name that differs
 * from an output's in case alone is that output's: put in place first, the output would be taken
 * away with the old spelling after it, the build going on with the file gone. What the build's write
 * does beside that is kept: each file is written beside where it goes and renamed over it, and the
 * manifest is put in place last, after every file it describes.
 *
 * The order is read from the calls the module makes, which holds on any file system. A row of one
 * file under two spellings makes the two one in the calls it stands in for, where the file system
 * keeps them apart.
 */

/**
 * What the module under test took away and put in place, in order, while `logging` is on; and the
 * files that are one under two names (`oneFile`): taking the first away takes the second.
 */
const calls = vi.hoisted(() => {
  const oneFile = new Map<string, string>();
  return { log: [] as string[], logging: false, oneFile };
});

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renameSync: (from: PathLike, to: PathLike): void => {
      if (calls.logging) {
        calls.log.push(`put ${String(to)}`);
      }
      actual.renameSync(from, to);
    },
    rmSync: (...given: Parameters<typeof actual.rmSync>) => {
      if (calls.logging) {
        calls.log.push(`remove ${String(given[0])}`);
      }
      actual.rmSync(...given);
      const same = calls.oneFile.get(String(given[0]));
      if (same !== undefined) {
        actual.rmSync(same, { force: true });
      }
    },
  };
});

const dirs: string[] = [];

/** A file the compile wrote, of `body`. */
const generated = (body: string): string =>
  `${GENERATED} from components/Board.reactive.tsx. Do not edit: change the component and compile it again.\n${body}\n`;

/** A directory of its own, and the output directory of a build in it. */
function workspace(): { readonly outDir: string; readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-leftovers-'));
  dirs.push(root);
  return { outDir: path.join(root, '.reactive'), root };
}

/** Writes each of `files`, by its path from `directory`. */
function put(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  }
}

/** `files`, by their paths from `outDir`, as the compile hands its outputs to a write. */
function outputsOf(outDir: string, files: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(files).map(([file, text]) => [path.join(outDir, file), text]));
}

/** The names under `directory`, with their spelling on disk. */
function listing(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true })
    .map(String)
    .toSorted((a, b) => a.localeCompare(b));
}

/** What was taken away and put in place under `outDir` while the log was on, by path from it. */
function logged(outDir: string): readonly string[] {
  return calls.log.map((call) => call.replace(`${outDir}${path.sep}`, ''));
}

/**
 * Whether a directory nobody may read is one here: not for the superuser, and not on a volume that
 * keeps no permissions of a directory, where a row about a directory the scan cannot read has none
 * to show.
 */
function unreadableHere(): boolean {
  if (process.getuid?.() === 0) {
    return false;
  }
  const probe = mkdtempSync(path.join(tmpdir(), 'reactive-state-permission-probe-'));
  const blocked = path.join(probe, 'blocked');
  try {
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    readdirSync(blocked);
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(probe, { force: true, recursive: true });
  }
}

const UNREADABLE = unreadableHere();

/** A component, and the page that renders it, by the name of the component's file. */
function sources(name: string): Readonly<Record<string, string>> {
  return {
    'src/app/page.tsx': [
      `import Hello from '@/components/${name}.reactive';`,
      '',
      'export default function Page() {',
      '  return <Hello name="world" />;',
      '}',
      '',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
    }),
  };
}

const HELLO = [
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>Hello, {name}</p>;',
  '}',
  '',
].join('\n');

describe('what the write of a build’s compile does with the files an earlier build left', () => {
  afterEach(() => {
    calls.logging = false;
    calls.log.length = 0;
    calls.oneFile.clear();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a file the build no longer writes is taken away before the outputs are put in place', () => {
    it('the old spelling of an output goes first, and the output is put in place after it', () => {
      const { outDir } = workspace();
      put(outDir, { 'components/Board.authority.mts': generated('before') });
      const outputs = outputsOf(outDir, { 'components/board.authority.mts': generated('after') });
      calls.logging = true;

      const changed = writeCompiled(outputs, outDir);

      expect(logged(outDir)).toStrictEqual([
        'remove components/Board.authority.mts',
        'put components/board.authority.mts',
      ]);
      expect(changed).toBe(true);
      expect(listing(outDir)).toStrictEqual(['components', 'components/board.authority.mts']);
      expect(readFileSync(path.join(outDir, 'components/board.authority.mts'), 'utf8')).toBe(
        generated('after'),
      );
    });

    it('the manifest is put in place last, after what is taken away and every other file, wherever the compile lists it', () => {
      const { outDir } = workspace();
      put(outDir, {
        'components/Board.root.tsx': generated('before'),
        'manifest.json': '{ "of": "the build before" }\n',
      });
      const outputs = outputsOf(outDir, {
        'manifest.json': '{ "of": "this build" }\n',
        'authority.mts': generated('authority'),
        'components/board.root.tsx': generated('after'),
      });
      calls.logging = true;

      writeCompiled(outputs, outDir);

      expect(logged(outDir)).toStrictEqual([
        'remove components/Board.root.tsx',
        'put authority.mts',
        'put components/board.root.tsx',
        'put manifest.json',
      ]);
    });

    it('an output whose text is unchanged is put in place again where taking its old spelling away took it', () => {
      const { outDir } = workspace();
      const old = path.join(outDir, 'Board.authority.mts');
      const output = path.join(outDir, 'board.authority.mts');
      // One file under two spellings, as it is where the file system keeps no case; where it keeps
      // them apart, the two are made one in the call that takes the old spelling away.
      put(outDir, { 'Board.authority.mts': generated('same') });
      writeFileSync(output, generated('same'));
      calls.oneFile.set(old, output);

      const changed = writeCompiled(new Map([[output, generated('same')]]), outDir);

      expect(changed).toBe(true);
      expect(listing(outDir)).toStrictEqual(['board.authority.mts']);
      expect(readFileSync(output, 'utf8')).toBe(generated('same'));
    });

    it('nothing is taken away or put in place where the outputs are on disk already', () => {
      const { outDir } = workspace();
      const outputs = outputsOf(outDir, {
        'components/board.authority.mts': generated('kept'),
        'manifest.json': '{}\n',
      });
      writeCompiled(outputs, outDir);
      calls.logging = true;

      const changed = writeCompiled(outputs, outDir);

      expect(changed).toBe(false);
      expect(logged(outDir)).toStrictEqual([]);
    });
  });

  describe('the directories a file taken away leaves empty go with it', () => {
    it('each one above it below the output directory, and one that holds another file stays', () => {
      const { outDir } = workspace();
      put(outDir, {
        'old/inner/Gone.authority.mts': generated('gone'),
        'shared/Gone.authority.mts': generated('gone'),
        'shared/notes.md': 'a file of the application’s',
      });
      const outputs = outputsOf(outDir, { 'kept.authority.mts': generated('kept') });

      writeCompiled(outputs, outDir);

      expect(listing(outDir)).toStrictEqual(['kept.authority.mts', 'shared', 'shared/notes.md']);
    });

    it('the output directory itself stays where a build writes nothing into it', () => {
      const { outDir } = workspace();
      put(outDir, { 'Gone.authority.mts': generated('gone') });

      const changed = writeCompiled(new Map(), outDir);

      expect(changed).toBe(true);
      expect(listing(outDir)).toStrictEqual([]);
    });

    it('a directory renamed in case alone is made under its new spelling', () => {
      const { outDir } = workspace();
      put(outDir, { 'Cards/Board.authority.mts': generated('before') });
      const outputs = outputsOf(outDir, { 'cards/Board.authority.mts': generated('after') });

      writeCompiled(outputs, outDir);

      expect(listing(outDir)).toStrictEqual(['cards', 'cards/Board.authority.mts']);
    });

    it('a directory the files of an earlier build were in does not block the file that takes its name', () => {
      const { outDir } = workspace();
      put(outDir, { 'reports.ts/Board.authority.mts': generated('before') });
      const outputs = outputsOf(outDir, { 'reports.ts': generated('after') });

      writeCompiled(outputs, outDir);

      expect(listing(outDir)).toStrictEqual(['reports.ts']);
      expect(readFileSync(path.join(outDir, 'reports.ts'), 'utf8')).toBe(generated('after'));
    });

    it('a file of an earlier build does not block the directory that takes its name', () => {
      const { outDir } = workspace();
      put(outDir, { 'reports.ts': generated('before') });
      const outputs = outputsOf(outDir, { 'reports.ts/Board.authority.mts': generated('after') });

      writeCompiled(outputs, outDir);

      expect(listing(outDir)).toStrictEqual(['reports.ts', 'reports.ts/Board.authority.mts']);
    });

    it('a directory that holds a file of the application’s stays: the error names its path, and the manifest of the build before is still in place', () => {
      const { outDir } = workspace();
      put(outDir, {
        'manifest.json': '{ "of": "the build before" }\n',
        'reports.ts/Board.authority.mts': generated('before'),
        'reports.ts/notes.md': 'a file of the application’s',
      });
      const outputs = outputsOf(outDir, {
        'manifest.json': '{ "of": "this build" }\n',
        'reports.ts': generated('after'),
      });

      expect(() => writeCompiled(outputs, outDir)).toThrow(path.join(outDir, 'reports.ts'));
      expect(listing(outDir)).toStrictEqual(['manifest.json', 'reports.ts', 'reports.ts/notes.md']);
      expect(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).toBe(
        '{ "of": "the build before" }\n',
      );
    });
  });

  describe('a directory the scan cannot read is reported, with its path', () => {
    afterEach(() => {
      for (const dir of dirs) {
        const blocked = path.join(dir, '.reactive/blocked');
        if (existsSync(blocked)) {
          chmodSync(blocked, 0o700);
        }
      }
    });

    it.skipIf(!UNREADABLE)('nothing is taken away or put in place over it', () => {
      const { outDir } = workspace();
      put(outDir, { 'stale.authority.mts': generated('stale') });
      const blocked = path.join(outDir, 'blocked');
      mkdirSync(blocked);
      chmodSync(blocked, 0o000);
      const outputs = outputsOf(outDir, { 'kept.authority.mts': generated('kept') });
      calls.logging = true;

      expect(() => writeCompiled(outputs, outDir)).toThrow(blocked);
      expect(logged(outDir)).toStrictEqual([]);
      expect(readdirSync(outDir).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
        'blocked',
        'stale.authority.mts',
      ]);
    });
  });

  describe('a build', () => {
    it('takes what the build before wrote for a component away before it puts in place what it writes for it under its new name', async () => {
      const { outDir, root } = workspace();
      put(root, { ...sources('Hello'), 'src/components/Hello.reactive.tsx': HELLO });
      await compileProject({ projectDir: root });
      renameSync(
        path.join(root, 'src/components/Hello.reactive.tsx'),
        path.join(root, 'src/components/hello.reactive.tsx'),
      );
      put(root, sources('hello'));
      calls.logging = true;

      await compileProject({ projectDir: root });

      const last = new Set([`put ${DIGEST_FILE}`, 'put manifest.json']);
      const written = logged(outDir).filter(
        (call) => call.includes(' components/') || last.has(call),
      );

      expect(written).toStrictEqual([
        'remove components/Hello.authority.mts',
        'remove components/Hello.root.tsx',
        'put components/hello.authority.mts',
        'put components/hello.root.tsx',
        'put manifest.json',
        `put ${DIGEST_FILE}`,
      ]);
      expect(listing(path.join(outDir, 'components'))).toStrictEqual([
        'hello.authority.mts',
        'hello.root.tsx',
      ]);
      // What it wrote is all there: the build after it compiles nothing.
      await expect(compileProject({ projectDir: root })).resolves.toMatchObject({
        changed: false,
        compiled: false,
      });
    });
  });
});
