import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * The copy of a module of custom hooks that the browser runs types a parameter a state is declared
 * with as it is by a wrapper it imports from the framework — `LocalStateInput<T>` of a local state's
 * value, `StateInput<T>` of what may bind a field. A module that declares the name of the wrapper it
 * uses too — as a hook's type parameter, or a type of its own — would have the wrapper, written
 * inside the hook or beside the type, name that instead, and the copy would not type-check
 * (`LocalStateInput<LocalStateInput>` of a type parameter), so the compile refuses the module, naming
 * the declaration. A name that is none of the wrappers the module uses is as it was.
 *
 * Each row compiles a small application — a component and a module of one hook — through `compileApp`
 * and reads what it refuses and what the copy of the module holds.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** A component that calls the hook `useCounter` with a local state's start. */
const LOCAL = [
  "import { useCounter } from '@/hooks/counter';",
  'export default function Board() {',
  '  const { count, up } = useCounter(0);',
  '  return <button type="button" onClick={up}>{count}</button>;',
  '}',
  '',
].join('\n');

/** A component that calls the hook `useCounter` with the title of a record, which binds a field. */
const PERSISTENT = [
  "import { db } from '@/db';",
  "import { useCounter } from '@/hooks/counter';",
  'export default async function Board({ id }: { id: string }) {',
  '  const { count, up } = useCounter(db.todos.ref(id).title);',
  '  return <button type="button" onClick={up}>{count}</button>;',
  '}',
  '',
].join('\n');

/** The import of the type a hook's parameter takes a field's reference by. */
const FIELD_REF = "import type { FieldRef } from '@arkorlab/reactive-state/program';";

/** A module of one hook, whose state is started by its parameter `initial`, typed `annotation`. */
function hook(typeParameters: string, annotation: string, before = ''): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    before,
    `export function useCounter${typeParameters}(initial: ${annotation}) {`,
    '  const [count, setCount] = useReactiveState(initial);',
    '  return { count, up: () => { setCount(count); } };',
    '}',
    '',
  ].join('\n');
}

interface Compiled {
  readonly refusals: readonly string[];
  /** The copy of the module of hooks. */
  readonly copy: string;
}

/** The build of the application of the component `board` and the module of hooks `hooks`. */
function compiled(board: string, hooks: string): Compiled {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-hook-wrappers-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const files = Object.entries({
    'components/Board.reactive.tsx': board,
    'db.ts': DATABASE,
    'hooks/counter.ts': hooks,
  });
  for (const [name, content] of files) {
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
  const copy = [...result.outputs].find(([file]) => file.endsWith('hooks/counter.ts'));
  return { copy: copy?.[1] ?? '', refusals: result.refusals.map((refusal) => refusal.message) };
}

const NAMES = "is a name the copy of this module writes a parameter's type by";

describe('the names a module of hooks declares, beside the wrappers its copy writes', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a declaration of the name of a wrapper the module uses is refused', () => {
    it.each([
      {
        id: 'a type parameter named `LocalStateInput`, where a local state is started',
        board: LOCAL,
        hooks: hook('<LocalStateInput extends number>', 'LocalStateInput'),
        name: 'LocalStateInput',
      },
      {
        id: 'a type parameter named `StateInput`, where a field is bound',
        board: PERSISTENT,
        hooks: hook('<StateInput extends string>', 'FieldRef<StateInput>', FIELD_REF),
        name: 'StateInput',
      },
      {
        id: 'a type of the module named `LocalStateInput`',
        board: LOCAL,
        hooks: hook('', 'LocalStateInput', 'type LocalStateInput = number;'),
        name: 'LocalStateInput',
      },
      {
        id: 'an interface of the module named `StateInput`',
        board: PERSISTENT,
        hooks: hook(
          '',
          'FieldRef<string>',
          `${FIELD_REF}\ninterface StateInput { readonly n: string }`,
        ),
        name: 'StateInput',
      },
    ])('$id', ({ board, hooks, name }) => {
      const { refusals } = compiled(board, hooks);

      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain(`\`${name}\` ${NAMES}`);
    });
  });

  describe('a name that is none of the wrappers the module uses is as it was', () => {
    it('a type parameter of another name', () => {
      const { copy, refusals } = compiled(LOCAL, hook('<T extends number>', 'T'));

      expect(refusals).toStrictEqual([]);
      expect(copy).toContain('initial: LocalStateInput<T>');
    });

    it('a type parameter named as the wrapper the module does not use', () => {
      const { copy, refusals } = compiled(LOCAL, hook('<StateInput extends number>', 'StateInput'));

      expect(refusals).toStrictEqual([]);
      expect(copy).toContain('initial: LocalStateInput<StateInput>');
    });
  });
});
