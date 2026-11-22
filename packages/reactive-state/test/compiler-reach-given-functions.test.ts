import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isFunctionDeclaration, isVariableStatement, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { Reach, untrackedIn } from '../src/compiler/reach.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a part reads outside the functions it holds (`untrackedIn` and `Reach.keptIn` with
 * `outsideFunctions`): a function written as an argument of a call that runs it where the call runs
 * is read as the code around the call. The calls are the array methods that run the function they
 * are given for each element, `Array.from`'s mapping function, and the functions of `useMemo`,
 * `useState` and `useReducer` that make a value as a component renders. A function a call hands on
 * runs later, or elsewhere, and is skipped as before.
 */

interface Row {
  readonly id: string;
  readonly source: string;
}

const ROWS = 'const rows = [{ id: 1, at: 0 }];\n';

/** The names the rows call, declared so that no row reads a global of an undeclared name. */
const PRELUDE = [
  'const useMemo = (make: () => unknown, deps: unknown[]) => make();',
  'const useState = (make: () => unknown) => [make()];',
  'const useReducer = (reduce: unknown, start: unknown, make?: () => unknown) => [make?.() ?? start];',
  'const useEffect = (run: () => void, deps: unknown[]) => 0;',
  'const useLayoutEffect = useEffect;',
  'const useCallback = (run: () => unknown, deps: unknown[]) => run;',
  'const reduce = (state: unknown) => state;',
  'const React = { useMemo };',
  'const store = { subscribe: (run: () => void) => 1, on: (name: string, run: () => void) => 1 };',
  'const registry = { register: (run: () => void) => 1 };',
  'const register = (run: () => void) => 1;',
  '',
].join('\n');

/** Each reads the clock in a function a call runs as it is made. */
const GIVEN: readonly Row[] = [
  { id: 'map', source: `${ROWS}const x = rows.map((row) => Date.now() - row.at);` },
  { id: 'filter', source: `${ROWS}const x = rows.filter((row) => row.at < Date.now());` },
  { id: 'find', source: `${ROWS}const x = rows.find((row) => row.at < Date.now());` },
  { id: 'findIndex', source: `${ROWS}const x = rows.findIndex((row) => row.at < Date.now());` },
  { id: 'findLast', source: `${ROWS}const x = rows.findLast((row) => row.at < Date.now());` },
  {
    id: 'findLastIndex',
    source: `${ROWS}const x = rows.findLastIndex((row) => row.at < Date.now());`,
  },
  { id: 'some', source: `${ROWS}const x = rows.some((row) => row.at < Date.now());` },
  { id: 'every', source: `${ROWS}const x = rows.every((row) => row.at < Date.now());` },
  {
    id: 'reduce',
    source: `${ROWS}const x = rows.reduce((sum, row) => sum + Date.now() - row.at, 0);`,
  },
  {
    id: 'reduceRight',
    source: `${ROWS}const x = rows.reduceRight((sum, row) => sum + Date.now() - row.at, 0);`,
  },
  { id: 'forEach', source: `${ROWS}rows.forEach((row) => { void Date.now() - row.at; });` },
  { id: 'flatMap', source: `${ROWS}const x = rows.flatMap((row) => [Date.now() - row.at]);` },
  { id: 'sort', source: `${ROWS}const x = rows.sort(() => Math.random() - 0.5);` },
  { id: 'toSorted', source: `${ROWS}const x = rows.toSorted(() => Math.random() - 0.5);` },
  { id: 'array-from', source: 'const x = Array.from({ length: 3 }, () => Math.random());' },
  {
    id: 'chained-after-a-call',
    source: `${ROWS}const x = rows.slice().map((row) => Date.now() - row.at);`,
  },
  { id: 'optional-call', source: `${ROWS}const x = rows?.map((row) => Date.now() - row.at);` },
  {
    id: 'function-expression',
    source: `${ROWS}const x = rows.map(function (row) { return Date.now() - row.at; });`,
  },
  {
    id: 'cast-callback',
    source: `${ROWS}const x = rows.map(((row) => Date.now() - row.at) as never);`,
  },
  {
    id: 'from-entries-of-a-map',
    source: `${ROWS}const x = Object.fromEntries(rows.map((row) => [row.id, Date.now() - row.at]));`,
  },
  {
    id: 'nested-map',
    source: `${ROWS}const x = rows.map((a) => rows.map((b) => Date.now() - a.at - b.at));`,
  },
  { id: 'use-memo', source: 'const x = useMemo(() => Date.now(), []);' },
  { id: 'use-state', source: 'const [x] = useState(() => Date.now());' },
  { id: 'use-reducer-initializer', source: 'const [x] = useReducer(reduce, 0, () => Date.now());' },
  { id: 'react-use-memo', source: 'const x = React.useMemo(() => Date.now(), []);' },
];

