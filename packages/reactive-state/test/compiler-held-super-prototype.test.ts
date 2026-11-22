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
 * `super.name` looks the name up on the prototype of the base class, past its bases: an own member
 * of an instance, a field of the base class or a function its constructor installs, shadows
 * nothing there.
 */
const CASES = [
  {
    id: 'super-call-ignores-a-constructor-install-of-the-base',
    source:
      'class Base { n = 0; bump() { this.n++; } constructor() { this.bump = () => 0; } } class Child extends Base { run() { super.bump(); } } const counter = new Child(); export function run() { counter.run(); }',
    writes: true,
  },
  {
    id: 'super-call-ignores-a-base-instance-field',
    source:
      'class Root { n = 0; step() { this.n++; } } class Base extends Root { step = () => 0; } class Child extends Base { go() { super.step(); } } const counter = new Child(); export function run() { counter.go(); }',
    writes: true,
  },
  {
    id: 'super-call-of-an-overriding-method-stays-the-override-pin',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Mid extends Base { bump() { return 0; } } class Child extends Mid { go() { super.bump(); } } const counter = new Child(); export function run() { counter.go(); }',
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

describe('held methods that call a method of the base class prototype through super', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-super-prototype.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
