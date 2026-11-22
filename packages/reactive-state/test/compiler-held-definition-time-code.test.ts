import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  type Identifier,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { methodsOf, writesThis } from '../src/compiler/held-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { methodOf, writtenBy } from '../src/compiler/written.ts';

/**
 * A nested class or function has a `this` of its own for its bodies, but its `extends` expression
 * and its computed member names run where it is defined, with the `this` of the method that
 * defines it: `class extends this.base() {}` calls `base` as the method does.
 */
const CASES = [
  {
    id: 'class-expression-heritage-calls-writer',
    source:
      'const counter = { n: 0, base() { this.n++; return class {}; }, make() { return class extends this.base() {}; } }; export function run() { counter.make(); }',
    writes: true,
  },
  {
    id: 'class-declaration-heritage-calls-writer',
    source:
      'const counter = { n: 0, base() { this.n++; return class {}; }, make() { class Local extends this.base() {} return Local; } }; export function run() { counter.make(); }',
    writes: true,
  },
  {
    id: 'class-heritage-writes-directly',
    source:
      'const counter = { n: 0, make() { return class extends (this.n++, Object) {}; } }; export function run() { counter.make(); }',
    writes: true,
  },
  {
    id: 'class-computed-method-name-calls-writer',
    source:
      "const counter = { n: 0, next() { this.n++; return 'x'; }, make() { return class { [this.next()]() {} }; } }; export function run() { counter.make(); }",
    writes: true,
  },
  {
    id: 'class-computed-field-name-calls-writer',
    source:
      "const counter = { n: 0, next() { this.n++; return 'x'; }, make() { return class { [this.next()] = 1; }; } }; export function run() { counter.make(); }",
    writes: true,
  },
  {
    id: 'object-method-computed-name-calls-writer',
    source:
      "const counter = { n: 0, next() { this.n++; return 'x'; }, make() { return { [this.next()]() {} }; } }; export function run() { counter.make(); }",
    writes: true,
  },
  {
    id: 'computed-name-inside-a-nested-method-is-that-methods-this-pin',
    source:
      "const counter = { n: 0, next() { this.n++; return 'x'; }, make() { const inner = { build() { return class { [this.next()]() {} }; } }; return inner; } }; export function run() { counter.make(); }",
    writes: false,
  },
  {
    id: 'class-body-method-this-is-its-own-pin',
    source:
      'const counter = { n: 0, make() { return class { bump() { this.n++; } }; } }; export function run() { counter.make(); }',
    writes: false,
  },
  {
    id: 'class-heritage-reading-a-member-stays-false-pin',
    source:
      'const counter = { n: 0, Base: class {}, make() { return class extends this.Base {}; } }; export function run() { counter.make(); }',
    writes: false,
  },
  {
    id: 'class-static-initializer-this-is-the-class-pin',
    source:
      'const counter = { n: 0, make() { return class { static count = 0; static next = this.count++; }; } }; export function run() { counter.make(); }',
    writes: false,
  },
  {
    id: 'nested-function-this-is-its-own-pin',
    source:
      'const counter = { n: 0, make() { return function () { this.n++; }; } }; export function run() { counter.make(); }',
    writes: false,
  },
  {
    id: 'class-heritage-of-a-pure-sibling-stays-false-pin',
    source:
      'const counter = { n: 0, base() { return class {}; }, make() { return class extends this.base() {}; } }; export function run() { counter.make(); }',
    writes: false,
  },
] as const;

/** The method call inside `run` in `root`. */
function runCall(root: Node): CallExpression {
  const statements: Node[] = [];
  root.forEachChild((node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'run' && node.body !== undefined) {
      statements.push(...node.body.statements);
    }
  });
  for (const statement of statements) {
    let found: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined) {
        return;
      }
      if (isCallExpression(node) && methodOf(node) !== undefined) {
        found = node;
        return;
      }
      node.forEachChild(visit);
    };
    visit(statement);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error('Expected a method call in run().');
}

function receiverCallTarget(call: CallExpression): {
  readonly method: string;
  readonly receiver: Identifier;
} {
  const method = methodOf(call);
  const callee = unwrapped(call.expression);
  const receiver =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? unwrapped(callee.expression)
      : undefined;
  if (method === undefined || receiver === undefined || !isIdentifier(receiver)) {
    throw new Error('Expected a receiver identifier call.');
  }
  return { method, receiver };
}

describe('held methods whose nested classes and functions run code of this at their definition', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-definition-time-code.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
