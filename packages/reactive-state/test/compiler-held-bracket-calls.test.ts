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
 * A held method that invokes another method of `this` through bracket notation (`this['change']()`,
 * `this[0]()`, or a computed key `this[key]()`) reaches the target method's receiver writes just as
 * `this.change()` does, while pure public targets and uncallable `#private` methods remain safe.
 */
const CASES = [
  {
    id: 'string-literal-bracket-call-writes',
    source:
      "const counter = { n: 0, bump() { this['change'](); }, change() { this.n++; } }; export function run() { counter.bump(); }",
    writes: true,
  },
  {
    id: 'template-literal-bracket-call-writes',
    source:
      'const counter = { n: 0, bump() { this[`change`](); }, change() { this.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-alias-bracket-call-writes',
    source:
      "const counter = { n: 0, bump() { const self = this; self['change'](); }, change() { this.n++; } }; export function run() { counter.bump(); }",
    writes: true,
  },
  {
    id: 'numeric-bracket-call-writes',
    source:
      'const counter = { n: 0, 0() { this.n++; }, bump() { this[0](); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'unknown-computed-bracket-call-with-mutating-method',
    source:
      "const counter = { n: 0, change() { this.n++; }, idle() {}, bump(key: 'change' | 'idle') { this[key](); } }; export function run() { counter.bump('change'); }",
    writes: true,
  },
  {
    id: 'string-literal-bracket-call-pure-pin',
    source:
      "const counter = { n: 1, read() { return this['value'](); }, value() { return this.n; } }; export function run() { return counter.read(); }",
    writes: false,
  },
  {
    id: 'unknown-computed-bracket-call-all-public-pure-pin',
    source:
      "class Counter { n = 0; #secret() { this.n++; } first() { return 1; } second() { return 2; } read(key: 'first' | 'second') { return this[key](); } } const counter = new Counter(); export function run() { return counter.read('first'); }",
    writes: false,
  },
  {
    id: 'dot-call-writes-pin',
    source:
      'const counter = { n: 0, bump() { this.change(); }, change() { this.n++; } }; export function run() { counter.bump(); }',
    writes: true,
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

describe('held method calls through bracket member access on this', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-bracket-calls.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
