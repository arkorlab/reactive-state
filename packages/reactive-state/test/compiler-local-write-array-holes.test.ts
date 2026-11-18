import {
  type Expression,
  isFunctionDeclaration,
  isIdentifier,
  isVariableStatement,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { type Answering, localsOf } from '../src/compiler/answers.ts';
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
 * Sparse arrays and non-index array properties are refused by `isJson` (`authority/canonical.ts`),
 * whereas deleting an own property or writing any numeric key on a plain object literal stays JSON.
 */

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

const OUT_OF_BOUNDS_INDEX = 3;
const FRACTIONAL_INDEX = 1.5;
const MAX_UINT32_KEY = 4_294_967_295;
const EXTRA_VALUE = 9;

function box<T>(value: T): T {
  return value;
}

const CASES: readonly Case[] = [
  {
    body: 'const target = [1, 2]; delete target[0]; return target;',
    changed: true,
    id: 'delete-array-element',
    run: () => {
      const target = box([1, 2]);
      // eslint-disable-next-line @typescript-eslint/no-array-delete, sonarjs/no-array-delete -- exercises sparse deletion runtime behavior
      delete target[0];
      return target;
    },
  },
  {
    body: 'const target = { items: [1, 2] }; delete target.items[1]; return target;',
    changed: true,
    id: 'delete-nested-array-element',
    run: () => {
      const target = box({ items: [1, 2] });
      // eslint-disable-next-line @typescript-eslint/no-array-delete, sonarjs/no-array-delete -- exercises sparse deletion runtime behavior
      delete target.items[1];
      return target;
    },
  },
  {
    body: 'const target = [1, 2]; const alias = target; delete alias[0]; return target;',
    changed: true,
    id: 'delete-aliased-array-element',
    run: () => {
      const alias = box([1, 2]);
      // eslint-disable-next-line @typescript-eslint/no-array-delete, sonarjs/no-array-delete -- exercises sparse deletion runtime behavior
      delete alias[0];
      return alias;
    },
  },
  {
    body: 'const target: { x: { a?: number } | number[] } = { x: { a: 1 } }; target.x = [1, 2]; delete (target.x as number[])[0]; return target;',
    changed: true,
    id: 'delete-overwritten-container-array',
    run: () => {
      const target = box<{ x: number[] | { a?: number } }>({ x: { a: 1 } });
      target.x = [1, 2];
      // eslint-disable-next-line @typescript-eslint/no-array-delete, sonarjs/no-array-delete -- exercises sparse deletion runtime behavior
      delete target.x[0];
      return target;
    },
  },
  {
    body: 'const over = { x: [1, 2] }; const target = { x: { a: 1 }, ...over }; delete (target.x as number[])[0]; return target;',
    changed: true,
    id: 'delete-spread-overridden-container-array',
    run: () => {
      const over = box<Record<string, number[]>>({ x: [1, 2] });
      const target = box({ x: { a: 1 }, ...over });
      Reflect.deleteProperty(target.x, 0);
      return target;
    },
  },
  {
    body: 'const target = [1, 2]; Reflect.deleteProperty(target, 0); return target;',
    changed: true,
    id: 'reflect-delete-array-element',
    run: () => {
      const target = box([1, 2]);
      Reflect.deleteProperty(target, 0);
      return target;
    },
  },
  {
    body: 'const target = { items: [1, 2] }; Reflect.deleteProperty(target.items, 0); return target;',
    changed: true,
    id: 'reflect-delete-nested-array',
    run: () => {
      const target = box({ items: [1, 2] });
      Reflect.deleteProperty(target.items, 0);
      return target;
    },
  },
  {
    body: 'const target = [0]; target[2] = 1; return target;',
    changed: true,
    id: 'assign-past-array-end',
    run: () => {
      const target = box([0]);
      target[2] = 1;
      return target;
    },
  },
  {
    body: "const target = { items: ['a'] }; target.items[3] = 'b'; return target;",
    changed: true,
    id: 'assign-nested-past-array-end',
    run: () => {
      const target = box({ items: ['a'] });
      target.items[OUT_OF_BOUNDS_INDEX] = 'b';
      return target;
    },
  },
  {
    body: 'const target = [0]; const alias = target; alias[2] = 1; return target;',
    changed: true,
    id: 'assign-aliased-past-array-end',
    run: () => {
      const alias = box([0]);
      alias[2] = 1;
      return alias;
    },
  },
  {
    body: 'const idx = 2; const target = [0]; target[idx] = 1; return target;',
    changed: true,
    id: 'assign-const-index-past-end',
    run: () => {
      const idx = 2;
      const target = box([0]);
      target[idx] = 1;
      return target;
    },
  },
  {
    body: 'const target = [0]; target[-1] = 1; return target;',
    changed: true,
    id: 'assign-negative-array-index',
    run: () => {
      const target = box<number[] & Record<number, number>>([0]);
      target[-1] = 1;
      return target;
    },
  },
  {
    body: 'const target = [0, 1, 2]; const alias = target; alias[1.5] = 9; return target;',
    changed: true,
    id: 'assign-aliased-fractional-index',
    run: () => {
      const alias = box<number[] & Record<number, number>>([0, 1, 2]);
      alias[FRACTIONAL_INDEX] = EXTRA_VALUE;
      return alias;
    },
  },
  {
    body: "const target = [0]; const alias = target; (alias as unknown as Record<string, number>)['-0'] = 1; return target;",
    changed: true,
    id: 'assign-aliased-negative-zero-key',
    run: () => {
      const alias = box([0]);
      (alias as unknown as Record<string, number>)['-0'] = 1;
      return alias;
    },
  },
  {
    body: 'const target = [0]; target[4294967295] = 1; return target;',
    changed: true,
    id: 'assign-max-uint32-array-key',
    run: () => {
      const target = box<number[] & Record<number, number>>([0]);
      target[MAX_UINT32_KEY] = 1;
      return target;
    },
  },
  {
    body: 'const target = [0]; target[index] = 1; return target;',
    changed: true,
    id: 'assign-dynamic-array-index',
    run: () => {
      const index = 2;
      const target = box([0]);
      target[index] = 1;
      return target;
    },
  },
  {
    body: 'const rest: number[] = []; const target = [...rest]; target[1] = 1; return target;',
    changed: true,
    id: 'assign-after-uncertain-spread',
    run: () => {
      const target = box<number[]>([]);
      target[1] = 1;
      return target;
    },
  },
  {
    body: 'const target = [0]; target.pop(); target[1] = 2; return target;',
    changed: true,
    id: 'assign-after-pop-shrink',
    run: () => {
      const target = box([0]);
      target.pop();
      target[1] = 2;
      return target;
    },
  },
  {
    body: 'const target = [0, 1]; const alias = target; alias.shift(); target[2] = 9; return target;',
    changed: true,
    id: 'assign-after-aliased-shift-shrink',
    run: () => {
      const target = box([0, 1]);
      target.shift();
      target[2] = EXTRA_VALUE;
      return target;
    },
  },
  {
    body: 'const target = Array.of(0); target[2] = 1; return target;',
    changed: true,
    id: 'assign-past-end-of-array-of',
    run: () => {
      const target = box([0]);
      target[2] = 1;
      return target;
    },
  },
  {
    body: 'const target = [1, 2]; (target as unknown as { fill: () => void }).fill(); return target;',
    changed: true,
    id: 'fill-without-argument-writes-undefined',
    run: () => {
      const target = box([1, 2]);
      (target as unknown as { fill: () => void }).fill();
      return target;
    },
  },
  {
    body: 'const target: { a?: number; b: number } = { a: 1, b: 2 }; delete target.a; return target;',
    changed: false,
    id: 'pin-delete-plain-object-property',
    run: () => {
      const target = box<{ a?: number; b: number }>({ a: 1, b: 2 });
      delete target.a;
      return target;
    },
  },
  {
    body: 'const target: { a?: number; b: number } = { a: 1, b: 2 }; const alias = target; delete alias.a; return target;',
    changed: false,
    id: 'pin-delete-aliased-plain-object',
    run: () => {
      const alias = box<{ a?: number; b: number }>({ a: 1, b: 2 });
      delete alias.a;
      return alias;
    },
  },
  {
    body: "const target: { a?: number; b: number } = { a: 1, b: 2 }; Reflect.deleteProperty(target, 'a'); return target;",
    changed: false,
    id: 'pin-reflect-delete-plain-object',
    run: () => {
      const target = box<{ a?: number; b: number }>({ a: 1, b: 2 });
      Reflect.deleteProperty(target, 'a');
      return target;
    },
  },
  {
    body: "const target = ['a', 'b']; target[1] = target[0]!; return target;",
    changed: false,
    id: 'pin-in-bounds-array-overwrite',
    run: () => {
      const target = box(['a', 'b']);
      target[1] = target[0] ?? '';
      return target;
    },
  },
  {
    body: 'const target = [0]; target[1] = 1; return target;',
    changed: false,
    id: 'pin-contiguous-array-append',
    run: () => {
      const target = box([0]);
      target[1] = 1;
      return target;
    },
  },
  {
    body: 'const target: number[] = []; target[0] = 1; return target;',
    changed: false,
    id: 'pin-empty-array-zero-append',
    run: () => {
      const target = box<number[]>([]);
      target[0] = 1;
      return target;
    },
  },
  {
    body: 'const target: Record<number, number> = { 0: 1 }; target[2] = 9; return target;',
    changed: false,
    id: 'pin-plain-object-numeric-slot',
    run: () => {
      const target = box<Record<number, number>>({ 0: 1 });
      target[2] = EXTRA_VALUE;
      return target;
    },
  },
  {
    body: 'const target = [0, 1, 2]; target[1.5] = 9; return target;',
    changed: true,
    id: 'pin-fractional-array-literal-index',
    run: () => {
      const target = box<number[] & Record<number, number>>([0, 1, 2]);
      target[FRACTIONAL_INDEX] = EXTRA_VALUE;
      return target;
    },
  },
  {
    body: "const target = [0]; (target as unknown as Record<string, number>)['-0'] = 1; return target;",
    changed: true,
    id: 'pin-negative-zero-array-literal-key',
    run: () => {
      const target = box([0]);
      (target as unknown as Record<string, number>)['-0'] = 1;
      return target;
    },
  },
  {
    body: 'const target = [0]; target.length = 2; return target;',
    changed: true,
    id: 'pin-array-length-growth-refused',
    run: () => {
      const target = box([0]);
      target.length = 2;
      return target;
    },
  },
  {
    body: 'const target = [0]; (target as unknown as { extra: number }).extra = 1; return target;',
    changed: true,
    id: 'pin-array-named-property-refused',
    run: () => {
      const target = box([0]);
      (target as unknown as { extra: number }).extra = 1;
      return target;
    },
  },
  {
    body: 'const target: (number | undefined)[] = [1]; target[0] = undefined; return target;',
    changed: true,
    id: 'pin-array-zero-undefined-refused',
    run: () => {
      const target = box<(number | undefined)[]>([1]);
      target[0] = undefined;
      return target;
    },
  },
];

/** Whether `node` writes a non-JSON primitive, global, or object construction in test bodies. */
function isSimpleNonJson(node: Expression, reading: JsonReading): boolean {
  const follow = followedOf(reading);
  const numeric = isIdentifier(unwrapped(node)) ? undefined : constantNumber(node, follow);
  if (numeric !== undefined) {
    return !Number.isFinite(numeric);
  }
  const { at, value } = reached(node, reading);
  const heldNumeric = constantNumber(value, follow);
  if (heldNumeric !== undefined) {
    return !Number.isFinite(heldNumeric);
  }
  if (isIdentifier(value)) {
    return isNonJsonName(value, at);
  }
  return isFunctionValue(value) || isMadeNonJson(value);
}

/** Finds `const target = …` in `statements`. */
function findTarget(file: SourceFile): {
  readonly fn: Answering;
  readonly target: VariableDeclaration;
} {
  const fn = file.statements.find((statement) => isFunctionDeclaration(statement));
  if (fn?.body === undefined) {
    throw new Error('expected function build');
  }
  for (const statement of fn.body.statements) {
    if (isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find(
        (each) => isIdentifier(each.name) && each.name.text === 'target',
      );
      if (found !== undefined) {
        return { fn, target: found };
      }
    }
  }
  throw new Error('expected target declaration');
}

/** Top-level function declarations in `file`, keyed by name. */
function fileFunctions(file: SourceFile): ReadonlyMap<string, Answering> {
  const functions = new Map<string, Answering>();
  for (const statement of file.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement);
    }
  }
  return functions;
}

/** Finds `target`'s initializer in `build` and asks `toldChanges` whether its writes change it. */
function targetChanged(file: SourceFile): boolean {
  const { fn, target } = findTarget(file);
  if (target.initializer === undefined) {
    throw new Error('expected target initializer');
  }
  const locals = localsOf(fn);
  const functions = fileFunctions(file);
  const base: JsonReading = {
    follow: (name) => locals.constants.get(name.text),
  };
  const { changes } = toldChanges(
    base,
    () => ({ functionOf: (callee) => functions.get(isIdentifier(callee) ? callee.text : '') }),
    isSimpleNonJson,
  );
  return changes(target.initializer);
}

describe('local writes that introduce sparse array holes or non-index array slots', () => {
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
      'array-holes.ts',
      `export function build(index: number) { ${body} }\n`,
    );

    expect(isJson(run())).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
