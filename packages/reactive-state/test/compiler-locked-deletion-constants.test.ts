import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A module's code is strict: a deletion of a property that cannot be configured — one of a frozen
 * or sealed object, an index of text, an array's `length`, a property defined without
 * `configurable` — throws a `TypeError`, and takes nothing away. The compile refuses a state whose
 * first value runs one, since the render would throw on the authority, and it reads such a
 * deletion of a constant as it reads one of the call that locks the object: the deletion is no
 * change of the constant, which is followed to what it declares as before.
 *
 * A deletion the code does not show to throw stays what it was: of an object the constant writes
 * it takes an entry away, and of anything else — an array's element, which leaves a hole, a
 * property the code shows no lock of — it changes the constant, which a state is then refused of.
 *
 * Each row compiles a small application of one component through `compileApp` and reads what the
 * compile refuses.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** How the refusal of a state begins whose first value throws as it is computed, naming what throws. */
function throwing(expression: string): string {
  return `A state the authority starts is of \`${expression}\` here, which no JSON holds`;
}

/** How the refusal of a state begins that is of a constant the code changes, naming the constant. */
function changed(name: string): string {
  return `A state the authority starts is of \`${name}\` here, which the code changes after it declares it`;
}

interface Row {
  readonly id: string;
  /** The statements of the component before its state. */
  readonly before: readonly string[];
  /** The state's first value. */
  readonly first: string;
  /** How each refusal's reason begins; none where the compile takes the component. */
  readonly refusals: readonly string[];
}

/** A state's first value that runs `expression` where the prop is empty, and is text either way. */
function running(expression: string): string {
  return `first === '' ? (${expression}, 'ok') : first`;
}

/** Deletions the code shows to throw, of a constant: refused as of the call that locks the object. */
const THROWING: readonly Row[] = [
  {
    before: [
      'const lock = Object.freeze;',
      'const locked = lock({ value: 1 });',
      "const key = 'value';",
    ],
    first: running('delete locked[key]'),
    id: 'frozen-constant-through-aliases',
    refusals: [throwing('delete locked[key]')],
  },
  {
    before: ['const locked = Object.freeze({ value: 1 });'],
    first: running('delete (locked as any).value'),
    id: 'frozen-constant',
    refusals: [throwing('delete (locked as any).value')],
  },
  {
    before: ['const locked = Object.seal({ value: 1 });'],
    first: running('delete (locked as any).value'),
    id: 'sealed-constant',
    refusals: [throwing('delete (locked as any).value')],
  },
  {
    before: ['const locked = Object.freeze({ value: 1 });', 'const alias = locked;'],
    first: running('delete (alias as any).value'),
    id: 'alias-of-frozen-constant',
    refusals: [throwing('delete (alias as any).value')],
  },
  {
    before: ["const text = 'x';"],
    first: running('delete (text as any)[0]'),
    id: 'text-constant-index',
    refusals: [throwing('delete (text as any)[0]')],
  },
  {
    before: ['const list = [1];'],
    first: running('delete (list as any).length'),
    id: 'array-constant-length',
    refusals: [throwing('delete (list as any).length')],
  },
  {
    before: ["const made = Object.defineProperty({}, 'value', { value: 1 });"],
    first: running('delete (made as any).value'),
    id: 'defined-constant',
    refusals: [throwing('delete (made as any).value')],
  },
  {
    before: ['const made = Object.create(null, { value: { value: 1 } });'],
    first: running('delete made.value'),
    id: 'created-constant',
    refusals: [throwing('delete made.value')],
  },
  {
    // The state is of the frozen array itself: what throws is named, not the array as changed.
    before: ['const items = Object.freeze([1, 2]);'],
    first: "first === '' ? (delete (items as any)[0], items) : items",
    id: 'frozen-array-element-of-the-state',
    refusals: [throwing('delete (items as any)[0]')],
  },
];

/** A frozen constant a deletion in a handler names holds what it declares: the deletion throws there. */
const UNCHANGED: readonly Row[] = [
  {
    before: [
      'const locked = Object.freeze({ value: 1 });',
      'const drop = () => delete (locked as any).value;',
    ],
    first: 'locked',
    id: 'frozen-state-a-handler-deletes-of',
    refusals: [],
  },
];

/** What a deletion was before stays: the call that locks, entries taken away, and changes. */
const AS_BEFORE: readonly Row[] = [
  {
    before: ['const lock = Object.freeze;', "const key = 'value';"],
    first: running('delete lock({ value: 1 })[key]'),
    id: 'frozen-call',
    refusals: [throwing('delete lock({ value: 1 })[key]')],
  },
  {
    before: ['const open = { value: 1 };'],
    first: running('delete (open as any).value'),
    id: 'written-object-entry',
    refusals: [],
  },
  {
    before: ['const open = { value: 1, other: 2 };', 'delete (open as any).value;'],
    first: 'open',
    id: 'written-object-state',
    refusals: [],
  },
  {
    before: ["const made = Object.defineProperty({}, 'value', { value: 1, configurable: true });"],
    first: running('delete (made as any).value'),
    id: 'configurable-defined-constant',
    refusals: [],
  },
  {
    before: ['const locked = Object.freeze({ value: 1 });'],
    first: running('delete (locked as any).other'),
    id: 'frozen-constant-absent-key',
    refusals: [],
  },
  {
    // A hole in the array the state is of.
    before: ['const items = [1, 2];'],
    first: "first === '' ? (delete (items as any)[0], items) : items",
    id: 'array-element-of-the-state',
    refusals: [changed('items')],
  },
  {
    before: ['const items = [1, 2];', 'delete (items as any)[0];'],
    first: 'items',
    id: 'array-element-before-the-state',
    refusals: [changed('items')],
  },
  {
    // No lock of `other` is shown, so the deletion is read as one that may take it away.
    before: ['const locked = Object.freeze({ value: 1 });', 'delete (locked as any).other;'],
    first: 'locked',
    id: 'frozen-state-absent-key',
    refusals: [changed('locked')],
  },
];

/**
 * The reasons the compile refuses the component of `row` for, each cut to the length of the
 * beginning the row expects of it, and whole where the row expects none.
 */
function refusalsOf(row: Row): readonly string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-locked-deletion-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const component = [
    "import { useReactiveState } from 'framework/react';",
    'export default function Kinds({ first }: { first: string }) {',
    ...row.before.map((line) => `  ${line}`),
    `  const [selected, setSelected] = useReactiveState(${row.first});`,
    '  return <button type="button" onClick={() => setSelected(selected)}>{String(selected)}</button>;',
    '}',
    '',
  ].join('\n');
  const sources = Object.entries({
    'components/kinds.reactive.tsx': component,
    'db.ts': DATABASE,
  });
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
  });
  return result.refusals.map((refusal, index) => {
    const begins = row.refusals[index];
    return begins === undefined ? refusal.reason : refusal.reason.slice(0, begins.length);
  });
}

describe('a deletion of a locked property of a constant', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(THROWING)('refuses the state whose first value runs it: $id', (row) => {
    expect(refusalsOf(row)).toStrictEqual(row.refusals);
  });

  it.each(UNCHANGED)('leaves the constant what it declares: $id', (row) => {
    expect(refusalsOf(row)).toStrictEqual(row.refusals);
  });

  it.each(AS_BEFORE)('reads every other deletion as before: $id', (row) => {
    expect(refusalsOf(row)).toStrictEqual(row.refusals);
  });
});
