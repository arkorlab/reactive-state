import {
  type Expression,
  isFunctionDeclaration,
  isIdentifier,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { type Answering, isAnswering, localsOf } from '../src/compiler/answers.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import {
  followedOf,
  isFunctionValue,
  isMadeNonJson,
  isNonJsonName,
  type JsonReading,
  reached,
} from '../src/compiler/json-reading.ts';
import { toldChanges } from '../src/compiler/local-writes.ts';
import { constantNumber } from '../src/compiler/numbers.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Replaced container prefixes cannot be treated as plain object literals for named property writes,
 * and mutable callbacks rebound to `cb.bind(...)` must terminate cleanly while flagging parameter
 * mutations.
 */

interface Item {
  value: number;
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

const SPARSE_LEN = 3;

function box<T>(value: T): T {
  return value;
}

function poisonedItems(): Item[] {
  return [{ value: NaN }];
}

function poisonedItem(): Item {
  return { value: NaN };
}

const CASES: readonly Case[] = [
  {
    body: 'const target = { items: [0] }; target.items = [1]; (target.items as unknown as { extra: number }).extra = 1; return target;',
    changed: true,
    id: 'replaced-array-container-named-property-refused',
    run: () => {
      const target = box({ items: [0] });
      target.items = [1];
      Reflect.set(target.items, 'extra', 1);
      return target;
    },
  },
  {
    body: 'const target: { list: { x?: number } | number[] } = { list: { x: 1 } }; target.list = [1]; (target.list as unknown as { x: number }).x = 2; return target;',
    changed: true,
    id: 'replaced-object-with-array-named-property-refused',
    run: () => {
      const target = box<{ list: number[] | { x?: number } }>({ list: { x: 1 } });
      target.list = [1];
      Reflect.set(target.list, 'x', 2);
      return target;
    },
  },
  {
    body: 'const target = { items: [0] }; const alias = target; alias.items = [1]; (target.items as unknown as { extra: number }).extra = 1; return target;',
    changed: true,
    id: 'aliased-prefix-replacement-named-property-refused',
    run: () => {
      const target = box({ items: [0] });
      const alias = target;
      alias.items = [1];
      Reflect.set(target.items, 'extra', 1);
      return target;
    },
  },
  {
    body: 'const over = { items: [1] }; const target = { items: { extra: 0 }, ...over }; (target.items as unknown as { extra: number }).extra = 2; return target;',
    changed: true,
    id: 'spread-overridden-container-named-property-refused',
    run: () => {
      const over = box<{ items?: number[] }>({ items: [1] });
      const target = box({ items: { extra: 0 }, ...over });
      Reflect.set(target.items, 'extra', 2);
      return target;
    },
  },
  {
    body: 'const target = { items: [0] }; const { items } = target; (items as unknown as { extra: number }).extra = 1; return target;',
    changed: true,
    id: 'destructured-array-member-named-property-refused',
    run: () => {
      const target = box({ items: [0] });
      const { items } = target;
      Reflect.set(items, 'extra', 1);
      return target;
    },
  },
  {
    body: 'const target = flag ? [0] : Array(3); target[0] = 1; return target;',
    changed: true,
    id: 'conditional-sparse-array-zero-write-refused',
    run: () => {
      const target = Reflect.construct<readonly [number], number[]>(Array, [SPARSE_LEN]);
      target[0] = 1;
      return target;
    },
  },
  {
    body: "let cb: (...args: never[]) => void = ((prefix: string, item: Item) => { void prefix; item.value = NaN; }) as unknown as (...args: never[]) => void; cb = cb.bind(null, 'x' as never); const target: Item[] = [{ value: 0 }]; target.forEach(cb as unknown as (item: Item) => void); return target;",
    changed: true,
    id: 'rebound-mutable-bind-callback-terminates-and-flags-mutation',
    run: poisonedItems,
  },
  {
    body: 'let cb: (...args: never[]) => void = ((a: number, b: number, item: Item) => { void a; void b; item.value = NaN; }) as unknown as (...args: never[]) => void; for (let step = 0; step < 2; step += 1) { cb = cb.bind(null, step as never); } const target: Item = { value: 0 }; (cb as unknown as (item: Item) => void)(target); return target;',
    changed: true,
    id: 'loop-rebound-bind-direct-callee-flags-shifted-parameter-mutation',
    run: poisonedItem,
  },
  {
    body: "let first: (...args: never[]) => void = ((p: string, q: string, item: Item) => { void p; void q; item.value = NaN; }) as unknown as (...args: never[]) => void; let second: (...args: never[]) => void = first; first = second.bind(null, 'a' as never); second = first.bind(null, 'b' as never); const target: Item[] = [{ value: 0 }]; target.forEach(first as unknown as (item: Item) => void); return target;",
    changed: true,
    id: 'mutually-rebound-bind-callbacks-terminate-and-flag-mutation',
    run: poisonedItems,
  },
  {
    body: "const target: Item[] = [{ value: 0 }]; for (let cb: (...args: never[]) => void = ((prefix: string, item: Item) => { void prefix; item.value = NaN; }) as unknown as (...args: never[]) => void; flag; cb = cb.bind(null, 'x' as never)) { target.forEach(cb as unknown as (item: Item) => void); break; } return target;",
    changed: true,
    id: 'for-head-rebound-bind-callback-terminates-and-flags-mutation',
    run: poisonedItems,
  },
  {
    body: 'const target: { nested: { a: number; extra?: number } } = { nested: { a: 1 } }; target.nested.extra = 2; return target;',
    changed: false,
    id: 'pin-unreplaced-nested-plain-object-entry-accepted',
    run: () => {
      const target = box<{ nested: { a: number; extra?: number } }>({ nested: { a: 1 } });
      target.nested.extra = 2;
      return target;
    },
  },
  {
    body: 'const base = { a: 1 }; const target: { a: number; extra?: number } = { ...base }; target.extra = 2; return target;',
    changed: false,
    id: 'pin-root-object-literal-with-spread-entry-accepted',
    run: () => {
      const base = box({ a: 1 });
      const target = box<{ a: number; extra?: number }>({ ...base });
      target.extra = 2;
      return target;
    },
  },
  {
    body: 'const target = { items: [0] }; target.items = [1]; target.items[0] = 2; return target;',
    changed: false,
    id: 'pin-replaced-dense-array-zero-index-overwrite-accepted',
    run: () => {
      const target = box({ items: [0] });
      target.items = [1];
      target.items[0] = 2;
      return target;
    },
  },
  {
    body: 'let cb: (...args: never[]) => void = ((_n: number) => {}) as unknown as (...args: never[]) => void; cb = cb.bind(null, 0 as never); const target = [1]; target.forEach(cb as unknown as (n: number) => void); return target;',
    changed: false,
    id: 'pin-noop-rebound-bind-callback-terminates-and-accepts',
    run: () => box([1]),
  },
  {
    body: "let cb: (...args: never[]) => number = ((prefix: string, item: Item) => prefix.length + item.value) as unknown as (...args: never[]) => number; cb = cb.bind(null, 'x' as never); const target: Item[] = [{ value: 0 }]; target.map(cb as unknown as (item: Item) => number); return target;",
    changed: false,
    id: 'pin-readonly-rebound-bind-mapper-terminates-and-accepts',
    run: () => box<Item[]>([{ value: 0 }]),
  },
];

/** Minimal non-JSON leaf check matching `json-values.ts` for constant/identifier expressions. */
function isSimpleNonJson(node: Expression, reading: JsonReading): boolean {
  const follow = followedOf(reading);
  const numeric = isIdentifier(unwrapped(node)) ? undefined : constantNumber(node, follow);
  if (numeric !== undefined) return !Number.isFinite(numeric);
  const { at, value } = reached(node, reading);
  const heldNumeric = constantNumber(value, follow);
  if (heldNumeric !== undefined) return !Number.isFinite(heldNumeric);
  if (isIdentifier(value)) return isNonJsonName(value, at);
  return isFunctionValue(value) || isMadeNonJson(value);
}

/** Finds `const target = …` anywhere inside `build` without entering nested function bodies. */
function findTarget(file: SourceFile): {
  readonly fn: Answering;
  readonly target: VariableDeclaration;
} {
  const fn = file.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === 'build',
  );
  if (fn === undefined || !isFunctionDeclaration(fn) || fn.body === undefined) {
    throw new Error('expected function build');
  }
  let found: VariableDeclaration | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined || (node !== fn && isAnswering(node))) return;
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'target') {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  fn.body.forEachChild(visit);
  if (found === undefined) throw new Error('expected target declaration');
  return { fn, target: found };
}

