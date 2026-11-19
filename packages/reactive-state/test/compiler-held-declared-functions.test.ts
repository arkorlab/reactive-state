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
 * A property of an object literal that names a function the module declares, `{ bump }` or `{ bump:
 * bump }`, holds that function as its method: it runs with the object as its `this`. An arrow keeps
 * the `this` it was written with, and a name the module does not declare names nothing.
 */
const CASES = [
  {
    id: 'shorthand-names-a-declared-function-that-writes',
    source:
      'function bump(this: { n: number }) { this.n++; } const counter = { n: 0, bump }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'property-value-names-a-declared-function-that-writes',
    source:
      'function increase(this: { n: number }) { this.n++; } const counter = { n: 0, bump: increase }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'property-value-names-a-constant-function-expression',
    source:
      'const increase = function (this: { n: number }) { this.n++; }; const counter = { n: 0, bump: increase }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'property-value-names-a-constant-alias-of-a-declared-function',
    source:
      'function increase(this: { n: number }) { this.n++; } const alias = increase; const counter = { n: 0, bump: alias }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'declared-function-calls-a-writing-method',
    source:
      'function bump(this: { step(): void }) { this.step(); } const counter = { n: 0, step() { this.n++; }, bump }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'declared-function-replaces-a-spread-writer-with-a-pure-one-pin',
    source:
      'function bump() { return 0; } const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'declared-function-that-reads-stays-false-pin',
    source:
      'function read(this: { n: number }) { return this.n; } const counter = { n: 0, read }; export function run() { counter.read(); }',
    writes: false,
  },
  {
    id: 'arrow-keeps-its-own-this-stays-false-pin',
    source:
      'const fast = () => 0; const counter = { n: 0, bump: fast }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'name-the-module-does-not-declare-stays-false-pin',
    source:
      'function make(bump: () => void) { return { n: 0, bump }; } const counter = make(() => 0); export function run() { counter.bump(); }',
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

describe('held objects whose properties name functions declared elsewhere', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-declared-functions.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
