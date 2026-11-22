import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A name an update captures is a value of its owner's — a component's prop, a hook's parameter —
 * and its call sends it to the authority as JSON, which drops a function: the authority's copy of the
 * update, run with what arrived, calls what is not there (`TypeError: onSave is not a function`). The
 * compile reads the type of the owner's code for a function — a component's props written as an
 * inline type literal with a function type for the member, a hook's parameter written as a function
 * type — and of an imported type, an alias or an interface the owner names, it reads nothing. So an
 * update that calls a name it captures is refused, whatever the name's type is written as: what is
 * called is a function. One that only hands the name on is taken as it was where the type is
 * imported, and refused where it is written as a function type.
 *
 * Each row compiles a small application through the compile's entry (`compileApp`) — one component,
 * or a component and a module of one hook, whose update calls, or reads, the name — and reads what
 * it refuses.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** The types of the application's own that the rows import. */
const TYPES = [
  'export type Props = { id: string; onSave: () => void };',
  'export interface Shape { id: string; onSave: () => void }',
  'export type Save = () => void;',
  'export type SaveProps = { id: string; onSave: Save };',
  'export type OptionalProps = { id: string; onSave?: () => void };',
  'export type TextProps = { id: string; label: string };',
  'export interface Labels { id: string; label: string; items: string[] }',
  "export type Mode = 'a' | 'b';",
  'export type ModeProps = { id: string; mode: Mode };',
  'export interface Saver { (): void }',
  'export type Options = { onSave: () => void };',
  '',
].join('\n');

/** A component of the props `annotation`, which `import` brings in, and whose update runs `update`. */
function component(parts: {
  annotation: string;
  import?: string | undefined;
  names?: string | undefined;
  update: string;
}): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    "import { db } from '@/db';",
    parts.import ?? '',
    `export default async function Lab({ ${parts.names ?? 'id, onSave'} }: ${parts.annotation}) {`,
    '  const ref = db.todos.ref(id);',
    '  const [title, setTitle] = useReactiveState(ref.title);',
    [
      '  return <button type="button" onClick={() => setTitle((current) => ',
      parts.update,
      ')}>',
      '{title}',
      '</button>;',
    ].join(''),
    '}',
    '',
  ].join('\n');
}

