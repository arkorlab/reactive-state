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
 * A constructor that assigns a function or an arrow to a member of `this` installs a method of the
 * instance, as a field initializer does, beside the prototype method of the same name, which stays a
 * candidate; a value that is no function written there leaves the prototype method as it was.
 */
const CASES = [
  {
    id: 'constructor-installs-an-arrow-that-writes',
    source:
      'class Counter { n = 0; bump: () => void; constructor() { this.bump = () => { this.n++; }; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-installs-a-function-expression-that-writes',
    source:
      'class Counter { n = 0; bump: () => void; constructor() { this.bump = function (this: Counter) { this.n++; }; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-installs-by-a-bracket-key',
    source:
      "class Counter { n = 0; bump: () => void; constructor() { this['bump'] = () => { this.n++; }; } } const counter = new Counter(); export function run() { counter.bump(); }",
    writes: true,
  },
  {
    id: 'constructor-installs-in-a-branch',
    source:
      'class Counter { n = 0; bump: () => void; constructor(flag: boolean) { this.bump = () => 0; if (flag) { this.bump = () => { this.n++; }; } } } const counter = new Counter(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'subclass-constructor-installs-after-super',
    source:
      'class Base { n = 0; } class Child extends Base { bump: () => void; constructor() { super(); this.bump = () => { this.n++; }; } } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'base-constructor-installs-for-a-subclass',
    source:
      'class Base { n = 0; bump: () => void; constructor() { this.bump = () => { this.n++; }; } } class Child extends Base {} const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-installed-arrow-calls-a-writing-method',
    source:
      'class Counter { n = 0; bump: () => void; step() { this.n++; } constructor() { this.bump = () => { this.step(); }; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-arrow-over-a-writing-prototype-method-keeps-it',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor() { this.bump = () => 0; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-bound-copy-keeps-the-writing-prototype-method',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor() { this.bump = this.bump.bind(this); } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-installed-arrow-that-reads-stays-false-pin',
    source:
      'class Counter { n = 0; read: () => number; constructor() { this.read = () => this.n; } } const counter = new Counter(); export function run() { counter.read(); }',
    writes: false,
  },
  {
    id: 'assignment-in-a-function-the-constructor-defines-is-not-the-constructors-pin',
    source:
      'class Counter { n = 0; bump: () => void; constructor() { const later = () => { this.bump = () => { this.n++; }; }; void later; } } const counter = new Counter(); export function run() { counter.bump(); }',
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

describe('held instances whose constructor installs callables', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-constructor-callables.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
