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

/** Native invocations expand known tuple spreads and reject unresolved spreads covering callbacks. */
const CASES = [
  {
    id: 'array-from-tuple-spread-arrow-write',
    expression: 'Array.from(...([[1], () => { selected.value = 0; }] as const))',
    changed: true,
  },
  {
    id: 'array-from-plain-array-spread-write',
    expression: 'Array.from(...([[1], () => { selected.value = 0; }] as [[number], () => void]))',
    changed: true,
  },
  {
    id: 'array-from-const-tuple-alias-write',
    expression: 'Array.from(...mutatingTuple)',
    changed: true,
  },
  {
    id: 'array-from-nested-tuple-spread-write',
    expression: 'Array.from(...([...[[1], () => { selected.value = 0; }]] as const))',
    changed: true,
  },
  {
    id: 'array-from-elided-first-spread-write',
    expression: 'Array.from(...([, () => { selected.value = 0; }] as unknown as [[number]]))',
    changed: true,
  },
  {
    id: 'typed-array-from-tuple-spread-write',
    expression: 'Uint8Array.from(...([[1], () => { selected.value = 0; return 0; }] as const))',
    changed: true,
  },
  {
    id: 'object-groupby-tuple-spread-write',
    expression: "Object.groupBy(...([[1], () => { selected.value = 0; return 'k'; }] as const))",
    changed: true,
  },
  {
    id: 'json-stringify-tuple-spread-replacer-write',
    expression: 'JSON.stringify(...([{ a: 1 }, () => { selected.value = 0; return 1; }] as const))',
    changed: true,
  },
  {
    id: 'json-parse-tuple-spread-reviver-write',
    expression: "JSON.parse(...(['1', () => { selected.value = 0; return 1; }] as const))",
    changed: true,
  },
  {
    id: 'array-from-unresolved-spread-rejected',
    expression: 'runUnresolvedFrom([1])',
    changed: true,
  },
  {
    id: 'mutated-const-tuple-spread-rejected',
    expression: 'runMutatedTuple()',
    changed: true,
  },
  {
    id: 'array-from-second-slot-pure-spread',
    expression: 'Array.from([1], ...([(value: number) => value + 1] as const))',
    changed: false,
  },
  {
    id: 'promise-pure-tuple-spread-executor',
    expression: 'new Promise<void>(...([() => { void selected.value; }] as const))',
    changed: false,
  },
  {
    id: 'readable-stream-empty-tuple-spread',
    expression: 'new ReadableStream(...([] as const))',
    changed: false,
  },
  {
    id: 'array-from-pure-tuple-spread-pin',
    expression: 'Array.from(...([[1], (value: number) => value + 1] as const))',
    changed: false,
  },
  {
    id: 'array-from-pure-const-tuple-alias-pin',
    expression: 'Array.from(...pureTuple)',
    changed: false,
  },
  {
    id: 'array-from-omitted-mapper-tuple-spread-pin',
    expression: 'Array.from(...([[1]] as const))',
    changed: false,
  },
  {
    id: 'array-from-elided-mapper-tuple-spread-pin',
    expression: 'Array.from(...([[1], ,] as unknown as [[number]]))',
    changed: false,
  },
  {
    id: 'array-from-trailing-spread-after-pure-mapper-pin',
    expression: 'runTrailingSpread()',
    changed: false,
  },
  {
    id: 'promise-tuple-spread-executor-write-pin',
    expression: 'new Promise<void>(...([() => { selected.value = 0; }] as const))',
    changed: true,
  },
  {
    id: 'array-from-unresolved-second-spread-pin',
    expression: 'runUnresolvedMapper()',
    changed: true,
  },
  {
    id: 'readable-stream-unresolved-spread-pin',
    expression: 'runUnresolvedStream()',
    changed: true,
  },
  {
    id: 'math-max-unresolved-spread-pin',
    expression: 'runMathSpread([1, 2])',
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

describe('argument effects of spread native callback invocations', () => {
  it.each(CASES)('$id', ({ expression, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'const mutatingTuple = [[1], () => { selected.value = 0; }] as const;',
      'const pureTuple = [[1], (value: number) => value + 1] as const;',
      'function runUnresolvedFrom(...args: [number[]]) { return Array.from(...args); }',
      'function runUnresolvedMapper(...rest: [((value: number) => number)?]) { return Array.from([1], ...rest); }',
      'function runUnresolvedStream(...args: [UnderlyingSource?]) { return new ReadableStream(...args); }',
      'function runTrailingSpread(...extra: [undefined?]) { return Array.from([1], (value: number) => value + 1, ...extra); }',
      'function runMathSpread(values: number[]) { return Math.max(...values); }',
      'function runMutatedTuple() { const tuple: unknown[] = [[1]]; tuple.push(() => { selected.value = 0; }); return Array.from(...(tuple as [[number]])); }',
      'function take(_value: unknown): void {}',
      `take(${expression});`,
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-native-spreads.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
