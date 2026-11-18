import {
  type CallExpression,
  type Identifier,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isKept, rootOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenArgumentBy, writtenBy } from '../src/compiler/written.ts';

/** Tuple spreads and unknown `apply` lists across `writtenBy`, `writtenArgumentBy` and `isKept`. */
const KEPT_SPREAD_CASES = [
  {
    id: 'three-arg-tuple-spread-reflect-set',
    statement: "const args = [store, 'next', () => ++count] as const; Reflect.set(...args);",
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'nested-three-arg-tuple-spread-reflect-set',
    statement:
      "const head = [store, 'next'] as const; const args = [...head, () => ++count] as const; Reflect.set(...args);",
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'const-tuple-spread-object-assign',
    statement: 'const args = [store, { next: () => ++count }] as const; Object.assign(...args);',
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'inline-tuple-spread-object-assign',
    statement: 'Object.assign(...([store, { next: () => ++count }] as const));',
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'tuple-spread-object-define-property',
    statement:
      "const args = [store, 'next', { value: () => ++count }] as const; Object.defineProperty(...args);",
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'four-arg-tuple-spread-primary-unwrapped',
    statement: "const args = [{}, 'next', () => ++count, store] as const; Reflect.set(...args);",
    kept: true,
    primaryRoot: undefined,
    argumentRoots: ['store'],
  },
  {
    id: 'apply-literal-list-reflect-set-pin',
    statement: "Reflect.set.apply(Reflect, [{}, 'next', () => ++count, store]);",
    kept: true,
    primaryRoot: undefined,
    argumentRoots: ['store'],
  },
  {
    id: 'direct-four-arg-reflect-set-pin',
    statement: "Reflect.set({}, 'next', () => ++count, store);",
    kept: true,
    primaryRoot: undefined,
    argumentRoots: ['store'],
  },
];

const WRITE_TARGET_CASES = [
  {
    id: 'apply-unknown-list-reflect-set-receiver',
    statement: 'Reflect.set.apply(Reflect, unknownArgs);',
    primaryRoot: 'unknownArgs',
    argumentRoots: ['unknownArgs'],
  },
  {
    id: 'reflect-apply-unknown-list-reflect-set-receiver',
    statement: 'Reflect.apply(Reflect.set, Reflect, unknownArgs);',
    primaryRoot: 'unknownArgs',
    argumentRoots: ['unknownArgs'],
  },
  {
    id: 'apply-cast-unknown-list-reflect-set-receiver',
    statement: 'Reflect.set.apply(Reflect, unknownArgs as unknown[]);',
    primaryRoot: 'unknownArgs',
    argumentRoots: ['unknownArgs'],
  },
  {
    id: 'apply-explicit-undefined-list-reflect-set',
    statement: 'Reflect.set.apply(Reflect, undefined);',
    primaryRoot: undefined,
    argumentRoots: [],
  },
  {
    id: 'tuple-spread-structured-clone-transfer',
    statement:
      'const cloneArgs = [{ ok: true }, { transfer: [sharedBuffer] }] as const; structuredClone(...cloneArgs);',
    primaryRoot: undefined,
    argumentRoots: ['sharedBuffer'],
  },
  {
    id: 'tuple-spread-dispatch-event',
    statement:
      'const dispatchArgs = [sharedEvent] as const; emitter.dispatchEvent(...dispatchArgs);',
    primaryRoot: 'emitter',
    argumentRoots: ['sharedEvent'],
  },
  {
    id: 'direct-spread-unknown-list-reflect-set-pin',
    statement: 'Reflect.set(...unknownTuple);',
    primaryRoot: 'unknownTuple',
    argumentRoots: ['unknownTuple'],
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

/** The final call expression inside the named function declaration in `file`. */
function lastCallIn(file: SourceFile, fnName: string): CallExpression | undefined {
  const fn = file.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === fnName,
  );
  if (fn === undefined) {
    return undefined;
  }
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return found;
}

/** Root binding names reported for `nodes`. */
function rootNames(nodes: readonly (Node | undefined)[]): readonly string[] {
  const names: string[] = [];
  for (const node of nodes) {
    const root = node === undefined ? undefined : rootOf(node);
    if (root !== undefined) {
      names.push(root.text);
    }
  }
  return names;
}

describe('unknown apply lists and tuple spreads across call write targets', () => {
  it.each(KEPT_SPREAD_CASES)('$id', ({ statement, kept, primaryRoot, argumentRoots }) => {
    const source = [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> = {};',
      `  ${statement}`,
      '  return store;',
      '}',
      'export const active = makeStore();',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'written-spread-kept.ts', source);
    const counter = incrementedCounter(parsed.sourceFile);
    const call = lastCallIn(parsed.sourceFile, 'makeStore');
    const primary = call === undefined ? undefined : writtenBy(call);

    expect(counter === undefined ? undefined : isKept(counter, writtenBy)).toBe(kept);
    expect(primary === undefined ? undefined : rootOf(primary)?.text).toBe(primaryRoot);
    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
  });

  it.each(WRITE_TARGET_CASES)('$id', ({ statement, primaryRoot, argumentRoots }) => {
    const source = [
      'const sharedBuffer = new ArrayBuffer(8);',
      "const sharedEvent = new Event('ping');",
      'const emitter = new EventTarget();',
      'function run(unknownArgs: unknown[], unknownTuple: [object, PropertyKey, unknown]) {',
      `  ${statement}`,
      '}',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'written-spread-targets.ts', source);
    const call = lastCallIn(parsed.sourceFile, 'run');
    const primary = call === undefined ? undefined : writtenBy(call);

    expect(primary === undefined ? undefined : rootOf(primary)?.text).toBe(primaryRoot);
    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
  });
});
