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
 * A method of a source-written subclass that calls `super.bump()` runs the base class's `bump` with
 * the same receiver, so the base method's writes through `this` are the call's, including those
 * of an override of its own; an override that does not call `super` replaces the base method.
 */
const CASES = [
  {
    id: 'super-call-of-a-writing-base-method',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Child extends Base { bump() { super.bump(); } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'super-call-by-bracket-key',
    source:
      "class Base { n = 0; bump() { this.n++; } } class Child extends Base { bump() { super['bump'](); } } const counter = new Child(); export function run() { counter.bump(); }",
    writes: true,
  },
  {
    id: 'super-call-through-two-levels',
    source:
      'class Root { n = 0; bump() { this.n++; } } class Base extends Root { bump() { super.bump(); } } class Child extends Base { bump() { super.bump(); } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'super-call-of-a-base-method-that-calls-another-method',
    source:
      'class Base { n = 0; step() { this.n++; } bump() { this.step(); } } class Child extends Base { bump() { super.bump(); } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'super-call-inside-an-arrow-of-the-method',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Child extends Base { bump() { [1].forEach(() => super.bump()); } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'super-call-of-a-sibling-method',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Child extends Base { reset() { super.bump(); } } const counter = new Child(); export function run() { counter.reset(); }',
    writes: true,
  },
  {
    id: 'static-super-call-of-a-writing-base-method',
    source:
      'class Base { static n = 0; static bump() { this.n++; } } class Child extends Base { static bump() { super.bump(); } } export function run() { Child.bump(); }',
    writes: true,
  },
  {
    id: 'super-call-of-a-pure-base-method-stays-false-pin',
    source:
      'class Base { n = 0; bump() { return this.n; } } class Child extends Base { bump() { return super.bump() + 1; } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'override-without-super-stays-false-pin',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Child extends Base { bump() { return 0; } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'super-call-of-a-method-the-base-lacks-stays-false-pin',
    source:
      'class Base { n = 0; } class Child extends Base { bump() { (super.read as () => void)(); } read() { return 1; } } const counter = new Child(); export function run() { counter.bump(); }',
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

describe('held methods that call a method of their base class through super', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-super-calls.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
