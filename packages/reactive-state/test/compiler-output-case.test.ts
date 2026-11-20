import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * No two files of what the compile writes are one file where the file system keeps no case (macOS,
 * Windows): the compile writes a copy of each module of custom hooks, and a stub of each `'use
 * server'` module, under the module's own name, beside the files it names itself (`elements.ts`,
 * `server-functions.ts`, `request-session.ts`), and three files of each component under its id.
 * Two of them that differ in case alone are written one over the other there — the later text
 * replaces the earlier, and a check finds one of them stale on every run — so the compile refuses
 * the build, naming both. Two that differ in more than case are as they were.
 *
 * Each row compiles a small application through `compileApp` and reads what it refuses and writes.
 * This system keeps case, so a refusal is shown by the two paths it names and a success by the two
 * distinct paths it writes, not by an overwrite.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** A component with state, which no module of the rows imports. */
const BOARD = [
  "import { useReactiveState } from 'framework/react';",
  'export default function Board() {',
  '  const [count, setCount] = useReactiveState(0);',
  '  return <button type="button" onClick={() => setCount(count + 1)}>{count}</button>;',
  '}',
  '',
].join('\n');

/** A `'use server'` module of one function. */
const ACTIONS = [
  "'use server';",
  'export async function save(form: FormData): Promise<void> {',
  '  void form;',
  '}',
  '',
].join('\n');

/** A module of custom hooks, of one hook. */
const HOOKS = [
  "import { useReactiveState } from 'framework/react';",
  'export function useCounter() {',
  '  const [count, setCount] = useReactiveState(0);',
  '  return { count, up: () => { setCount(count + 1); } };',
  '}',
  '',
].join('\n');

/** A component that submits the `'use server'` module `specifier` names. */
function submitting(specifier: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    `import { save } from '${specifier}';`,
    'export default function Board() {',
    '  const [count] = useReactiveState(0);',
    '  return <form action={save}><button type="submit">{count}</button></form>;',
    '}',
    '',
  ].join('\n');
}

/** A component that counts with the module of hooks `@/Elements` is. */
const COUNTING = [
  "import { useCounter } from '@/Elements';",
  'export default function Board() {',
  '  const { count, up } = useCounter();',
  '  return <button type="button" onClick={up}>{count}</button>;',
  '}',
  '',
].join('\n');

const SESSION_SOURCE = 'export const session = () => null;\n';

interface Compiled {
  /** What the build writes, by its path from the application's root. */
  readonly written: readonly string[];
  readonly refusals: readonly string[];
}

/** The build of the application of `files` (under `src`), with the session source `session` names. */
function compiled(files: Readonly<Record<string, string>>, session?: string): Compiled {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-output-case-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const sources = Object.entries({ 'db.ts': DATABASE, ...files });
  for (const [name, content] of sources) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  }
  mkdirSync(path.join(source, 'app'), { recursive: true });
  const result = compileApp({
    api,
    appDir: path.join(source, 'app'),
    outDir: path.join(root, '.reactive'),
    srcDir: source,
    ...(session !== undefined && { session }),
  });
  return {
    refusals: result.refusals.map((refusal) => refusal.message),
    written: [...result.outputs.keys()]
      .map((file) => path.relative(path.join(root, '.reactive'), file))
      .toSorted((a, b) => a.localeCompare(b)),
  };
}

describe('what the compile writes, where the file system keeps no case', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('two files that differ in case alone are refused, naming both', () => {
    it('a `use server` module named as the elements are, but for case', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': submitting('@/Elements'),
        'Elements.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([
        "elements.ts:1:1: Two of what the compile writes, `Elements.ts` and `elements.ts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
      expect(written).toStrictEqual([]);
    });

    it('a module of hooks named as the elements are, but for case', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': COUNTING,
        'Elements.ts': HOOKS,
      });

      expect(refusals).toStrictEqual([
        "elements.ts:1:1: Two of what the compile writes, `Elements.ts` and `elements.ts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
      expect(written).toStrictEqual([]);
    });

    it('a `use server` module named as the server functions are, but for case', () => {
      const { refusals } = compiled({
        'components/Board.reactive.tsx': submitting('@/Server-Functions'),
        'Server-Functions.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([
        "server-functions.ts:1:1: Two of what the compile writes, `Server-Functions.ts` and `server-functions.ts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
    });

    it('a `use server` module named as the session source’s re-export is, but for case', () => {
      const { refusals } = compiled(
        {
          'components/Board.reactive.tsx': submitting('@/Request-Session'),
          'Request-Session.ts': ACTIONS,
          'session.ts': SESSION_SOURCE,
        },
        '@/session#session',
      );

      expect(refusals).toStrictEqual([
        "request-session.ts:1:1: Two of what the compile writes, `Request-Session.ts` and `request-session.ts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
    });

    it('two components whose ids differ in case alone', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/board.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([
        "components/board.authority.mts:1:1: Two of what the compile writes, `components/Board.authority.mts` and `components/board.authority.mts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
      expect(written).toStrictEqual([]);
    });

    it('two components in directories that differ in case alone', () => {
      const { refusals } = compiled({
        'components/Board/Card.reactive.tsx': BOARD,
        'components/board/Card.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([
        "components/board/Card.authority.mts:1:1: Two of what the compile writes, `components/Board/Card.authority.mts` and `components/board/Card.authority.mts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
    });
  });

  describe('what differs in more than case, or is not two files, is as it was', () => {
    it('a module named as the elements are, in the case they are written in, is refused as before', () => {
      const { refusals } = compiled({
        'components/Board.reactive.tsx': submitting('@/elements'),
        'elements.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([
        "elements.ts:1:1: Two of what the compile writes are `elements.ts`: rename the module of the application's that takes the name.",
      ]);
    });

    it('a `use server` module whose name only starts as the elements’ do', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': submitting('@/Elements-list'),
        'Elements-list.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('Elements-list.ts');
      expect(written).toContain('elements.ts');
    });

    it('a module of hooks whose extension is not the elements’', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': COUNTING,
        'Elements.tsx': HOOKS,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('Elements.tsx');
      expect(written).toContain('elements.ts');
    });

    it('two components of one name in directories of their own', () => {
      const { refusals, written } = compiled({
        'components/a/Board.reactive.tsx': BOARD,
        'components/b/Board.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('components/a/Board.root.tsx');
      expect(written).toContain('components/b/Board.root.tsx');
    });

    it('two components whose ids differ in more than case', () => {
      const { refusals, written } = compiled({
        'components/Board.reactive.tsx': BOARD,
        'components/Boards.reactive.tsx': BOARD,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('components/Board.authority.mts');
      expect(written).toContain('components/Boards.authority.mts');
    });

    it('a component named as the registry is, whose files carry their own suffixes', () => {
      const { refusals, written } = compiled({ 'Authority.reactive.tsx': BOARD });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('Authority.authority.mts');
      expect(written).toContain('authority.mts');
    });
  });
});
