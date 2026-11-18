import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { isKept, rootOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenArgumentBy, writtenBy } from '../src/compiler/written.ts';

/** Explicit 4th-argument receivers of `Reflect.set` install callbacks and mutate receiver targets. */
const KEPT_CASES = [
  {
    id: 'explicit-receiver-factory-store',
    statement: "Reflect.set({}, 'next', () => ++count, store);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'spread-receiver-factory-store',
    statement: "Reflect.set({}, 'next', () => ++count, ...[store]);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'tuple-spread-factory-store',
    statement: "const args = [{}, 'next', () => ++count, store] as const; Reflect.set(...args);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'borrowed-call-explicit-receiver',
    statement: "Reflect.set.call(Reflect, {}, 'next', () => ++count, store);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'reflect-apply-explicit-receiver',
    statement: "Reflect.apply(Reflect.set, Reflect, [{}, 'next', () => ++count, store]);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'bound-reflect-set-explicit-receiver',
    statement:
      "const writeSlot = Reflect.set.bind(Reflect); writeSlot({}, 'next', () => ++count, store);",
    kept: true,
    argumentRoots: ['store'],
  },
  {
    id: 'borrowed-three-arg-reflect-set',
    statement: "Reflect.set.call(Reflect, store, 'next', () => ++count);",
    kept: true,
    argumentRoots: [],
  },
  {
    id: 'three-arg-reflect-set-pin',
    statement: "Reflect.set(store, 'next', () => ++count);",
    kept: true,
    argumentRoots: [],
  },
  {
    id: 'undefined-receiver-not-kept-pin',
    statement: "Reflect.set({}, 'next', () => ++count, undefined);",
    kept: false,
    argumentRoots: [],
  },
];

const ARGUMENT_CASES = [
  {
    id: 'argument-write-explicit-receiver',
    body: "const dummy: number[] = []; Reflect.set(dummy, '0', 0, sharedItems);",
    changed: true,
  },
  {
    id: 'argument-local-array-customized-via-explicit-receiver',
    body: "const values: number[] = []; Reflect.set({}, 'push', () => { selected.value = 0; return 0; }, values); values.push(1);",
    changed: true,
  },
  {
    id: 'argument-structured-clone-transfer-write',
    body: 'structuredClone({ ok: true }, { transfer: [sharedBuffer] });',
    changed: true,
  },
  {
    id: 'argument-local-array-three-arg-pin',
    body: 'const values: number[] = []; values.push(1); return values.length;',
    changed: false,
  },
];

/** The `count` identifier incremented by `++count` in `file`. */
function incrementedCounter(file: SourceFile): Identifier | undefined {
  let found: Identifier | undefined;
  const visit = (node: Node): void => {
    if (
      found === undefined &&
      isPrefixUnaryExpression(node) &&
      node.operator === SyntaxKind.PlusPlusToken &&
      isIdentifier(node.operand)
    ) {
      found = node.operand;
      return;
    }
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(file);
  return found;
}

/** The last call expression inside `makeStore` (the `Reflect.set` / `writeSlot` invocation). */
function testedFactoryCall(file: SourceFile): CallExpression | undefined {
  const fn = file.statements.find((statement) => isFunctionDeclaration(statement));
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  if (fn !== undefined) {
    visit(fn);
  }
  return calls.at(-1);
}

/** Constant and declaration resolution matching the caller's static callee lookup. */
function calleeOf(node: Expression): Node | undefined {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = declarationOf(value);
    if (
      declared !== undefined &&
      (isFunctionDeclaration(declared) || isClassDeclaration(declared))
    ) {
      return declared;
    }
    const initial = initializerOf(value);
    if (initial === undefined) {
      return value;
    }
    value = unwrapped(initial);
  }
  return value;
}

/** The argument passed to the trailing `take(...)` call in `file`. */
function testedArgument(file: SourceFile): Expression | undefined {
  const last = file.statements.at(-1);
  const call = last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
  return call !== undefined && isCallExpression(call) ? call.arguments[0] : undefined;
}

describe('explicit and borrowed Reflect.set receivers in kept-binding tracking', () => {
  it.each(KEPT_CASES)('$id', ({ statement, kept, argumentRoots }) => {
    const source = [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> = {};',
      `  ${statement}`,
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflect-set-kept.ts', source);
    const counter = incrementedCounter(parsed.sourceFile);
    const call = testedFactoryCall(parsed.sourceFile);
    const roots =
      call === undefined
        ? []
        : writtenArgumentBy(call).flatMap((target) => {
            const root = rootOf(target);
            return root === undefined ? [] : [root.text];
          });

    expect(counter === undefined ? undefined : isKept(counter, writtenBy)).toBe(kept);
    expect(roots).toStrictEqual(argumentRoots);
  });
});

describe('argument effects of Reflect.set explicit receivers and written arguments', () => {
  it.each(ARGUMENT_CASES)('$id', ({ body, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'const sharedItems = [1];',
      'const sharedBuffer = new ArrayBuffer(8);',
      `function helper() { ${body} }`,
      'function take(_value: unknown): void {}',
      'take(helper());',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflect-set-arguments.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
