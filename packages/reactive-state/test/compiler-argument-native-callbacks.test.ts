import {
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Native invocations in an argument can synchronously run callbacks or reflective targets. */
const CASES = [
  {
    id: 'array-from-arrow-write',
    expression: 'Array.from([1], () => { selected.value = 0; })',
    changed: true,
  },
  {
    id: 'array-from-named-callback',
    expression: 'Array.from([1], mutate)',
    changed: true,
  },
  {
    id: 'typed-array-from-write',
    expression: 'Uint8Array.from([1], () => { selected.value = 0; return 0; })',
    changed: true,
  },
  {
    id: 'object-groupby-write',
    expression: "Object.groupBy([1], () => { selected.value = 0; return 'k'; })",
    changed: true,
  },
  {
    id: 'map-groupby-write',
    expression: "Map.groupBy([1], () => { selected.value = 0; return 'k'; })",
    changed: true,
  },
  {
    id: 'json-stringify-replacer-write',
    expression: 'JSON.stringify({ a: 1 }, () => { selected.value = 0; return 1; })',
    changed: true,
  },
  {
    id: 'json-parse-reviver-write',
    expression: "JSON.parse('1', () => { selected.value = 0; return 1; })",
    changed: true,
  },
  {
    id: 'promise-executor-write',
    expression: 'new Promise<void>(() => { selected.value = 0; })',
    changed: true,
  },
  {
    id: 'promise-try-write',
    expression: 'Promise.try(() => { selected.value = 0; })',
    changed: true,
  },
  {
    id: 'reflect-apply-write',
    expression: 'Reflect.apply(mutate, null, [])',
    changed: true,
  },
  {
    id: 'reflect-construct-write',
    expression: 'Reflect.construct(Mutating, [])',
    changed: true,
  },
  {
    id: 'prototype-call-write',
    expression: 'Array.prototype.forEach.call([1], () => { selected.value = 0; })',
    changed: true,
  },
  {
    id: 'readable-stream-start-write',
    expression: 'new ReadableStream({ start() { selected.value = 0; } })',
    changed: true,
  },
  {
    id: 'array-from-changing-builtin',
    expression: 'Array.from([selected], Object.freeze)',
    changed: true,
  },
  {
    id: 'array-from-pure-mapper',
    expression: 'Array.from([1], (value) => value + 1)',
    changed: false,
  },
  {
    id: 'array-from-omitted-mapper',
    expression: 'Array.from([1])',
    changed: false,
  },
  {
    id: 'array-from-undefined-mapper',
    expression: 'Array.from([1], undefined)',
    changed: false,
  },
  {
    id: 'json-stringify-array-replacer',
    expression: "JSON.stringify({ a: 1 }, ['a'])",
    changed: false,
  },
  {
    id: 'promise-pure-executor',
    expression: 'new Promise<void>(() => { void selected.value; })',
    changed: false,
  },
  {
    id: 'number-conversion-pin',
    expression: "Number('0')",
    changed: false,
  },
  {
    id: 'empty-readable-stream-pin',
    expression: 'new ReadableStream()',
    changed: false,
  },
];

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

describe('argument effects of synchronous native callbacks', () => {
  it.each(CASES)('$id', ({ expression, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'const mutate = () => { selected.value = 0; };',
      'class Mutating { constructor() { selected.value = 0; } }',
      'function take(_value: unknown): void {}',
      `take(${expression});`,
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-native-callbacks.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
