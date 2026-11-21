import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A prop that holds a function is none an update captures: the call of the update sends what it
 * captures to the authority, which runs the update there, and a function is no value it can be sent.
 * The prop is found in the type the component annotates its props with, by the name of the member,
 * whether the member is written as a name or as a string — `onSave: () => void`, `"onSave": () =>
 * void`, `'onSave': () => void` — as the type of a captured prop is found (`propType`).
 *
 * Each row compiles a small application of one component through the compile's entry (`compileApp`),
 * whose update calls, or reads, a prop, and reads what it refuses.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** A component whose props' type holds `members`, and whose update of the title runs `update`. */
function component(members: string, update: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    "import { db } from '@/db';",
    `export default async function Lab({ id, label, onSave }: { id: string; ${members} }) {`,
    '  const ref = db.todos.ref(id);',
    '  const [title, setTitle] = useReactiveState(ref.title);',
    [
      '  return <button type="button" onClick={() => setTitle((current) => ',
      update,
      ')}>',
      '{title}',
      '</button>;',
    ].join(''),
    '}',
    '',
  ].join('\n');
}

/** What compiling the application of the one component `text` refused. */
function refusals(text: string): readonly string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-quoted-props-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const files = Object.entries({ 'components/lab.reactive.tsx': text, 'db.ts': DATABASE });
  for (const [name, content] of files) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  }
  mkdirSync(path.join(source, 'app'), { recursive: true });
  return compileApp({
    api,
    appDir: path.join(source, 'app'),
    outDir: path.join(root, '.reactive'),
    srcDir: source,
  }).refusals.map((refusal) => refusal.message);
}

const FUNCTION = 'is a function, which an update does not capture';

describe('a prop that holds a function, which an update captures none of', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a member written as a name, or as a string, is found', () => {
    it.each([
      { id: 'a name', members: 'label: string; onSave: () => void' },
      { id: 'a double-quoted string', members: 'label: string; "onSave": () => void' },
      { id: 'a single-quoted string', members: "label: string; 'onSave': () => void" },
      {
        id: 'a string among members that all are strings',
        members: '"label": string; "onSave": () => void',
      },
    ])('$id: an update that calls it is refused', ({ members }) => {
      const found = refusals(component(members, '{ onSave(); return current; }'));

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });
  });

  describe('a prop that holds no function is captured, as it was', () => {
    it.each([
      { id: 'a name', members: 'label: string; onSave: () => void' },
      { id: 'a double-quoted string', members: '"label": string; "onSave": () => void' },
    ])('$id: an update that reads the other prop is taken', ({ members }) => {
      expect(refusals(component(members, 'current + label'))).toStrictEqual([]);
    });
  });
});
