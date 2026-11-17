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
 * Compound arithmetic (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`) and update (`++`, `--`) writes onto
 * local constants can overflow to `Infinity` or produce `NaN` unless the target's initial value
 * and operand fold to a finite result (or string concatenation on a string target).
 */

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

const NEAR_MAX = 1e308;
const LARGE_FACTOR = 1e200;
const LOOP_FACTOR = 1e100;
const EXPONENT_OVERFLOW = 1024;
const HALF = 0.5;
const TENTH = 0.1;
const REMAINDER_LEFT = 5;
const INITIAL_TEN = 10;
const INITIAL_TWENTY = 20;
const BITWISE_MASK_RESULT = 3;

function box<T>(value: T): T {
  return value;
}

const CASES: readonly Case[] = [
  {
    body: 'const target = { n: 1e308 }; target.n *= 2; return target;',
    changed: true,
    id: 'multiply-overflow-to-infinity',
    run: () => {
      const target = box({ n: NEAR_MAX });
      target.n *= 2;
      return target;
    },
  },
  {
    body: 'const target = { n: 1e308 }; target.n += 1e308; return target;',
    changed: true,
    id: 'add-overflow-to-infinity',
    run: () => {
      const target = box({ n: NEAR_MAX });
      target.n += NEAR_MAX;
      return target;
    },
  },
  {
    body: 'const target = { n: -1e308 }; target.n -= 1e308; return target;',
    changed: true,
    id: 'subtract-overflow-to-neg-infinity',
    run: () => {
      const target = box({ n: -NEAR_MAX });
      target.n -= NEAR_MAX;
      return target;
    },
  },
  {
    body: 'const target = { n: 1e308 }; target.n /= 0.1; return target;',
    changed: true,
    id: 'divide-fractional-overflow',
    run: () => {
      const target = box({ n: NEAR_MAX });
      target.n /= TENTH;
      return target;
    },
  },
  {
    body: 'const target = { n: 2 }; target.n **= 1024; return target;',
    changed: true,
    id: 'exponent-overflow-to-infinity',
    run: () => {
      const target = box({ n: 2 });
      target.n **= EXPONENT_OVERFLOW;
      return target;
    },
  },
  {
    body: 'const target = { n: -1 }; target.n **= 0.5; return target;',
    changed: true,
    id: 'exponent-negative-base-fractional-nan',
    run: () => {
      const target = box({ n: -1 });
      target.n **= HALF;
      return target;
    },
  },
  {
    body: 'const target = { n: 1 }; target.n /= factor; return target;',
    changed: true,
    id: 'divide-by-dynamic-zero-infinity',
    run: () => {
      const factor = 0;
      const target = box({ n: 1 });
      target.n /= factor;
      return target;
    },
  },
  {
    body: 'const target = { n: 5 }; target.n %= factor; return target;',
    changed: true,
    id: 'remainder-by-dynamic-zero-nan',
    run: () => {
      const factor = 0;
      const target = box({ n: REMAINDER_LEFT });
      target.n %= factor;
      return target;
    },
  },
  {
    body: 'const target: { n?: number } = {}; (target.n as number) += 1; return target;',
    changed: true,
    id: 'add-onto-missing-property-nan',
    run: () => {
      const target = box<{ n?: number }>({});
      (target as { n: number }).n += 1;
      return target;
    },
  },
  {
    body: "const target = { n: 'bad' as unknown as number }; target.n -= 1; return target;",
    changed: true,
    id: 'subtract-from-string-member-nan',
    run: () => {
      const target = box({ n: 'bad' as unknown as number });
      target.n -= 1;
      return target;
    },
  },
  {
    body: 'const target = { n: 1e200 }; target.n *= 1e100; target.n *= 1e100; return target;',
    changed: true,
    id: 'repeated-multiply-overflow',
    run: () => {
      const target = box({ n: LARGE_FACTOR });
      target.n *= LOOP_FACTOR;
      target.n *= LOOP_FACTOR;
      return target;
    },
  },
  {
    body: 'const target = { n: 1e200 }; for (let i = 0; i < 2; i += 1) { target.n *= 1e100; } return target;',
    changed: true,
    id: 'loop-multiply-overflow',
    run: () => {
      const target = box({ n: LARGE_FACTOR });
      for (let index = 0; index < 2; index += 1) {
        target.n *= LOOP_FACTOR;
      }
      return target;
    },
  },
  {
    body: 'const target = { n: 1 }; target.n = 1e308; target.n *= 2; return target;',
    changed: true,
    id: 'prior-overwrite-then-multiply-overflow',
    run: () => {
      const target = box({ n: 1 });
      target.n = NEAR_MAX;
      target.n *= 2;
      return target;
    },
  },
  {
    body: 'const target = { n: 1 }; const alias = target; alias.n = 1e308; target.n *= 2; return target;',
    changed: true,
    id: 'aliased-overwrite-then-multiply-overflow',
    run: () => {
      const target = box({ n: 1 });
      const alias = target;
      alias.n = NEAR_MAX;
      target.n *= 2;
      return target;
    },
  },
  {
    body: 'const target: { n?: number } = {}; (target.n as number)++; return target;',
    changed: true,
    id: 'postfix-increment-missing-property-nan',
    run: () => {
      const target = box<{ n?: number }>({});
      (target as { n: number }).n += 1;
      return target;
    },
  },
  {
    body: "const target = { n: 'bad' as unknown as number }; --target.n; return target;",
    changed: true,
    id: 'prefix-decrement-string-property-nan',
    run: () => {
      const target = box({ n: 'bad' as unknown as number });
      target.n -= 1;
      return target;
    },
  },
  {
    body: 'const target = [1e308]; target[0] *= 2; return target;',
    changed: true,
    id: 'array-element-multiply-overflow',
    run: () => {
      const target = box([NEAR_MAX]);
      target[0] = (target[0] ?? 0) * 2;
      return target;
    },
  },
  {
    body: 'const target: Array<{ count?: number }> = [{}]; target.forEach((item) => { (item as { count: number }).count++; }); return target;',
    changed: true,
    id: 'callback-parameter-increment-mutates',
    run: () => {
      const target = box<{ count?: number }[]>([{}]);
      for (const item of target) {
        (item as { count: number }).count += 1;
      }
      return target;
    },
  },
  {
    body: 'const target = { all: 0 }; target.all += 1; return target;',
    changed: false,
    id: 'pin-finite-plus-equals',
    run: () => {
      const target = box({ all: 0 });
      target.all += 1;
      return target;
    },
  },
  {
    body: 'const target = { all: 0, done: 2 }; target.all += 1; target.done *= 2; return target;',
    changed: false,
    id: 'pin-finite-sibling-compound-writes',
    run: () => {
      const target = box({ all: 0, done: 2 });
      target.all += 1;
      target.done *= 2;
      return target;
    },
  },
  {
    body: 'const target = [10, 20]; target[0] -= 2; return target;',
    changed: false,
    id: 'pin-finite-array-element-minus-equals',
    run: () => {
      const target = box([INITIAL_TEN, INITIAL_TWENTY]);
      target[0] = (target[0] ?? 0) - 2;
      return target;
    },
  },
  {
    body: 'const target = { count: 0 }; target.count++; return target;',
    changed: false,
    id: 'pin-finite-postfix-increment',
    run: () => {
      const target = box({ count: 0 });
      target.count += 1;
      return target;
    },
  },
  {
    body: "const target = { label: 'item-' }; target.label += suffix; return target;",
    changed: false,
    id: 'pin-string-concatenation-plus-equals',
    run: () => {
      const target = box({ label: 'item-' });
      target.label += 'ok';
      return target;
    },
  },
  {
    body: 'const target = { mask: 1 }; target.mask |= 2; return target;',
    changed: false,
    id: 'pin-bitwise-or-equals-int32',
    run: () => box({ mask: BITWISE_MASK_RESULT }),
  },
  {
    body: 'const target: { a?: number } = {}; target.a ??= 1; return target;',
    changed: false,
    id: 'pin-nullish-assign-preserves-json',
    run: () => {
      const target = box<{ a?: number }>({});
      target.a ??= 1;
      return target;
    },
  },
  {
    body: 'const target = { n: 1 }; target.n /= 0; return target;',
    changed: true,
    id: 'pin-divide-by-literal-zero-refused',
    run: () => {
      const target = box({ n: 1 });
      target.n /= 0;
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

/** Finds `const target = …` in `build`. */
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

describe('local compound arithmetic and update writes onto constants', () => {
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
      'arithmetic-writes.ts',
      `export function build(factor: number, suffix: string) { ${body} }\n`,
    );

    expect(isJson(run())).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
