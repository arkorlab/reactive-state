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
 * Calling a generator method as a discarded statement acquires an unresumed iterator without
 * starting its body, whereas a sibling call whose iterator is used or resumed runs the body.
 * `writesThis` distinguishes the discarded call state from the resumed call state in `seen` so an
 * earlier discarded sibling call does not hide a later resumed call's write.
 */
const CASES = [
  {
    id: 'discarded-sibling-before-resumed-next',
    source:
      'const counter = { n: 0, *step() { yield ++this.n; }, run() { this.step(); return this.step().next(); } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'void-sibling-before-spread-resumption',
    source:
      'const counter = { n: 0, *step() { this.n++; yield this.n; }, run() { void this.step(); return [...this.step()]; } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'discarded-in-first-helper-resumed-in-second',
    source:
      'const counter = { n: 0, *step() { this.n++; yield 1; }, warm() { this.step(); }, run() { this.warm(); return this.step().next(); } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'comma-discarded-before-for-of-resumption',
    source:
      'const counter = { n: 0, *step() { yield ++this.n; }, run() { (this.step(), 0); for (const item of this.step()) { return item; } return 0; } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'resumed-directly-pin',
    source:
      'const counter = { n: 0, *step() { yield ++this.n; }, run() { return this.step().next(); } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'discarded-only-generator-body-skipped-pin',
    source:
      'const counter = { n: 0, *step() { yield ++this.n; }, run() { this.step(); return this.n; } }; export function read() { return counter.run(); }',
    writes: false,
  },
  {
    id: 'discarded-generator-default-parameter-writes-pin',
    source:
      'const counter = { n: 0, *step(value = ++this.n) { yield value; }, run() { this.step(); return 0; } }; export function read() { return counter.run(); }',
    writes: true,
  },
  {
    id: 'mutually-recursive-discarded-generators-terminate-pin',
    source:
      'const counter = { *first(): Generator<number> { this.second(); yield 1; }, *second(): Generator<number> { this.first(); yield 2; }, run() { this.first(); return 0; } }; export function read() { return counter.run(); }',
    writes: false,
  },
] as const;

/** The method call inside `read` in `root`. */
function readCall(root: Node): CallExpression {
  const statements: Node[] = [];
  root.forEachChild((node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'read' && node.body !== undefined) {
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
  throw new Error('Expected a method call in read().');
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

describe('held generator methods called across discarded and resumed sibling sites', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-generator-sibling-calls.ts', source);
    const call = readCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