/** Each is handed on to run later or elsewhere, or is no call that runs it, and is skipped as before. */
const HANDED_ON: readonly Row[] = [
  { id: 'use-effect', source: 'useEffect(() => { void Date.now(); }, []);' },
  { id: 'use-layout-effect', source: 'useLayoutEffect(() => { void Date.now(); }, []);' },
  { id: 'use-callback', source: 'const x = useCallback(() => Date.now(), []);' },
  { id: 'then', source: 'const x = Promise.resolve(1).then(() => Date.now());' },
  { id: 'catch', source: 'const x = Promise.reject(new Error("x")).catch(() => Date.now());' },
  { id: 'finally', source: 'const x = Promise.resolve(1).finally(() => { void Date.now(); });' },
  { id: 'subscribe', source: 'const x = store.subscribe(() => { void Date.now(); });' },
  { id: 'on', source: "const x = store.on('change', () => { void Date.now(); });" },
  { id: 'queue-microtask', source: 'queueMicrotask(() => { void Date.now(); });' },
  { id: 'unknown-call', source: 'const x = register(() => { void Date.now(); });' },
  { id: 'unknown-method', source: 'const x = registry.register(() => { void Date.now(); });' },
  { id: 'reducer-of-use-reducer', source: 'const [x] = useReducer(() => Date.now(), 0);' },
  { id: 'second-argument-of-map', source: `${ROWS}const x = rows.map(String, () => Date.now());` },
  { id: 'from-first-argument', source: 'const x = Array.from(() => Date.now());' },
  { id: 'use-memo-dependencies', source: 'const x = useMemo(() => 1, [() => Date.now()]);' },
  { id: 'handler-property', source: 'const holder = { onClick: () => Date.now() };' },
  { id: 'held-function', source: 'const read = () => Date.now();' },
];

/** The clock a handler reads in a JSX attribute, and in an element a map makes. */
const JSX: readonly Row[] = [
  {
    id: 'map-in-an-element',
    source: `${ROWS}const x = <ul>{rows.map(({ at }) => <li>{Date.now() - at}</li>)}</ul>;`,
  },
  {
    id: 'filter-in-an-element',
    source: `${ROWS}const x = <p>{rows.filter((row) => row.at < Date.now()).length}</p>;`,
  },
  {
    id: 'random-in-an-element',
    source: `${ROWS}const x = <ul>{rows.map(() => <li>{Math.random()}</li>)}</ul>;`,
  },
];

const JSX_HANDED_ON: readonly Row[] = [
  {
    id: 'onclick',
    source: 'const x = <button onClick={() => console.log(Date.now())}>x</button>;',
  },
  {
    id: 'onclick-in-a-map',
    source: `${ROWS}const x = <ul>{rows.map(() => <li onClick={() => Date.now()}>x</li>)}</ul>;`,
  },
];

/** Each writes what the module holds in a function a call runs as it is made. */
const KEPT_GIVEN: readonly Row[] = [
  {
    id: 'map',
    source: 'let n = 0;\nexport function C() { const x = [1].map(() => n++); return x; }',
  },
  {
    id: 'for-each',
    source: 'let n = 0;\nexport function C() { const x = [1].forEach(() => { n++; }); return x; }',
  },
  {
    id: 'use-memo',
    source: 'let n = 0;\nexport function C() { const x = useMemo(() => n++, []); return x; }',
  },
];

const KEPT_HANDED_ON: readonly Row[] = [
  {
    id: 'use-callback',
    source: 'let n = 0;\nexport function C() { const x = useCallback(() => n++, []); return x; }',
  },
  {
    id: 'then',
    source:
      'let n = 0;\nexport function C() { const x = Promise.resolve(1).then(() => n++); return x; }',
  },
  {
    id: 'unknown-call',
    source: 'let n = 0;\nexport function C() { const x = register(() => n++); return x; }',
  },
];

describe('what a part reads outside the functions it holds, of a function a call runs as it is made', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  function untracked(source: string, outsideFunctions: boolean, name = 'x.ts'): string | undefined {
    using file = parseModule(api, name, PRELUDE + source);
    return untrackedIn([file.sourceFile], outsideFunctions);
  }

  /** What `Reach.keptIn` finds in the constants of the one function `C` the source declares. */
  async function kept(source: string, outsideFunctions: boolean): Promise<string | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-reach-given-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const file = path.join(root, 'x.ts');
    await writeFile(file, source);
    using modules = new Modules(api, root);
    const reach = new Reach(modules, undefined);
    const { sourceFile } = modules.parse(file, false);
    const declared = sourceFile.statements.find((statement) => isFunctionDeclaration(statement));
    const constants: Node[] = [];
    if (declared !== undefined && isFunctionDeclaration(declared)) {
      declared.body?.forEachChild((statement) => {
        if (isVariableStatement(statement)) {
          constants.push(statement);
        }
      });
    }
    return reach.keptIn(constants, outsideFunctions);
  }

  it.each(GIVEN)('reads a function a call runs as it is made: $id', ({ source }) => {
    expect(untracked(source, true)).toMatch(/^(?:Date|Math\.random)$/u);
    expect(untracked(source, false)).toMatch(/^(?:Date|Math\.random)$/u);
  });

  it.each(HANDED_ON)('leaves a function a call hands on: $id', ({ source }) => {
    expect(untracked(source, true)).toBeUndefined();
  });

  it.each(JSX)('reads a function an element’s expression runs as it renders: $id', ({ source }) => {
    expect(untracked(source, true, 'x.tsx')).toMatch(/^(?:Date|Math\.random)$/u);
  });

  it.each(JSX_HANDED_ON)('leaves the handler of an element: $id', ({ source }) => {
    expect(untracked(source, true, 'x.tsx')).toBeUndefined();
  });

  it('leaves a timer the call of which reads a global of its own', () => {
    expect(untracked('const x = setTimeout(() => { void Date.now(); }, 10);', true)).toBe(
      'setTimeout',
    );
  });

  it.each(KEPT_GIVEN)(
    'finds a write of a function a call runs as it is made: $id',
    async ({ source }) => {
      await expect(kept(source, true)).resolves.toBe('n');
    },
  );

  it.each(KEPT_HANDED_ON)(
    'leaves a write of a function a call hands on: $id',
    async ({ source }) => {
      await expect(kept(source, true)).resolves.toBeUndefined();
      await expect(kept(source, false)).resolves.toBe('n');
    },
  );
});
