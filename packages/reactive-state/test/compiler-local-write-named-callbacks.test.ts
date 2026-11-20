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
 * Callbacks and callees passed by identifier, local constant or variable, member property,
 * overload declaration, conditional/logical/sequence expression, `.bind(...)`, or spread array
 * literal must be resolved when checking parameter writes onto local constants.
 */

interface Item {
  value: number;
}

interface Case {
  readonly id: string;
  readonly preamble?: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

function box<T>(value: T): T {
  return value;
}

function poisonedItems(): Item[] {
  const target = box<Item[]>([{ value: 0 }]);
  for (const item of target) {
    item.value = NaN;
  }
  return target;
}

function poisonedBox(): Item {
  const target = box<Item>({ value: 0 });
  target.value = NaN;
  return target;
}

const PREAMBLE = [
  'interface Item { value: number; }',
  'function mutateItem(item: Item): void { item.value = NaN; }',
  'function noopItem(_item: Item): void {}',
  'function readValue(item: Item): number { return item.value + 1; }',
  'function mutateWithPrefix(_prefix: string, item: Item): void { item.value = NaN; }',
  'function mutateFirstOnly(first: Item, _second: Item): void { first.value = NaN; }',
  'function overloadedMutate(item: Item): void;',
  'function overloadedMutate(item: Item, label?: string): void;',
  'function overloadedMutate(item: Item): void { item.value = NaN; }',
  'function cycleFirst(item: Item): void { cycleSecond(item); }',
  'function cycleSecond(item: Item): void { if (item.value > 1) { cycleFirst(item); } item.value = NaN; }',
  'function poisonTag(_strings: TemplateStringsArray, item: Item): string { item.value = NaN; return ""; }',
  'function plainTag(_strings: TemplateStringsArray, _item: Item): string { return ""; }',
].join('\n');

const CASES: readonly Case[] = [
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach(mutateItem); return target;',
    changed: true,
    id: 'top-level-function-callback-in-foreach',
    run: poisonedItems,
  },
  {
    body: 'const localMutate = (item: Item): void => { item.value = NaN; }; const target: Item[] = [{ value: 0 }]; target.forEach(localMutate); return target;',
    changed: true,
    id: 'local-const-arrow-callback-in-foreach',
    run: poisonedItems,
  },
  {
    body: 'const localMutate = function (item: Item): number { item.value = NaN; return 0; }; const target: Item[] = [{ value: 0 }]; target.map(localMutate); return target;',
    changed: true,
    id: 'local-const-function-expression-in-map',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; if (flag) { function innerMutate(item: Item): void { item.value = NaN; } target.forEach(innerMutate); } return target;',
    changed: true,
    id: 'nested-block-function-declaration-callback',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach(overloadedMutate); return target;',
    changed: true,
    id: 'overloaded-function-declaration-callback',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach(flag ? mutateItem : noopItem); return target;',
    changed: true,
    id: 'conditional-callback-branch-mutates',
    run: poisonedItems,
  },
  {
    body: 'const maybe: ((item: Item) => void) | undefined = undefined; const target: Item[] = [{ value: 0 }]; target.some((maybe ?? mutateItem) as (item: Item) => boolean); return target;',
    changed: true,
    id: 'nullish-fallback-callback-mutates',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach((0, mutateItem)); return target;',
    changed: true,
    id: 'comma-sequence-callback-mutates',
    run: poisonedItems,
  },
  {
    body: 'let chosen: (item: Item) => void = noopItem; chosen = mutateItem; const target: Item[] = [{ value: 0 }]; target.forEach(chosen); return target;',
    changed: true,
    id: 'reassigned-let-binding-callback-mutates',
    run: poisonedItems,
  },
  {
    body: 'const helpers = { mutate(item: Item): void { item.value = NaN; } }; const target: Item[] = [{ value: 0 }]; target.forEach(helpers.mutate); return target;',
    changed: true,
    id: 'object-method-member-callback-mutates',
    run: poisonedItems,
  },
  {
    body: "const key = 'mutate'; const helpers = { mutate: (item: Item): void => { item.value = NaN; } }; const target: Item[] = [{ value: 0 }]; target.forEach(helpers[key]); return target;",
    changed: true,
    id: 'computed-object-property-callback-mutates',
    run: poisonedItems,
  },
  {
    body: "const bound = mutateWithPrefix.bind(null, 'p'); const target: Item[] = [{ value: 0 }]; target.forEach(bound); return target;",
    changed: true,
    id: 'bound-callback-shifted-parameter-mutates',
    run: poisonedItems,
  },
  {
    body: 'const callbacks = [mutateItem] as const; const target: Item[] = [{ value: 0 }]; target.forEach(...callbacks); return target;',
    changed: true,
    id: 'spread-tuple-callback-in-foreach-mutates',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; Array.from(target, mutateItem); return target;',
    changed: true,
    id: 'array-from-named-mapper-mutates-source',
    run: poisonedItems,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach(cycleFirst); return target;',
    changed: true,
    id: 'mutually-recursive-named-callbacks-terminate',
    run: poisonedItems,
  },
  {
    body: 'const target: Item = { value: 0 }; (flag ? mutateItem : noopItem)(target); return target;',
    changed: true,
    id: 'direct-conditional-callee-mutates-argument',
    run: poisonedBox,
  },
  {
    body: [
      'const target: Item = { value: 0 }; const chosenTag = flag ? poisonTag : plainTag; void chosenTag`$',
      '{target}`; return target;',
    ].join(''),
    changed: true,
    id: 'conditional-tagged-template-mutates-substitution',
    run: poisonedBox,
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.map(readValue); return target;',
    changed: false,
    id: 'pin-named-read-only-callback',
    run: () => box<Item[]>([{ value: 0 }]),
  },
  {
    body: 'const copyItem = (item: Item): Item => ({ ...item, value: item.value + 1 }); const target: Item[] = [{ value: 0 }]; target.map(copyItem); return target;',
    changed: false,
    id: 'pin-const-copying-callback',
    run: () => box<Item[]>([{ value: 0 }]),
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach(flag ? noopItem : readValue); return target;',
    changed: false,
    id: 'pin-conditional-read-only-callbacks',
    run: () => box<Item[]>([{ value: 0 }]),
  },
  {
    body: 'const target = [1, 2]; target.map(String); return target;',
    changed: false,
    id: 'pin-global-string-mapper',
    run: () => box([1, 2]),
  },
  {
    body: 'const scratch: Item = { value: 0 }; const bound = mutateFirstOnly.bind(null, scratch); const target: Item[] = [{ value: 0 }]; target.forEach(bound); return target;',
    changed: false,
    id: 'pin-bound-callback-mutates-only-prebound-arg',
    run: () => {
      const scratch = box<Item>({ value: 0 });
      const target = box<Item[]>([{ value: 0 }]);
      scratch.value = NaN;
      return target;
    },
  },
  {
    body: 'const scratch: Item = { value: 0 }; const target: Item = { value: 0 }; (flag ? mutateFirstOnly : noopItem)(scratch, target); return target;',
    changed: false,
    id: 'pin-direct-conditional-mutates-other-param',
    run: () => {
      const scratch = box<Item>({ value: 0 });
      const target = box<Item>({ value: 0 });
      scratch.value = NaN;
      return target;
    },
  },
  {
    body: 'const target: Item[] = [{ value: 0 }]; target.forEach((item) => { item.value = NaN; }); return target;',
    changed: true,
    id: 'pin-inline-arrow-mutating-callback',
    run: poisonedItems,
  },
];

/** Minimal non-JSON leaf check matching `json-values.ts` for constant/identifier expressions. */
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
  for (const fn of file.statements) {
    if (!isFunctionDeclaration(fn) || fn.name?.text !== 'build' || fn.body === undefined) {
      continue;
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
  }
  throw new Error('expected target declaration');
}

/** First top-level function declaration in `file` for each name (matching overload resolution). */
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
  if (target.initializer === undefined) {
    throw new Error('expected target initializer');
  }
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

describe('named and indirect callbacks writing into local constants', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, preamble = PREAMBLE, run }) => {
    using parsed = parseModule(
      api,
      'named-callback-writes.ts',
      `${preamble}\nexport function build(flag: boolean) { ${body} }\n`,
    );

    expect(isJson(run())).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
