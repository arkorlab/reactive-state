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
 * Own members of an instance are made in the order the classes run: each class's fields, then its
 * constructor, base first; an assignment on a path that may not run keeps what the name held.
 */
const CASES = [
  {
    id: 'derived-field-after-the-base-constructor-install',
    source:
      'class Base { n = 0; bump: () => void; constructor() { this.bump = () => 0; } } class Child extends Base { bump = () => { this.n++; }; } const counter = new Child(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'constructor-install-after-the-derived-field',
    source:
      'class Counter { n = 0; bump = () => 0; constructor() { this.bump = () => { this.n++; }; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'conditional-install-over-a-writing-method',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor(flag: boolean) { if (flag) { this.bump = () => 0; } } } const counter = new Counter(false); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'conditional-installs-in-both-branches',
    source:
      'class Counter { n = 0; bump: () => void; constructor(flag: boolean) { if (flag) { this.bump = () => { this.n++; }; } else { this.bump = () => 0; } } } const counter = new Counter(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'later-conditional-install-after-an-earlier-writer',
    source:
      'class Counter { n = 0; bump: () => void; constructor(flag: boolean) { this.bump = () => { this.n++; }; if (flag) { this.bump = () => 0; } } } const counter = new Counter(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'install-in-a-logical-operand-is-conditional',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor(flag: boolean) { flag && (this.bump = () => 0); } } const counter = new Counter(false); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'install-in-a-loop-is-conditional',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor(rows: number[]) { for (const row of rows) { this.bump = () => row; } } } const counter = new Counter([]); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'straight-line-install-replaces-an-earlier-one-pin',
    source:
      'class Counter { n = 0; bump: () => void; constructor() { this.bump = () => { this.n++; }; this.bump = () => 0; } } const counter = new Counter(); export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'unconditional-install-replaces-a-writing-method-pin',
    source:
      'class Counter { n = 0; bump() { this.n++; } constructor() { this.bump = () => 0; } } const counter = new Counter(); export function run() { counter.bump(); }',
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

describe('held instances whose constructors install callables in the order and on the paths they run', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-constructor-order.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
