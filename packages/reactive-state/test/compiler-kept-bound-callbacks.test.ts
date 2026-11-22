import {
  type Identifier,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isKept } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

/** Prebound global and method write calls retain callbacks supplied earlier to `.bind(...)`. */
const CASES = [
  {
    id: 'prebound-reflect-set-explicit-receiver',
    returned: 'store',
    statement:
      "const write = Reflect.set.bind(Reflect, {}, 'next', () => ++count, store); write();",
    kept: true,
  },
  {
    id: 'prebound-reflect-set-three-arg-target',
    returned: 'store',
    statement: "const write = Reflect.set.bind(Reflect, store, 'next', () => ++count); write();",
    kept: true,
  },
  {
    id: 'partially-bound-reflect-set-callback-then-receiver',
    returned: 'store',
    statement: "const write = Reflect.set.bind(Reflect, {}, 'next', () => ++count); write(store);",
    kept: true,
  },
  {
    id: 'chained-bind-reflect-set-callback',
    returned: 'store',
    statement:
      "const base = Reflect.set.bind(Reflect, {}, 'next'); const write = base.bind(null, () => ++count, store); write();",
    kept: true,
  },
  {
    id: 'inline-bound-reflect-set-iife',
    returned: 'store',
    statement: "Reflect.set.bind(Reflect, {}, 'next', () => ++count, store)();",
    kept: true,
  },
  {
    id: 'prebound-object-assign-callback',
    returned: 'store',
    statement: 'const write = Object.assign.bind(Object, store, { next: () => ++count }); write();',
    kept: true,
  },
  {
    id: 'prebound-object-define-property-getter',
    returned: 'store',
    statement:
      "const write = Object.defineProperty.bind(Object, store, 'next', { get: () => ++count }); write();",
    kept: true,
  },
  {
    id: 'prebound-array-push-method-callback',
    returned: 'handlers',
    statement: 'const push = handlers.push.bind(handlers, () => ++count); push();',
    kept: true,
  },
  {
    id: 'prebound-prototype-push-method-callback',
    returned: 'handlers',
    statement: 'const push = Array.prototype.push.bind(handlers, () => ++count); push();',
    kept: true,
  },
  {
    id: 'chained-bind-array-push-method-callback',
    returned: 'handlers',
    statement:
      'const base = handlers.push.bind(handlers); const push = base.bind(null, () => ++count); push();',
    kept: true,
  },
  {
    id: 'bound-reflect-set-callsite-callback-pin',
    returned: 'store',
    statement: "const write = Reflect.set.bind(Reflect); write({}, 'next', () => ++count, store);",
    kept: true,
  },
  {
    id: 'uninvoked-bound-reflect-set-not-kept-pin',
    returned: 'store',
    statement:
      "const unused = Reflect.set.bind(Reflect, {}, 'next', () => ++count, store); void unused;",
    kept: false,
  },
  {
    id: 'prebound-reflect-set-unreturned-local-target-pin',
    returned: 'store',
    statement:
      "const localOnly: Record<string, () => number> = {}; const write = Reflect.set.bind(Reflect, {}, 'next', () => ++count, localOnly); write();",
    kept: false,
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

describe('kept state of callbacks supplied to bound global and method write calls', () => {
  it.each(CASES)('$id', ({ returned, statement, kept }) => {
    const source = [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> = {};',
      '  const handlers: Array<() => number> = [];',
      `  ${statement}`,
      `  return ${returned};`,
      '}',
      'export const active = makeStore();',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'kept-bound-callbacks.ts', source);
    const counter = incrementedCounter(parsed.sourceFile);

    expect(counter === undefined ? undefined : isKept(counter, writtenBy)).toBe(kept);
  });
});