/** What compiling the application of the files `files`, beside the database and the types, refused. */
function compiled(files: Readonly<Record<string, string>>): readonly string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-called-captures-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const written = { 'db.ts': DATABASE, 'types.ts': TYPES, ...files };
  for (const [name, content] of Object.entries(written)) {
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

/** What compiling the application of the one component `text` refused. */
function refusals(text: string): readonly string[] {
  return compiled({ 'components/lab.reactive.tsx': text });
}

/**
 * What compiling a component that calls the hook `useCounter` with `argument`, and the module of the
 * hook, whose parameter `name` is typed `annotation` (which `import` brings in) and whose update
 * runs `update`, refused.
 */
function hookRefusals(parts: {
  annotation: string;
  argument?: string;
  import?: string | undefined;
  name?: string;
  update: string;
}): readonly string[] {
  const { argument = 'onSave', name = 'onSave' } = parts;
  return compiled({
    'components/board.reactive.tsx': [
      "import { db } from '@/db';",
      "import { useCounter } from '@/hooks/counter';",
      'export default async function Board({ id, onSave }: { id: string; onSave: () => void }) {',
      `  const { count, up } = useCounter(db.todos.ref(id).title, ${argument});`,
      '  return <button type="button" onClick={up}>{count}</button>;',
      '}',
      '',
    ].join('\n'),
    'hooks/counter.ts': [
      "import { useReactiveState } from 'framework/react';",
      "import type { FieldRef } from '@arkorlab/reactive-state/program';",
      parts.import ?? '',
      `export function useCounter(initial: FieldRef<string>, ${name}: ${parts.annotation}) {`,
      '  const [count, setCount] = useReactiveState(initial);',
      `  return { count, up: () => { setCount((current) => ${parts.update}); } };`,
      '}',
      '',
    ].join('\n'),
  });
}

const FUNCTION = 'is a function, which an update does not capture';

/** An update that calls `onSave` and answers the current value. */
const CALLS = '{ onSave(); return current; }';

describe('a name that holds a function, which an update captures none of', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('an update that calls it is refused, whatever the props are typed by', () => {
    it.each([
      {
        id: 'an inline type literal, a function type (as it was)',
        annotation: '{ id: string; onSave: () => void }',
      },
      {
        id: 'an inline type literal, an optional member (as it was)',
        annotation: '{ id: string; onSave?: () => void }',
      },
      {
        id: 'an imported alias',
        annotation: 'Props',
        import: "import type { Props } from '@/types';",
      },
      {
        id: 'an imported interface',
        annotation: 'Shape',
        import: "import type { Shape } from '@/types';",
      },
      {
        id: 'an alias imported as a value',
        annotation: 'Props',
        import: "import { Props } from '@/types';",
      },
      {
        id: 'an imported alias whose member is a named function type',
        annotation: 'SaveProps',
        import: "import type { SaveProps } from '@/types';",
      },
      {
        id: 'an inline type literal whose member is an imported function type',
        annotation: '{ id: string; onSave: Save }',
        import: "import type { Save } from '@/types';",
      },
      {
        id: 'an inline type literal, a union with `undefined`',
        annotation: '{ id: string; onSave: (() => void) | undefined }',
      },
      { id: 'an inline type literal, `Function`', annotation: '{ id: string; onSave: Function }' },
      {
        id: 'an inline type literal, a method signature',
        annotation: '{ id: string; onSave(): void }',
      },
    ])('$id', ({ annotation, import: imported }) => {
      const found = refusals(component({ annotation, import: imported, update: CALLS }));

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });

    it.each([
      { id: 'an optional call', update: '{ onSave?.(); return current; }' },
      { id: 'a call within parentheses', update: '{ (onSave)(); return current; }' },
      { id: 'a call of a non-null prop', update: '{ onSave!(); return current; }' },
      { id: 'a call of a cast prop', update: '{ (onSave as () => void)(); return current; }' },
      {
        id: 'a call of a prop under `satisfies`',
        update: '{ (onSave satisfies () => void)(); return current; }',
      },
      { id: '`call` within parentheses', update: '{ (onSave.call)(null); return current; }' },
      { id: '`call`', update: '{ onSave.call(null); return current; }' },
      { id: '`apply`', update: '{ onSave.apply(null, []); return current; }' },
      { id: '`new`', update: '{ new onSave(); return current; }' },
      { id: 'a tagged template', update: '{ onSave`x`; return current; }' },
    ])('$id, of a prop typed by an imported alias', ({ update }) => {
      const found = refusals(
        component({ annotation: 'Props', import: "import type { Props } from '@/types';", update }),
      );

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });
  });

  describe('a prop that holds none is captured, as it was', () => {
    it.each([
      { id: 'an inline type literal, a string', annotation: '{ id: string; label: string }' },
      {
        id: 'an imported alias, a string',
        annotation: 'TextProps',
        import: "import type { TextProps } from '@/types';",
      },
      {
        id: 'an imported interface, a string',
        annotation: 'Labels',
        import: "import type { Labels } from '@/types';",
      },
      {
        id: 'an imported alias, a union of literals',
        annotation: 'ModeProps',
        import: "import type { ModeProps } from '@/types';",
        names: 'id, label',
      },
    ])('$id, that an update reads', ({ annotation, import: imported, names = 'id, label' }) => {
      expect(
        refusals(
          component({
            annotation,
            import: imported,
            names,
            update: 'current + label',
          }),
        ),
      ).toStrictEqual([]);
    });

    it('a call of a member of a prop that holds an array, which is no call of the prop', () => {
      expect(
        refusals(
          component({
            annotation: 'Labels',
            import: "import type { Labels } from '@/types';",
            names: 'id, items',
            update: 'current + items.map((item) => item).join()',
          }),
        ),
      ).toStrictEqual([]);
    });

    it('a member of a prop that is named as a way to call a function, read and not called', () => {
      expect(
        refusals(
          component({
            annotation: '{ id: string; call: { call: string } }',
            names: 'id, call',
            update: 'current + call.call',
          }),
        ),
      ).toStrictEqual([]);
    });
  });

  describe('a prop an update hands on without calling it, typed by an imported type, is the limit', () => {
    it('is taken, as it was: the compile reads nothing of an imported type', () => {
      expect(
        refusals(
          component({
            annotation: 'Props',
            import: "import type { Props } from '@/types';",
            update: '{ void [1].map(onSave); return current; }',
          }),
        ),
      ).toStrictEqual([]);
    });

    it('is refused where the props are an inline type literal and the member a function type', () => {
      const found = refusals(
        component({
          annotation: '{ id: string; onSave: (n: number) => void }',
          update: '{ void [1].map(onSave); return current; }',
        }),
      );

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });
  });

  describe('a hook parameter that an update calls is refused, whatever it is typed by', () => {
    it.each([
      { id: 'a function type (as it was)', annotation: '() => void' },
      {
        id: 'an imported alias',
        annotation: 'Save',
        import: "import type { Save } from '@/types';",
      },
      {
        id: 'an imported interface',
        annotation: 'Saver',
        import: "import type { Saver } from '@/types';",
      },
      { id: 'a union with `undefined`', annotation: '(() => void) | undefined' },
      { id: '`Function`', annotation: 'Function' },
    ])('$id', ({ annotation, import: imported }) => {
      const found = hookRefusals({ annotation, import: imported, update: CALLS });

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });

    it.each([
      { id: 'an optional call', update: '{ onSave?.(); return current; }' },
      { id: '`call`', update: '{ onSave.call(null); return current; }' },
      { id: '`new`', update: '{ new onSave(); return current; }' },
    ])('$id, of a parameter typed by an imported alias', ({ update }) => {
      const found = hookRefusals({
        annotation: 'Save',
        import: "import type { Save } from '@/types';",
        update,
      });

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });
  });

  describe('a hook parameter that holds none is captured, as it was', () => {
    it.each([
      { id: 'a string', annotation: 'string', name: 'label' },
      {
        id: 'an imported alias, a union of literals',
        annotation: 'Mode',
        import: "import type { Mode } from '@/types';",
        name: 'label',
      },
      {
        id: 'an imported object type, a member of it read',
        annotation: 'Options',
        import: "import type { Options } from '@/types';",
        name: 'label',
        argument: '{ onSave }',
        update: 'current + String(label.onSave === undefined)',
      },
    ])(
      '$id, that an update reads',
      ({ annotation, argument = "'a'", import: imported, name, update = 'current + label' }) => {
        expect(
          hookRefusals({ annotation, argument, import: imported, name, update }),
        ).toStrictEqual([]);
      },
    );
  });

  describe('a hook parameter an update hands on without calling it', () => {
    it('is taken where it is typed by an imported alias, as it was: the limit', () => {
      expect(
        hookRefusals({
          annotation: 'Save',
          import: "import type { Save } from '@/types';",
          update: '{ void [1].map(onSave); return current; }',
        }),
      ).toStrictEqual([]);
    });

    it('is refused where it is typed by a function type', () => {
      const found = hookRefusals({
        annotation: '(n: number) => void',
        update: '{ void [1].map(onSave); return current; }',
      });

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(FUNCTION);
    });
  });
});