/** First top-level function declaration in `file` for each name. */
function fileFunctions(file: SourceFile): ReadonlyMap<string, Answering> {
  const functions = new Map<string, Answering>();
  for (const statement of file.statements) {
    if (
      isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      !functions.has(statement.name.text)
    ) {
      functions.set(statement.name.text, statement);
    }
  }
  return functions;
}

/** Finds `target`'s initializer in `build` and asks `toldChanges` whether its writes change it. */
function targetChanged(file: SourceFile): boolean {
  const { fn, target } = findTarget(file);
  if (target.initializer === undefined) throw new Error('expected target initializer');
  const locals = localsOf(fn);
  const functions = fileFunctions(file);
  const base: JsonReading = {
    follow: (name) => locals.constants.get(name.text),
  };
  const calls = {
    functionOf: (callee: Expression): Answering | undefined => {
      const { value } = reached(callee, base);
      return isIdentifier(value) ? functions.get(value.text) : undefined;
    },
  };
  const { changes } = toldChanges(base, () => calls, isSimpleNonJson);
  return changes(target.initializer);
}

describe('replaced local-write containers and rebound bound callbacks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, run }) => {
    using parsed = parseModule(
      api,
      'replaced-and-rebound-writes.ts',
      `interface Item { value: number }\nexport function build(flag: boolean) { ${body} }\n`,
    );

    expect(isJson(run())).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
