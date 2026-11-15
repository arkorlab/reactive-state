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

/** Changed or mutable spread and `apply` arrays preserve their holder across write targets and `isKept`. */
const KEPT_MUTATED_SPREAD_CASES = [
  {
    id: 'slot-mutated-const-spread-object-assign',
    statement:
      'const args: object[] = [{}]; args[0] = store; Object.assign(...args, { next: () => ++count });',
    kept: true,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'pushed-empty-const-spread-object-assign',
    statement:
      'const args: object[] = []; args.push(store); Object.assign(...args, { next: () => ++count });',
    kept: true,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'slot-mutated-const-spread-reflect-set-target',
    statement:
      "const args: unknown[] = [{}, 'next', () => ++count]; args[0] = store; Reflect.set(...args);",
    kept: true,
    primaryRoot: 'args',
    argumentRoots: ['args'],
  },
  {
    id: 'slot-mutated-const-spread-reflect-set-receiver',
    statement:
      "const args: unknown[] = [{}, 'next', () => ++count, {}]; args[3] = store; Reflect.set(...args);",
    kept: true,
    primaryRoot: 'args',
    argumentRoots: ['args'],
  },
  {
    id: 'reassigned-let-tuple-spread-object-assign',
    statement:
      'let args: [object, object] = [{}, {}]; args = [store, { next: () => ++count }]; Object.assign(...args);',
    kept: true,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'nested-mutated-inner-spread-object-assign',
    statement:
      'const inner: object[] = [{}]; inner[0] = store; const args = [...inner] as const; Object.assign(...args, { next: () => ++count });',
    kept: true,
    primaryRoot: 'inner',
    argumentRoots: [],
  },
  {
    id: 'aliased-const-mutated-through-alias-spread',
    statement:
      'const args: object[] = [{}]; const alias = args; alias[0] = store; Object.assign(...args, { next: () => ++count });',
    kept: true,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'slot-mutated-const-apply-object-assign',
    statement:
      'const args: unknown[] = [{}, { next: () => ++count }]; args[0] = store; Object.assign.apply(Object, args);',
    kept: true,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'reassigned-let-undefined-apply-reflect-set',
    statement:
      "let args: unknown[] | undefined = undefined; args = [store, 'next', () => ++count]; Reflect.set.apply(Reflect, args);",
    kept: true,
    primaryRoot: 'args',
    argumentRoots: ['args'],
  },
  {
    id: 'unreturned-local-mutated-spread-not-kept',
    statement:
      'const localTarget: Record<string, () => number> = {}; const args: object[] = [{}]; args[0] = localTarget; Object.assign(...args, { next: () => ++count });',
    kept: false,
    primaryRoot: 'args',
    argumentRoots: [],
  },
  {
    id: 'unchanged-const-tuple-spread-object-assign-pin',
    statement: 'const args = [store, { next: () => ++count }] as const; Object.assign(...args);',
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'unchanged-nested-const-tuple-spread-reflect-set-pin',
    statement:
      "const head = [store, 'next'] as const; const args = [...head, () => ++count] as const; Reflect.set(...args);",
    kept: true,
    primaryRoot: 'store',
    argumentRoots: [],
  },
  {
    id: 'inline-tuple-spread-reflect-set-receiver-pin',
    statement: "Reflect.set(...([{}, 'next', () => ++count, store] as const));",
    kept: true,
    primaryRoot: undefined,
    argumentRoots: ['store'],
  },
  {
    id: 'const-undefined-apply-reflect-set-pin',
    statement: 'const empty = undefined; void (() => ++count); Reflect.set.apply(Reflect, empty);',
    kept: false,
    primaryRoot: undefined,
    argumentRoots: [],
  },
];

const CALL_WRITE_TARGET_CASES = [
  {
    id: 'mutated-const-spread-dispatch-event',
    statement:
      "const args = [new Event('init')]; args[0] = sharedEvent; emitter.dispatchEvent(...args);",
    primaryRoot: 'emitter',
    argumentRoots: ['args'],
  },
  {
    id: 'mutated-const-spread-trailing-reflect-set-receiver',
    statement: 'const args: unknown[] = [{}]; args[0] = {}; Reflect.set(...args, sharedTarget);',
    primaryRoot: 'args',
    argumentRoots: ['args', 'sharedTarget'],
  },
  {
    id: 'unchanged-const-spread-dispatch-event-pin',
    statement: 'const args = [sharedEvent] as const; emitter.dispatchEvent(...args);',
    primaryRoot: 'emitter',
    argumentRoots: ['sharedEvent'],
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
    (statement): statement is Node & { readonly name?: Identifier } =>
      isFunctionDeclaration(statement) && statement.name?.text === fnName,
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

describe('mutated and mutable array spreads across call write targets and kept callbacks', () => {
  it.each(KEPT_MUTATED_SPREAD_CASES)('$id', ({ statement, kept, primaryRoot, argumentRoots }) => {
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
    using parsed = parseModule(api, 'written-mutated-spread-kept.ts', source);
    const counter = incrementedCounter(parsed.sourceFile);
    const call = lastCallIn(parsed.sourceFile, 'makeStore');
    const primary = call === undefined ? undefined : writtenBy(call);

    expect(counter === undefined ? undefined : isKept(counter, writtenBy)).toBe(kept);
    expect(primary === undefined ? undefined : rootOf(primary)?.text).toBe(primaryRoot);
    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
  });

  it.each(CALL_WRITE_TARGET_CASES)('$id', ({ statement, primaryRoot, argumentRoots }) => {
    const source = [
      "const sharedEvent = new Event('ping');",
      'const sharedTarget: Record<string, unknown> = {};',
      'const emitter = new EventTarget();',
      'function run() {',
      `  ${statement}`,
      '}',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'written-mutated-spread-targets.ts', source);
    const call = lastCallIn(parsed.sourceFile, 'run');
    const primary = call === undefined ? undefined : writtenBy(call);

    expect(primary === undefined ? undefined : rootOf(primary)?.text).toBe(primaryRoot);
    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
  });
});
