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

/** Local-array exemptions apply only to un-reassigned fresh arrays' own storage, never nested values. */
const CASES = [
  {
    id: 'nested-element-property-assignment',
    body: 'const refs = [selected]; refs[0].value = 0;',
    changed: true,
  },
  {
    id: 'nested-element-property-increment',
    body: 'const refs = [selected]; refs[0].value++;',
    changed: true,
  },
  {
    id: 'nested-element-property-delete',
    body: 'const refs: { value?: number }[] = [selected]; delete refs[0].value;',
    changed: true,
  },
  {
    id: 'nested-array-slot-assignment',
    body: 'const refs = [sharedItems]; refs[0][0] = 0;',
    changed: true,
  },
  {
    id: 'nested-array-length-assignment',
    body: 'const refs = [sharedItems]; refs[0].length = 0;',
    changed: true,
  },
  {
    id: 'nested-array-method-call',
    body: 'const refs = [sharedItems]; refs[0].push(1);',
    changed: true,
  },
  {
    id: 'nested-element-object-assign',
    body: 'const refs = [selected]; Object.assign(refs[0], { value: 0 });',
    changed: true,
  },
  {
    id: 'reassigned-local-array-push',
    body: 'let a: number[] = []; a = sharedItems; a.push(1);',
    changed: true,
  },
  {
    id: 'reassigned-local-array-slot-write',
    body: 'let a: number[] = []; a = sharedItems; a[0] = 1;',
    changed: true,
  },
  {
    id: 'destructured-reassigned-local-array-push',
    body: 'let a: number[] = []; [a] = [sharedItems]; a.push(1);',
    changed: true,
  },
  {
    id: 'loop-reassigned-local-array-push',
    body: 'let a: number[] = []; for (a of [sharedItems]) { a.push(1); }',
    changed: true,
  },
  {
    id: 'redeclared-var-local-array-push',
    body: 'var a: number[] = []; var a = sharedItems; a.push(1);',
    changed: true,
  },
  {
    id: 'defined-setter-local-array-slot-write',
    body: "const a: number[] = []; Object.defineProperty(a, '0', { set() { selected.value = 0; } }); a[0] = 1;",
    changed: true,
  },
  {
    id: 'fresh-local-array-own-storage-pin',
    body: 'const values: number[] = []; values.push(1); values[0] = 2; values.length = 0; return values.length;',
    changed: false,
  },
  {
    id: 'fresh-local-array-slot-replacement-pin',
    body: 'const refs = [selected]; refs[0] = { value: 2 }; return refs.length;',
    changed: false,
  },
  {
    id: 'local-scalar-rebinding-pin',
    body: 'let count = 0; count = 1; count++; return count;',
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

describe('argument effects of local array writes and reassignments', () => {
  it.each(CASES)('$id', ({ body, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'const sharedItems = [1];',
      `function helper() { ${body} }`,
      'function take(_value: unknown): void {}',
      'take(helper());',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-local-arrays.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
