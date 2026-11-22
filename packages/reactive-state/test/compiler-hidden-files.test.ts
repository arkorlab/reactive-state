import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * The components the compile collects from the application's source directory: each file whose name
 * ends in `.reactive.tsx`, at any depth, but none of a directory it holds no component of — a
 * package's, one that is hidden, the one it writes into — and none of a hidden file. A volume that
 * keeps no extended attributes writes them beside each file of a copied project as a file of its own
 * (`._Board.reactive.tsx`, AppleDouble metadata, which is no text), and a hidden file is no
 * component its author wrote for the application.
 *
 * Each row compiles a small application and reads what it refuses and which components it wrote.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

const BOARD = [
  "import { useReactiveState } from 'framework/react';",
  'export default function Board() {',
  '  const [count, setCount] = useReactiveState(0);',
  '  return <button type="button" onClick={() => setCount(count + 1)}>{count}</button>;',
  '}',
  '',
].join('\n');

/** What AppleDouble metadata begins with: its magic number and version, then the system's name. */
const APPLE_DOUBLE = Buffer.from([
  0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63, 0x20, 0x4f, 0x53, 0x20, 0x58,
]);

/** The components the application of `files` has compiled, by their ids, and what it refused. */
function compiled(files: Readonly<Record<string, Buffer | string>>): {
  readonly components: readonly string[];
  readonly refusals: readonly string[];
} {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-hidden-files-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const written = Object.entries({ 'db.ts': DATABASE, ...files });
  for (const [name, content] of written) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  }
  mkdirSync(path.join(source, 'app'), { recursive: true });
  const result = compileApp({
    api,
    appDir: path.join(source, 'app'),
    outDir: path.join(root, '.reactive'),
    srcDir: source,
  });
  // As `/`-separated paths, which `path.relative` writes with `\` where the system's separator is.
  const outputs = [...result.outputs.keys()].map((file) =>
    path.relative(root, file).split(path.sep).join('/'),
  );
  return {
    components: outputs
      .filter((file) => file.endsWith('.authority.mts'))
      .map((file) => file.slice('.reactive/'.length, -'.authority.mts'.length))
      .toSorted((a, b) => a.localeCompare(b)),
    refusals: result.refusals.map((refusal) => refusal.message),
  };
}

describe('the components the compile collects', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a hidden file is none', () => {
    it('appleDouble metadata beside a component, named as it is', () => {
      const { components, refusals } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/._Board.reactive.tsx': APPLE_DOUBLE,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/Board']);
    });

    it('a hidden file that holds a component, beside one that is not', () => {
      const { components, refusals } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/.Draft.reactive.tsx': BOARD,
        'components/._Copy.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/Board']);
    });

    it('a hidden file in a directory the compile reads', () => {
      const { components, refusals } = compiled({
        'components/deep/._Board.reactive.tsx': APPLE_DOUBLE,
        'components/deep/Board.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/deep/Board']);
    });
  });

  describe('what was collected, or skipped, stays so', () => {
    it('a component, and one in a nested directory', () => {
      const { components, refusals } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/deep/more/Other.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/Board', 'components/deep/more/Other']);
    });

    it('a component whose name holds a dot after its first letter', () => {
      const { components, refusals } = compiled({
        'components/Board.v2.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toHaveLength(1);
    });

    it.each([
      { directory: 'components/.cache', id: 'a hidden directory' },
      { directory: 'node_modules/package', id: 'a package' },
    ])('$id is skipped', ({ directory }) => {
      const { components, refusals } = compiled({
        'components/Board.reactive.tsx': BOARD,
        [`${directory}/Other.reactive.tsx`]: BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/Board']);
    });

    it('a file that is no component, hidden or not, is read as it was', () => {
      const { components, refusals } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/._notes.txt': APPLE_DOUBLE,
        'components/helper.ts': 'export const label = "board";\n',
      });

      expect(refusals).toStrictEqual([]);
      expect(components).toStrictEqual(['components/Board']);
    });
  });
});
